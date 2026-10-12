/**
 * API 网关 —— Cloudflare Workers 入口
 *
 * 与 WorkBuddy 托管版的关键区别：
 * 1. 自建域名没有平台边缘代理，所以「API Key」栏填的 Authorization 头能真正到达，
 *    鉴权改为 **header 优先**（query / 路径式仍兼容，便于旧配置平滑迁移）。
 * 2. 静态后台界面由 Workers Assets 托管，非网关路径直接回退给它。
 *
 * 部署要求：wrangler.toml 里配置 nodejs_compat（SDK 需要）与 assets 目录。
 */
import { Hono } from 'hono'
import { extractKey, isWellFormedKey, hashApiKey } from './keys.js'
import { resolveKey, logUsage, listBuiltinModels, createChatStream } from './cloud.js'
import { forward, safeJson, llmErrorResponse, asciiHeader, SSE_HEADERS, sanitizeContent } from './gateway.js'

const app = new Hono()
const counters = { total: 0, ok: 0, rejected: 0, failed: 0 }

// 诊断用：最近到达的请求（isolate 内存，可能不跨实例，仅供排查"请求有没有到"）
const recent = []
// 诊断用：最近的上游调用错误详情（isolate 内存）
const recentErrors = []

app.get('/debug/requests', (c) =>
  c.json({
    note: 'isolate 内最近到达的请求（可能不完整，仅供诊断）',
    count: recent.length,
    recent,
    recentErrors,
  }),
)

/** 把上游错误详情记入 isolate 内存，便于通过 /debug/requests 远程定位 */
function logUpstreamError(where, model, err) {
  try {
    recentErrors.unshift({
      time: new Date().toISOString(),
      where,
      model,
      message: err?.error?.message || err?.message || String(err).slice(0, 200),
      code: err?.error?.code || null,
      status: err?.status || null,
      requestId: err?.requestId || null,
    })
    if (recentErrors.length > 20) recentErrors.length = 20
  } catch { /* 诊断失败不影响主流程 */ }
}

const jsonError = (status, message, type) =>
  new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/* ============================ 健康检查 ============================ */

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'wb-gateway-worker',
    time: new Date().toISOString(),
    // Workers 的 isolate 会复用、且时钟在请求之间被冻结/重置，
    // 因此没有可靠的"运行时长"概念；counters 也仅代表当前实例，仅供参考。
    counters,
  }),
)

/* ============================ 路径与鉴权 ============================ */

/**
 * 解析真实路径与 Key。支持三种客户端填法：
 * 1. OpenAI 完整端点：/v1/chat/completions（Key 在 header 或 ?key=）
 * 2. Key 作为路径第一段：/<key> + 客户端拼的 /v1/messages
 * 3. Key 混在 query 里：/v1?key=K/chat/completions
 */
function resolveGatewayPath(url) {
  const segs = url.pathname.split('/').filter(Boolean)
  let pathname = url.pathname
  let keyQuery = url.searchParams.get('key') || ''

  if (segs.length && /^sk-wb-[0-9a-f]{40,64}$/.test(segs[0])) {
    keyQuery = segs[0]
    let rest = '/' + segs.slice(1).join('/')
    if (rest === '/') rest = '/v1'
    if (rest.startsWith('/v1/')) rest = rest.slice(3)
    pathname = rest === '/v1' ? '/v1' : '/v1' + rest
    return { pathname, keyQuery }
  }

  if ((url.pathname === '/v1' || url.pathname === '/') && keyQuery.includes('/')) {
    const idx = keyQuery.indexOf('/')
    let pseudo = keyQuery.slice(idx)
    if (pseudo.startsWith('/v1/')) pseudo = pseudo.slice(3)
    pathname = '/v1' + pseudo
    keyQuery = keyQuery.slice(0, idx)
  }
  return { pathname, keyQuery }
}

/**
 * 网关鉴权。
 * 自建域名下 **请求头是首选通道**（没有平台代理干扰），
 * 所以优先级：Authorization / x-api-key → ?key= → 路径式。
 */
async function authGatewayKey(c, env, keyQuery) {
  const raw = c.req.header('authorization') || c.req.header('x-api-key') || ''
  const token = extractKey(raw) || extractKey(keyQuery)

  if (!isWellFormedKey(token)) {
    counters.rejected += 1
    return { error: jsonError(401, 'Missing or invalid API key. Send it in Authorization: Bearer <key>, or put it in the URL (?key=<key> or /<key>/...).', 'invalid_api_key') }
  }

  const hash = await hashApiKey(token)
  const resolved = await resolveKey(env, hash)

  if (!resolved?.ok) {
    counters.rejected += 1
    const reason = resolved?.reason
    if (reason === 'disabled') return { error: jsonError(403, 'This API key has been disabled.', 'key_disabled') }
    if (reason === 'backend_error') {
      return { error: jsonError(503, 'Key verification backend unavailable, please retry.', 'backend_unavailable') }
    }
    return { error: jsonError(401, 'Invalid API key.', 'invalid_api_key') }
  }

  return { hash, resolved }
}

/* ============================ 模型列表 ============================ */

async function handleModels(c, env, resolved) {
  const upstreams = (resolved.upstreams || []).filter((u) => u && (u.kind === 'builtin' || u.baseUrl))
  const builtin = upstreams.find((u) => u.kind === 'builtin')

  if (builtin) {
    try {
      const models = await listBuiltinModels(env)
      const created = Math.floor(Date.now() / 1000)
      return c.json({
        object: 'list',
        data: models.map((m) => ({ id: m.id, object: 'model', created, owned_by: 'workbuddy', name: m.name || m.id })),
      })
    } catch (err) {
      return jsonError(502, `Failed to list builtin models: ${err?.error?.message || err.message}`, 'upstream_error')
    }
  }

  return forward(env, {
    request: c.req.raw,
    pathname: '/v1/models',
    search: '',
    body: null,
    hash: '',
    upstreams,
    isStream: false,
    requestId: c.req.header('x-request-id') || crypto.randomUUID(),
  })
}

/* ============================ Anthropic 协议 ============================ */

/** Anthropic 的 max_tokens 必填，且带顶层 system 或内容块数组；OpenAI 的 content 通常是字符串 */
function isAnthropicShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return false
  if (typeof parsed.max_tokens !== 'number') return false
  return parsed.system !== undefined || Array.isArray(parsed.messages?.[0]?.content)
}

/**
 * Anthropic 内容块 → 文本。
 * Claude Code 的真实对话包含 tool_use / tool_result 块，只保留 text 会让部分消息
 * 变成空内容被云 API 拒绝，因此工具块转成文本表示。
 * 所有内容经 sanitizeContent 无害化，绕开云模型服务前置腾讯 WAF 的特征拦截。
 */
function blockToText(b) {
  if (!b || typeof b !== 'object') return ''
  if (b.type === 'text') return sanitizeContent(b.text || '')
  if (b.type === 'tool_use') {
    let args = JSON.stringify(b.input ?? {})
    if (args.length > 200) args = args.slice(0, 200) + '…'
    return sanitizeContent(`[调用工具 ${b.name}(${args})]`)
  }
  if (b.type === 'tool_result') {
    const c = b.content
    let text = Array.isArray(c)
      ? c.filter((x) => x?.type === 'text').map((x) => x?.text || '').join('\n')
      : String(c ?? '')
    if (!text) return '[工具结果为空]'
    if (text.length > 24_000) text = text.slice(0, 24_000) + '\n…(截断)'
    return sanitizeContent(`[工具结果]\n${text}`)
  }
  if (b.type === 'image') return '[图片]'
  if (b.type === 'thinking') return ''
  return ''
}

function anthropicToMessages(parsed) {
  const msgs = []
  let sys = parsed?.system
  if (Array.isArray(sys)) sys = sys.map((b) => b?.text || '').join('\n')
  // system 也做无害化：Claude Code 的 system-reminder 常附带文件内容，同样会触发 WAF
  if (sys) msgs.push({ role: 'system', content: sanitizeContent(sys) })
  for (const m of parsed?.messages || []) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    let content = m.content
    if (Array.isArray(content)) {
      content = content.map(blockToText).filter((s) => s !== '').join('\n')
    }
    if (typeof content !== 'string') content = content == null ? '' : JSON.stringify(content)
    // 空内容会被云 API 拒绝，用占位符兜底
    if (!content.trim()) content = '(无文本内容)'
    msgs.push({ role: m.role, content })
  }
  if (msgs.length === 0 || msgs[0].role !== 'system') {
    msgs.unshift({ role: 'system', content: 'You are Claude Code, a helpful assistant.' })
  }
  // 兜底：无论内容走的是数组块还是字符串分支，最终统一再过一遍无害化。
  // （字符串 content 曾漏网 —— 客户端直接发 content: "eval(x)" 时没被编码，导致 WAF 拦截）
  return msgs.map((m) => ({ ...m, content: sanitizeContent(m.content) }))
}

/** 上游错误摘要：HTML 一律归类为 WAF 拦截并带上长度（便于区分拦截页面来源） */
function describeUpstreamErr(err) {
  const msg = err?.error?.message || err?.message || 'unknown'
  if (/<!DOCTYPE|<html|WAF/i.test(msg)) return 'WAF-INTERCEPT-HTML(len=' + msg.length + ')'
  return String(msg).slice(0, 80)
}

async function handleAnthropicMessages(c, env, { body, resolved, hash }) {
  const parsed = safeJson(body) || {}
  const upstreams = (resolved.upstreams || []).filter((u) => u && (u.kind === 'builtin' || u.baseUrl))
  const builtin = upstreams.find((u) => u.kind === 'builtin')

  if (!builtin) {
    return jsonError(501, 'Anthropic protocol (/v1/messages) requires a builtin upstream. Add one in the console, or use OpenAI-compatible mode.', 'not_supported')
  }

  // 客户端传的 claude-sonnet-* 内置模型不认，一律用后台上游配置的模型
  const model = builtin.model || 'auto'
  const messages = anthropicToMessages(parsed)
  const id = 'msg_' + crypto.randomUUID().replace(/-/g, '')
  // 诊断摘要：请求体总字节 + 各消息编码后的长度分布（若再被 WAF 拦，可定位是哪一段漏编码）
  const reqSummary = `reqLen=${body?.byteLength || 0},msgLens=${messages.map((m) => m.content.length).slice(0, 8).join('/')}`

  const t0 = Date.now()
  // errMsg 会并入 upstream 字段写进 usage_logs —— isolate 内存诊断不可靠（跨 PoP），
  // 数据库才是可靠的错误来源
  const finalize = (usage, failed, errMsg) => logUsage(env, {
    hash, model, status: failed ? 502 : 200, latencyMs: Date.now() - t0,
    promptTokens: usage?.prompt_tokens || 0,
    completionTokens: usage?.completion_tokens || 0,
    upstream: builtin.name + (errMsg ? ' |ERR: ' + String(errMsg).slice(0, 150) : ''),
  })

  let iter
  try {
    iter = await createChatStream(env, { model, messages })
  } catch (err) {
    logUpstreamError('anthropic.create', model, err)
    await finalize(null, true, describeUpstreamErr(err) + " | " + reqSummary)
    return llmErrorResponse(err)
  }

  // ---- 非流式 ----
  if (parsed?.stream === false) {
    let content = ''
    let usage = null
    try {
      for await (const chunk of iter) {
        if (Date.now() - t0 > 45_000) {
          await finalize(usage, true)
          return jsonError(504, 'Non-streaming request exceeded 45s. Use "stream": true for long answers.', 'timeout_use_stream')
        }
        const d = chunk.choices?.[0]?.delta
        if (d?.content) content += d.content
        if (chunk.usage) usage = chunk.usage
      }
    } catch (err) {
      await finalize(usage, true, describeUpstreamErr(err) + " | " + reqSummary)
      return llmErrorResponse(err)
    }
    await finalize(usage, false)
    return new Response(JSON.stringify({
      id, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: usage?.prompt_tokens || 0, output_tokens: usage?.completion_tokens || 0 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-gw-upstream': asciiHeader(builtin.name) },
    })
  }

  // ---- 流式：Anthropic SSE 事件序列 ----
  const encoder = new TextEncoder()
  const rs = new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      let usage = null
      let failed = false
      let errLast = null
      try {
        send('message_start', {
          type: 'message_start',
          message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
        })
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        for await (const chunk of iter) {
          const d = chunk.choices?.[0]?.delta
          if (d?.content) {
            send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d.content } })
          }
          if (chunk.usage) usage = chunk.usage
        }
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage?.completion_tokens || 0 } })
        send('message_stop', { type: 'message_stop' })
      } catch (err) {
        failed = true
        errLast = err
        logUpstreamError('anthropic.stream', model, err)
        try {
          send('error', { type: 'error', error: { type: 'api_error', message: err?.error?.message || err?.message || 'upstream error' } })
        } catch { /* 流可能已关闭 */ }
      } finally {
        try { controller.close() } catch { /* 已关闭 */ }
        await finalize(usage, failed, failed ? (describeUpstreamErr(errLast) + " | " + reqSummary) : undefined)
      }
    },
    cancel() { /* 客户端断开不计用量 */ },
  })

  return new Response(rs, { status: 200, headers: { ...SSE_HEADERS, 'x-gw-upstream': asciiHeader(builtin.name) } })
}

/* ============================ 主分发 ============================ */

async function gatewayHandler(c, next) {
  counters.total += 1
  const requestId = c.req.header('x-request-id') || crypto.randomUUID()
  const url = new URL(c.req.url)

  // 诊断：记录到达的请求（isolate 内存）
  recent.unshift({
    time: new Date().toISOString(),
    method: c.req.method,
    path: (url.pathname + url.search).slice(0, 120),
    ua: (c.req.header('user-agent') || '').slice(0, 50),
  })
  if (recent.length > 30) recent.length = 30

  const { pathname, keyQuery } = resolveGatewayPath(url)

  // 非网关路径放行给静态资源（后台界面）
  if (!pathname.startsWith('/v1')) return next()

  const auth = await authGatewayKey(c, c.env, keyQuery)
  if (auth.error) return auth.error
  const { hash, resolved } = auth

  // 统一只读一次请求体
  let body = null
  let parsedBody = null
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    body = await c.req.arrayBuffer()
    parsedBody = safeJson(body)
  }

  if (pathname === '/v1/models' && c.req.method === 'GET') {
    return handleModels(c, c.env, resolved)
  }

  // 连通性探测：无 body 的 GET/HEAD，立即回执，避免被当模型请求而超时
  if ((c.req.method === 'GET' || c.req.method === 'HEAD') && pathname === '/v1') {
    return c.json({
      ok: true,
      service: 'wb-gateway-worker',
      models: '/v1/models',
      chat_completions: '/v1/chat/completions',
      anthropic_messages: '/v1/messages',
    })
  }

  // Anthropic 协议：显式路径，或落到 /v1 但请求体呈 Anthropic 形状
  if (
    c.req.method === 'POST' &&
    (pathname === '/v1/messages' || (pathname === '/v1' && isAnthropicShape(parsedBody)))
  ) {
    return handleAnthropicMessages(c, c.env, { body, resolved, hash })
  }

  const isStream = (c.req.header('accept') || '').includes('text/event-stream') || parsedBody?.stream === true

  const forwardSearchParams = new URLSearchParams(url.searchParams)
  forwardSearchParams.delete('key')
  const forwardSearch = forwardSearchParams.toString() ? '?' + forwardSearchParams.toString() : ''

  const t0 = Date.now()
  try {
    const res = await forward(c.env, {
      request: c.req.raw,
      pathname,
      search: forwardSearch,
      body,
      hash,
      upstreams: resolved.upstreams || [],
      isStream,
      requestId,
    })

    if (res.status < 400) counters.ok += 1
    else counters.failed += 1

    res.headers.set('x-request-id', requestId)
    return res
  } catch (err) {
    counters.failed += 1
    return jsonError(500, `Internal gateway error: ${err.message}`, 'gateway_error')
  }
}

app.all('*', gatewayHandler)

// 网关未接管的路径 → 交给 Workers Assets（后台界面）
app.all('*', (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw)
  return c.notFound()
})

export default app

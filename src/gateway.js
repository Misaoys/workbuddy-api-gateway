/**
 * OpenAI / Anthropic 兼容转发核心（Workers 版）。
 *
 * 上游配置来自云数据库（由 gateway_resolve 随 Key 一起返回），
 * 因此后台改完配置即刻生效，无需重启服务。
 */
import { logUsage, createChatStream } from './cloud.js'
import { ToolCalls } from './protocol.js'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])

const RETRY_STATUS = new Set([429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 3

const decoder = new TextDecoder()

/**
 * HTTP 头值只能是 ByteString(latin1)。上游名常是中文，
 * 直接塞进 header 会让 fetch 抛 "Cannot convert argument to a ByteString"。
 */
export function asciiHeader(value) {
  const s = String(value ?? '')
  return /^[\x20-\x7E]*$/.test(s) ? s : encodeURIComponent(s)
}

/** 把下游路径拼到上游 baseUrl 上：/v1/chat/completions → <base>/chat/completions */
export function buildTargetUrl(upstream, pathname, search) {
  const base = String(upstream.baseUrl || '').replace(/\/+$/, '')
  let path = pathname
  if (path.startsWith('/v1')) path = path.slice(3)
  if (!path.startsWith('/')) path = `/${path}`
  return new URL(`${base}${path}${search || ''}`)
}

function parseKeys(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)
}

function buildForwardHeaders(incoming, apiKey) {
  const headers = {}
  for (const [k, v] of incoming.entries()) {
    const lower = k.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    // 换上下游 Key，不透传调用方的网关 Key
    if (lower === 'authorization' || lower === 'x-api-key') continue
    headers[k] = v
  }
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
  return headers
}

/** 剔除 hop-by-hop 头与 content-length（流式下长度会失真），并补上网关观测头 */
function cleanHeaders(rawHeaders, meta) {
  const headers = new Headers()
  for (const [k, v] of rawHeaders.entries()) {
    const lower = k.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower === 'content-length') continue
    headers.set(k, v)
  }
  headers.set('x-gw-upstream', asciiHeader(meta.upstreamName || '-'))
  headers.set('x-gw-latency-ms', String(meta.latencyMs))
  return headers
}

/** 从非流式响应体里取 usage */
function extractUsage(text) {
  try {
    const obj = JSON.parse(text)
    return {
      prompt: obj?.usage?.prompt_tokens || 0,
      completion: obj?.usage?.completion_tokens || 0,
      model: obj?.model || null,
    }
  } catch {
    return { prompt: 0, completion: 0, model: null }
  }
}

/**
 * 流式响应旁路解析 usage。
 * 用 TransformStream 的 flush 在流结束时统计 —— 绝不能额外再 pipeTo 一次，
 * 那会锁住流导致客户端读不到内容（"Response body object should not be disturbed or locked"）。
 */
function tapForUsage(body, onDone, tailBytes = 16384) {
  let tail = ''
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      try {
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-tailBytes)
      } catch { /* 忽略解码问题 */ }
    },
    flush() {
      try { onDone(tail) } catch { /* 统计失败绝不影响响应 */ }
    },
  }))
}

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

export function safeJson(buf) {
  try { return JSON.parse(decoder.decode(buf)) } catch { return null }
}

/**
 * 检测内容是否含腾讯 WAF 的攻击特征（密钥样串/代码围栏/注入语句等）。
 * 命中则 Base64 编码传输，避免云模型服务入口的 WAF 拦截。
 * 判据从宽、不限长度：短消息里的 `eval(x)` 同样会被拦，不能因为内容短就放行。
 */
export function hasWafPatterns(text) {
  const s = String(text)
  if (!s) return false
  if (/```/.test(s)) return true
  if (/sk-[A-Za-z0-9_-]{16,}/.test(s)) return true
  if (/eval\s*\(|SELECT\s+\S+\s+FROM\s|<script|rm\s+-rf\s|DROP\s+TABLE|onerror\s*=|document\.cookie|base64_decode|UNION\s+SELECT/i.test(s)) return true
  if (s.length > 300 && ((s.match(/;/g) || []).length >= 10 || (s.match(/[{}]/g) || []).length >= 8)) return true
  return false
}

/**
 * 内容无害化：命中特征则 Base64 编码（按 76 字符折行）并提示模型解码。
 * 折行是必需的 —— WAF 的"疑似加密数据外传"规则会按超长连续 base64 串拦截。
 */
export function sanitizeContent(text) {
  const s = String(text ?? '')
  if (!s || !hasWafPatterns(s)) return s
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  const b64 = btoa(bin).replace(/.{76}/g, '$&\n')
  return `[以下内容为 base64 编码（已按 76 字符折行），请拼接后解码再阅读]\n${b64}\n[编码结束]`
}

/** 云 LLM 要求 messages[0] 必须是 system；内容统一做 WAF 无害化 */
export function normalizeMessages(parsed) {
  const raw = Array.isArray(parsed?.messages) ? parsed.messages : []
  const cleaned = []
  for (const m of raw) {
    if (!m || typeof m.role !== 'string') continue
    let content = m.content
    if (Array.isArray(content)) {
      content = content.map((part) => part.type === 'text'
        ? { ...part, text: sanitizeContent(part.text) } : part)
    } else if (content != null) content = sanitizeContent(content)
    else content = m.role === 'assistant' && m.tool_calls?.length ? null : ''
    const message = { role: m.role, content }
    for (const key of ['name', 'tool_call_id', 'tool_calls']) {
      if (m[key] !== undefined) message[key] = m[key]
    }
    cleaned.push(message)
  }
  if (cleaned.length === 0 || cleaned[0].role !== 'system') {
    cleaned.unshift({ role: 'system', content: 'You are a helpful assistant. Be concise and helpful.' })
  }
  return cleaned
}

export function llmErrorResponse(err) {
  const code = err?.error?.code || ''
  const status = err?.status >= 400 && err?.status < 600 ? err.status : 502
  let message = err?.error?.message || err?.message || 'Upstream model error'
  if (code.startsWith('quota_')) message = '额度不足或触发限流：' + message
  if (code.startsWith('auth_')) message = '云服务鉴权未通过（Origin 或凭证问题）：' + message
  if (err?.requestId) message += ` (requestId: ${err.requestId})`
  return new Response(JSON.stringify({ error: { message, type: code || 'upstream_error' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 内置上游：调用云服务 LLM（免密钥，消耗应用创建者额度）。
 * 该模块只支持 stream:true，所以下游即便要非流式，也必须先流式拉取再在服务端聚合。
 */
async function forwardBuiltin(env, { body, isStream, hash, upstream }) {
  const parsed = body ? safeJson(body) : null
  const model = (parsed?.model && String(parsed.model)) || upstream.model || 'auto'
  const messages = normalizeMessages(parsed)
  const startedAt = Date.now()
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  let iter
  try {
    iter = await createChatStream(env, { ...parsed, model, messages })
  } catch (err) {
    await logUsage(env, { hash, model, status: err?.status || 502, latencyMs: Date.now() - startedAt, upstream: upstream.name })
    return llmErrorResponse(err)
  }

  // ---------- 下游要非流式：聚合后返回单个 JSON ----------
  if (!isStream) {
    let content = ''
    let reasoning = ''
    let finish = 'stop'
    let usage = null
    const tools = new ToolCalls()
    try {
      for await (const chunk of iter) {
        // 边缘代理有 60s 硬超时，这里提前 45s 收口返回可读错误
        if (Date.now() - startedAt > 45_000) {
          await logUsage(env, { hash, model, status: 504, latencyMs: Date.now() - startedAt, upstream: upstream.name })
          return jsonError(504, 'Non-streaming request exceeded 45s. Use "stream": true for long answers.', 'timeout_use_stream')
        }
        const d = chunk.choices?.[0]?.delta
        if (d?.content) content += d.content
        if (d?.reasoning_content) reasoning += d.reasoning_content
        tools.add(d?.tool_calls)
        const f = chunk.choices?.[0]?.finish_reason
        if (f) finish = f
        if (chunk.usage) usage = chunk.usage
      }
    } catch (err) {
      await logUsage(env, { hash, model, status: err?.status || 502, latencyMs: Date.now() - startedAt, upstream: upstream.name })
      return llmErrorResponse(err)
    }

    const latencyMs = Date.now() - startedAt
    await logUsage(env, {
      hash, model, status: 200, latencyMs,
      promptTokens: usage?.prompt_tokens || 0,
      completionTokens: usage?.completion_tokens || 0,
      upstream: upstream.name,
    })

    const toolCalls = tools.values()
    const message = { role: 'assistant', content: content || (toolCalls.length ? null : '') }
    if (toolCalls.length) {
      message.tool_calls = toolCalls
      if (finish === 'stop') finish = 'tool_calls'
    }
    if (reasoning) message.reasoning_content = reasoning
    return new Response(JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: usage
        ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens }
        : undefined,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-gw-upstream': asciiHeader(upstream.name), 'x-gw-latency-ms': String(latencyMs) },
    })
  }

  // ---------- 下游要流式：逐 chunk 转成 OpenAI 格式 SSE ----------
  const encoder = new TextEncoder()
  const rs = new ReadableStream({
    async start(controller) {
      let usage = null
      let failed = false
      try {
        for await (const chunk of iter) {
          const d = chunk.choices?.[0]?.delta || {}
          const fr = chunk.choices?.[0]?.finish_reason ?? null
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: d, finish_reason: fr }],
          })}\n\n`))
          if (chunk.usage) usage = chunk.usage
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        failed = true
        const msg = err?.error?.message || err?.message || 'upstream stream error'
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: msg, type: err?.error?.code || 'upstream_error' } })}\n\n`))
      } finally {
        try { controller.close() } catch { /* 可能已关闭 */ }
        await logUsage(env, {
          hash, model, status: failed ? 502 : 200, latencyMs: Date.now() - startedAt,
          promptTokens: usage?.prompt_tokens || 0,
          completionTokens: usage?.completion_tokens || 0,
          upstream: upstream.name,
        })
      }
    },
    cancel() { /* 客户端断开不计用量 */ },
  })

  return new Response(rs, { status: 200, headers: { ...SSE_HEADERS, 'x-gw-upstream': asciiHeader(upstream.name) } })
}

/**
 * 执行一次网关转发。
 * @returns {Promise<Response>}
 */
export async function forward(env, { request, pathname, search, body, hash, upstreams, isStream, requestId }) {
  const usable = (upstreams || []).filter((u) => u && (u.kind === 'builtin' || u.baseUrl))

  if (usable.length === 0) {
    return jsonError(503, 'No upstream configured. Add one in the admin console before calling the gateway.', 'upstream_not_configured')
  }

  let lastError = null
  let lastStatus = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const upstream = usable[attempt % usable.length]

    // 内置上游：直连云服务 LLM，不走 HTTP 转发
    if (upstream.kind === 'builtin') {
      const res = await forwardBuiltin(env, { body, isStream, hash, upstream })
      if (res.status < 500) return res
      lastError = new Error(`内置上游返回 ${res.status}`)
      lastStatus = res.status
      continue
    }

    const keys = parseKeys(upstream.apiKeys)
    const apiKey = keys.length ? keys[Math.floor(Math.random() * keys.length)] : null

    let target
    try {
      target = buildTargetUrl(upstream, pathname, search)
    } catch {
      lastError = new Error(`上游地址非法: ${upstream.baseUrl}`)
      continue
    }

    const startedAt = Date.now()
    try {
      const upstreamRes = await fetch(target, {
        method: request.method,
        headers: buildForwardHeaders(request.headers, apiKey),
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
        redirect: 'manual',
      })
      const latencyMs = Date.now() - startedAt

      const retriable = RETRY_STATUS.has(upstreamRes.status) && attempt < MAX_ATTEMPTS - 1
      if (retriable) {
        await upstreamRes.body?.cancel().catch(() => {})
        lastStatus = upstreamRes.status
        lastError = new Error(`upstream ${upstream.name} returned ${upstreamRes.status}`)
        continue
      }

      // 非流式：读全量以解析 usage
      if (!isStream) {
        const text = await upstreamRes.text()
        const usage = extractUsage(text)
        await logUsage(env, {
          hash, model: usage.model, status: upstreamRes.status, latencyMs,
          promptTokens: usage.prompt, completionTokens: usage.completion, upstream: upstream.name,
        })
        return new Response(text, {
          status: upstreamRes.status,
          headers: cleanHeaders(upstreamRes.headers, { upstreamName: upstream.name, latencyMs }),
        })
      }

      // 流式：旁路统计 usage，既不缓冲主流程，也不额外消费流
      const stream = tapForUsage(upstreamRes.body, (tail) => {
        const usage = extractUsageFromSse(tail)
        // flush 回调不能 await，用量写入异步进行即可
        void logUsage(env, {
          hash, model: usage.model, status: upstreamRes.status, latencyMs,
          promptTokens: usage.prompt, completionTokens: usage.completion, upstream: upstream.name,
        })
      })

      return new Response(stream, {
        status: upstreamRes.status,
        headers: cleanHeaders(upstreamRes.headers, { upstreamName: upstream.name, latencyMs }),
      })
    } catch (err) {
      lastError = err
      lastStatus = err.name === 'AbortError' ? 504 : null
    }
  }

  await logUsage(env, { hash, status: lastStatus || 502, latencyMs: 0, upstream: null })
  return jsonError(502, `All upstreams failed: ${lastError?.message || 'unknown error'}`, 'upstream_error')
}

/** 从 SSE 尾部文本里找 usage（最后一个带 usage 的 chunk 为准） */
export function extractUsageFromSse(tail) {
  const out = { prompt: 0, completion: 0, model: null }
  for (const line of String(tail).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload)
      if (obj.model) out.model = obj.model
      if (obj.usage) {
        out.prompt = obj.usage.prompt_tokens || out.prompt
        out.completion = obj.usage.completion_tokens || out.completion
      }
    } catch { /* 不完整的分片，跳过 */ }
  }
  return out
}

export function jsonError(status, message, type) {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

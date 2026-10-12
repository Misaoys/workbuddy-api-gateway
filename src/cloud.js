/**
 * 云数据访问层（Workers 版）。
 *
 * 与 Node 版一致的关键约束（已实测）：
 * - 只能用官方 SDK 访问数据平面，手写 fetch 打 /.cloud/** 会 401 invalid_client。
 * - SDK 以 anon 身份访问，RLS 会过滤掉所有行，所以网关走 SECURITY DEFINER 函数：
 *     gateway_resolve(hash) -> 校验 Key 并带回该 owner 的上游配置
 *     gateway_log(...)      -> 写入用量并累加调用次数
 * publishableKey 本身不带权限（服务端按 Origin 校验），可安全放在 Worker 配置里。
 */
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'

let client = null
let clientKey = ''

/** Workers isolate 会复用，客户端按配置缓存一次即可 */
function getClient(env) {
  const endpoint = env.CLOUD_ENDPOINT
  const publishableKey = env.CLOUD_PUBLISHABLE_KEY
  const sig = endpoint + '|' + publishableKey
  if (!client || clientKey !== sig) {
    client = createWorkBuddyCloud({ endpoint, publishableKey })
    clientKey = sig
  }
  return client
}

/** 校验 API Key 并取回该用户的上游配置；失败返回 { ok:false, reason } */
export async function resolveKey(env, hash) {
  try {
    const { data, error } = await getClient(env).database.rpc('gateway_resolve', { p_hash: hash })
    if (error) return { ok: false, reason: 'backend_error', detail: error.message }
    return data || { ok: false, reason: 'empty' }
  } catch (e) {
    return { ok: false, reason: 'backend_error', detail: e.message }
  }
}

/** 记录一次调用用量。刻意不抛异常 —— 用量写入失败绝不能让正常请求失败。 */
export async function logUsage(env, { hash, model, status, latencyMs, promptTokens, completionTokens, upstream }) {
  try {
    await getClient(env).database.rpc('gateway_log', {
      p_hash: hash,
      p_model: model || null,
      p_status: status || null,
      p_latency_ms: latencyMs || null,
      p_prompt_tokens: promptTokens || 0,
      p_completion_tokens: completionTokens || 0,
      p_upstream: upstream || null,
    })
  } catch {
    /* 静默：日志失败不影响主流程 */
  }
}

/** 拉取内置模型目录（过滤掉 disabled 的） */
export async function listBuiltinModels(env) {
  const models = await getClient(env).llm.models.list()
  return Array.isArray(models) ? models.filter((m) => m.disabled !== true) : []
}

/** 供 worker 调用内置模型（只支持 stream:true） */
export async function createChatStream(env, { model, messages }) {
  return getClient(env).llm.chat.completions.create({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  })
}

/**
 * Key 工具（Workers 版）。
 * 用 Web Crypto 而不是 node:crypto，避免依赖 nodejs_compat 兼容层。
 */

/** SHA-256 摘要，返回 64 位 hex。注意是 async —— Web Crypto 没有同步接口。 */
export async function hashApiKey(key) {
  const data = new TextEncoder().encode(String(key || ''))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 宽松格式校验：真正的鉴权在 hash 比对，这里只拦明显垃圾。
 * 40-64 位 hex 都放行，避免把「复制少一位」误报成格式错误。
 */
export function isWellFormedKey(key) {
  return typeof key === 'string' && /^sk-wb-[0-9a-f]{40,64}$/.test(key)
}

/**
 * 从任意文本中提取 Key。
 * 客户端常把 base URL 的 query 和路径拼在一起（如 ?key=sk-wb-xxx/chat/completions），
 * 或把 Key 混在 Authorization 里，所以按正则提取而不是整串校验。
 */
export function extractKey(text) {
  const m = String(text || '').match(/sk-wb-[0-9a-f]{40,64}/)
  return m ? m[0] : ''
}

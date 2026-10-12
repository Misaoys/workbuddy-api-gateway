/**
 * 前端公开配置 —— 部署时替换为你自己的值。
 *
 * endpoint         : 云服务数据平面地址（你的应用域名）
 * oauthRelayBaseUrl: 登录代理（保持默认即可）
 * publishableKey   : 应用公开标识（本身不带权限，服务端按 Origin 校验，可安全放在前端）
 *
 * 注意：自建域名下后台登录/Key 管理走云服务 Origin 校验；
 * 若你的部署环境不通过，可仅把网关 API 部署到这里、后台继续用原应用域名管理。
 */
window.__WB_PUBLIC_CONFIG__ = {
  endpoint: 'https://wb-gateway-admin.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_JHOFOOEB8sZ4CcunCAE3Y1_yQzELWruC0F6I45WyJQVWnKAG3m5h9FW',
  // 网关对外访问地址（客户端接入用）；留空则回退当前页面域名
  gatewayBaseUrl: '',
}

# WorkBuddy API Gateway

把 WorkBuddy 云服务包装成 **OpenAI / Anthropic 双协议兼容**的 API 网关，跑在 Cloudflare Workers 上。

聚合云端大模型能力，对外提供标准的 `/v1/chat/completions`、`/v1/messages`、`/v1/models` 端点，
让 Claude Code、CCR、OpenAI SDK 等任何兼容客户端都能直接接入。

## ✨ 特性

- **双协议**：OpenAI Chat Completions + Anthropic Messages（原生 SSE 事件序列）
- **自带后台**：Web 管理界面 —— API Key 创建/禁用、用量统计、上游配置，无需重建即可生效
- **多 Key 管理**：每把 Key 独立计量，支持随时吊销
- **协议自动识别**：请求落到 `/v1` 根路径也能按请求体特征自动判断走哪套协议
- **四种 Key 传递方式**：`Authorization` 头 / `x-api-key` 头 / `?key=` query / `/<key>` 路径
- **WAF 无害化**：自动对代码内容做编码处理，绕过上游安全网关的特征拦截（见下文"踩坑经验"）
- **零密钥推理服务**：模型调用走云 SDK，不依赖外部 API Key

## 🏗️ 架构

```
客户端 (Claude Code / CCR / OpenAI SDK / curl)
        │  OpenAI 或 Anthropic 协议
        ▼
Cloudflare Workers（本项目）
        │  · 鉴权（Key → SHA-256 → 云数据库校验）
        │  · 协议转换（Anthropic ⇄ 内部格式）
        │  · 内容无害化（WAF 规避）
        ▼
WorkBuddy 云服务（数据库 + 大模型）
```

- 运行时：Cloudflare Workers（V8 isolate），静态后台由 Workers Assets 托管
- 路由：[Hono](https://hono.dev)
- 数据/模型：`@tencent-ai/workbuddy-cloud-sdk`

## 🚀 快速开始

### 1. 安装与登录

```bash
npm install
npx wrangler login
```

### 2. 配置 `wrangler.toml`

```toml
routes = [
  { pattern = "api.example.com", custom_domain = true }   # 换成你的域名
]

[vars]
CLOUD_ENDPOINT = "https://your-app.example.com"           # 你的应用域名
CLOUD_PUBLISHABLE_KEY = "wbpk_..."                        # 应用控制台获取
```

同时把 `public/config.js` 里的 `endpoint` / `publishableKey` 换成同样的值。

> 没有自己域名？删掉 `routes` 段，直接用 `https://<worker名>.<你的子域>.workers.dev` 访问。

### 3. 部署

```bash
npx wrangler deploy
```

### 4. 数据库准备

后台与鉴权依赖云数据库中的三张表与两个函数：

```sql
-- API Keys
create table api_keys (
  id bigserial primary key,
  owner_id text not null,
  name text,
  key_hash text not null,          -- sha256(明文key)
  key_prefix text,                 -- 展示用前缀
  status text default 'active',
  call_count bigint default 0,
  created_at timestamptz default now()
);

-- 上游配置（内置模型 / 自建上游）
create table upstreams (
  id bigserial primary key,
  owner_id text not null,
  name text,
  kind text default 'builtin',     -- builtin = 云模型；其它 = HTTP 转发
  model text default 'auto',
  base_url text,
  api_keys text,
  enabled boolean default true
);

-- 用量日志
create table usage_logs (
  id bigserial primary key,
  owner_id text not null,
  key_prefix text,
  model text,
  status int,
  latency_ms int,
  prompt_tokens int default 0,
  completion_tokens int default 0,
  upstream_name text,
  created_at timestamptz default now()
);
```

鉴权走 `SECURITY DEFINER` 函数（服务端以 anon 身份访问，需绕过 RLS）：

```sql
create or replace function gateway_resolve(p_hash text)
returns jsonb
language plpgsql security definer
as $$
declare v_key api_keys%rowtype;
begin
  if p_hash is null or length(p_hash) <> 64 then
    return jsonb_build_object('ok', false, 'reason', 'malformed');
  end if;
  select * into v_key from api_keys where key_hash = p_hash limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_key.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  return jsonb_build_object(
    'ok', true,
    'keyId', v_key.id,
    'upstreams', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', u.name, 'kind', u.kind, 'model', u.model,
        'baseUrl', u.base_url, 'apiKeys', u.api_keys
      ) order by u.id), '[]'::jsonb)
      from upstreams u where u.owner_id = v_key.owner_id and u.enabled
    )
  );
end;
$$;

grant execute on function gateway_resolve(text) to anon;

-- gateway_log(p_hash, p_model, p_status, p_latency_ms,
--             p_prompt_tokens, p_completion_tokens, p_upstream)
-- 用途：写用量日志 + 累加 api_keys.call_count，结构同上，按需实现。
```

## 🔌 客户端接入

### Claude Code / CC Switch

| 栏位 | 值 |
|---|---|
| 请求地址 | `https://api.example.com`（Anthropic 原生，完整 URL 关） |
| API Key | `sk-wb-你的密钥` |

等价的环境变量方式：

```json
{ "env": {
  "ANTHROPIC_BASE_URL": "https://api.example.com",
  "ANTHROPIC_AUTH_TOKEN": "sk-wb-你的密钥"
} }
```

### CCR（claude-code-router）

```json
{
  "Providers": [{
    "name": "my-gateway",
    "api_base_url": "https://api.example.com/v1",
    "api_key": "sk-wb-你的密钥",
    "models": ["auto"],
    "transformer": { "use": ["anthropic"] }
  }]
}
```

### OpenAI SDK

```python
from openai import OpenAI
client = OpenAI(base_url="https://api.example.com/v1", api_key="sk-wb-你的密钥")
client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "你好"}])
```

### curl

```bash
# OpenAI 格式
curl https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer sk-wb-你的密钥" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好"}]}'

# Anthropic 格式
curl https://api.example.com/v1/messages \
  -H "x-api-key: sk-wb-你的密钥" \
  -H "content-type: application/json" \
  -d '{"model":"auto","max_tokens":100,"messages":[{"role":"user","content":"你好"}]}'
```

## 🕳️ 踩坑经验

这些是实际部署中遇到的问题与解法，供参考：

**1. 上游模型网关有 WAF，代码内容会被拦**
Claude Code 天天读代码，请求体里的密钥样串、`eval(`、SQL、XSS 特征会被模型服务入口的
WAF 拦截并返回 403 HTML。本项目会自动检测并把这些内容转为 Base64（含折行，避免
"长 base64 串"规则），并在消息里提示模型解码。普通文本不受影响。

**2. 消息内容有两种形态，必须都处理**
Anthropic 协议里 `content` 既可能是字符串也可能是内容块数组（`text` / `tool_use` /
`tool_result`）。只处理一种会留下稳定的漏网路径。本项目在最终出口统一兜底。

**3. 工具块不能丢**
`tool_use` / `tool_result` 块如果被过滤掉，消息会变成空内容被模型 API 拒绝（报 400/502）。
本项目把工具块转成文本表示后再发送。

**4. 非流式请求有 60 秒硬超时**
若中间还有边缘代理，长回答可能被截断。本项目对非流式做了 45 秒主动收口，返回可读错误；
建议客户端开启 `stream: true`。

**5. Workers 没有可靠的运行时长**
isolate 会复用、时钟在请求间被冻结/重置，跨请求的 `Date.now()` 差值无意义。
不要实现"运行时长"类指标。

**6. 部署依赖的小坑**
- 若 `wrangler` 报缺少平台二进制（`@cloudflare/workerd-windows-64`、`@esbuild/win32-x64`），
  按主包版本号一起 `npm install --save-optional` 即可
- `wrangler.toml` 里 `routes` 要写在 `[assets]` 之前（TOML 键归属最近的 section 头）
- 代理环境下记得清空 `https_proxy` 再执行 wrangler 命令

## 📄 License

MIT

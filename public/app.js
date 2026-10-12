/* global WorkBuddyCloud */
;(function () {
  'use strict'

  const cfg = window.__WB_PUBLIC_CONFIG__

  // 客户端只初始化一次，Auth / Database 共用这一个实例
  const cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: cfg.endpoint,
    oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
    publishableKey: cfg.publishableKey,
  })

  const $ = (id) => document.getElementById(id)
  /** 客户端接入用的网关地址：优先用配置的对外域名，否则回退当前页面域名 */
  const gwBase = (cfg.gatewayBaseUrl || location.origin).replace(/\/+$/, '')
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  let currentSession = null
  let currentView = 'overview'

  /* ============================ 通用 UI ============================ */

  function setAuthMsg(text, kind) {
    const el = $('authMsg')
    el.textContent = text || ''
    el.className = 'msg' + (kind ? ' ' + kind : '')
  }

  function showAuthView() {
    $('authView').classList.remove('hidden')
    $('appView').classList.add('hidden')
  }

  function showAppView() {
    $('authView').classList.add('hidden')
    $('appView').classList.remove('hidden')
  }

  function setView(name) {
    currentView = name
    document.querySelectorAll('.side button').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === name)
    })
    ;['overview', 'keys', 'upstreams', 'models', 'usage'].forEach((v) => {
      $('view-' + v).classList.toggle('hidden', v !== name)
    })
    if (name === 'overview') loadOverview()
    if (name === 'keys') loadKeys()
    if (name === 'upstreams') loadUpstreams()
    if (name === 'models') loadModels()
    if (name === 'usage') loadUsage()
  }

  function busy(btn, on, labelBusy) {
    if (!btn) return
    if (on) {
      btn.dataset.label = btn.textContent
      btn.textContent = labelBusy || '处理中…'
      btn.disabled = true
    } else {
      btn.textContent = btn.dataset.label || btn.textContent
      btn.disabled = false
    }
  }

  /* ============================ 密钥工具 ============================ */

  function generateKey() {
    const bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    return 'sk-wb-' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /* ============================ 登录 ============================ */

  $('tabPhone').addEventListener('click', () => {
    $('tabPhone').classList.add('active')
    $('tabEmail').classList.remove('active')
    $('panePhone').classList.remove('hidden')
    $('paneEmail').classList.add('hidden')
    setAuthMsg('')
  })

  $('tabEmail').addEventListener('click', () => {
    $('tabEmail').classList.add('active')
    $('tabPhone').classList.remove('active')
    $('paneEmail').classList.remove('hidden')
    $('panePhone').classList.add('hidden')
    setAuthMsg('')
  })

  // ---------- 手机号 ----------
  let pendingPhone = null
  let phoneTimer = null

  $('phoneInput').addEventListener('input', () => {
    $('phoneErr').classList.add('hidden')
    $('phoneErr').textContent = ''
  })

  $('sendPhoneCode').addEventListener('click', async () => {
    const phone = $('phoneInput').value.trim()
    if (!/^1\d{10}$/.test(phone)) {
      $('phoneErr').textContent = '请输入正确的 11 位手机号'
      $('phoneErr').classList.remove('hidden')
      return
    }
    $('phoneErr').classList.add('hidden')

    const btn = $('sendPhoneCode')
    busy(btn, true, '发送中…')
    const sent = await cloud.auth.sendOtp({ phone })
    busy(btn, false)

    if (sent.error) {
      setAuthMsg(sent.error.message || '验证码发送失败', 'err')
      return
    }
    pendingPhone = { phone, ...sent.data }
    setAuthMsg('验证码已发送', 'ok')

    // 倒计时只作用于"获取验证码"，不影响提交已收到的验证码
    let left = 60
    clearInterval(phoneTimer)
    btn.disabled = true
    btn.textContent = left + 's 后重发'
    phoneTimer = setInterval(() => {
      left -= 1
      if (left <= 0) {
        clearInterval(phoneTimer)
        btn.disabled = false
        btn.textContent = '获取验证码'
      } else {
        btn.textContent = left + 's 后重发'
      }
    }, 1000)
  })

  $('phoneLogin').addEventListener('click', async () => {
    const phone = $('phoneInput').value.trim()
    const token = $('phoneCode').value.trim()
    if (!pendingPhone || pendingPhone.phone !== phone) {
      setAuthMsg('请先获取当前手机号的验证码', 'err')
      return
    }
    if (!token) {
      setAuthMsg('请输入验证码', 'err')
      return
    }
    const btn = $('phoneLogin')
    busy(btn, true, '登录中…')
    const done = await cloud.auth.verifyOtp({
      phone: pendingPhone.phone,
      verificationId: pendingPhone.verificationId,
      isExistingUser: pendingPhone.isExistingUser,
      token,
    })
    busy(btn, false)
    if (done.error) {
      setAuthMsg(done.error.message || '登录失败', 'err')
      return
    }
    pendingPhone = null
    enterApp(done.data)
  })

  // ---------- 邮箱 ----------
  let pendingEmail = null

  $('sendEmailCode').addEventListener('click', async () => {
    const email = $('emailInput').value.trim()
    if (!/.+@.+\..+/.test(email)) {
      setAuthMsg('请输入正确的邮箱地址', 'err')
      return
    }
    const btn = $('sendEmailCode')
    busy(btn, true, '发送中…')
    const sent = await cloud.auth.sendOtp({ email })
    busy(btn, false)
    if (sent.error) {
      setAuthMsg(sent.error.message || '验证码发送失败', 'err')
      return
    }
    pendingEmail = { email, ...sent.data }
    setAuthMsg('验证码已发送', 'ok')
  })

  $('emailLogin').addEventListener('click', async () => {
    const email = $('emailInput').value.trim()
    const token = $('emailCode').value.trim()
    const password = $('emailPassword').value
    if (!pendingEmail || pendingEmail.email !== email) {
      setAuthMsg('请先获取当前邮箱的验证码', 'err')
      return
    }
    if (!token) {
      setAuthMsg('请输入验证码', 'err')
      return
    }
    if (!pendingEmail.isExistingUser && !password) {
      setAuthMsg('首次注册请设置密码', 'err')
      return
    }
    const btn = $('emailLogin')
    busy(btn, true, '登录中…')
    const done = await cloud.auth.verifyOtp({
      email: pendingEmail.email,
      verificationId: pendingEmail.verificationId,
      isExistingUser: pendingEmail.isExistingUser,
      token,
      password: pendingEmail.isExistingUser ? undefined : password,
    })
    busy(btn, false)
    if (done.error) {
      setAuthMsg(done.error.message || '登录失败', 'err')
      return
    }
    pendingEmail = null
    enterApp(done.data)
  })

  // ---------- 微信 ----------
  $('wechatLogin').addEventListener('click', async () => {
    const btn = $('wechatLogin')
    busy(btn, true, '跳转中…')
    const { data, error } = await cloud.auth.signInWithOAuth({
      provider: 'wechat',
      // 必须是站点根路径：子路径没有对应的静态文件，会在 JS 执行前就 404
      redirectTo: location.origin,
    })
    busy(btn, false)
    if (error) {
      setAuthMsg(error.message || '微信登录发起失败（可能尚未开通该登录方式）', 'err')
      return
    }
    location.assign(data.url)
  })

  // ---------- 退出 ----------
  $('signOut').addEventListener('click', async () => {
    await cloud.auth.signOut()
    currentSession = null
    showAuthView()
  })

  /* ============================ 进入主界面 ============================ */

  function enterApp(session) {
    currentSession = session
    const u = session && session.user
    $('whoami').textContent = (u && (u.email || u.phone)) || '已登录'
    showAppView()
    setView('overview')
  }

  /* ============================ 概览 ============================ */

  async function loadOverview() {
    // 标准填法：自建域名下 Key 可单独填，地址保持纯净
    $('openaiBase').textContent = gwBase + '/v1'
    $('anthropicBase').textContent = gwBase
    $('modelsUrl').textContent = gwBase + '/v1/models'
    $('keyHint').textContent = 'sk-wb-…（填在客户端 API Key 栏）'

    // 地址式填法：兼容不支持单独填 Key 的客户端
    $('baseUrlSnippet').textContent = gwBase + '/<你的Key>'
    $('endpointSnippet').textContent = gwBase + '/v1/chat/completions?key=<你的Key>'

    const [keysRes, upRes, usageRes] = await Promise.all([
      cloud.database.from('api_keys').select('id, status, call_count', { count: 'exact' }),
      cloud.database.from('upstreams').select('id, enabled'),
      cloud.database.from('usage_logs').select('id, created_at'),
    ])

    const keys = keysRes.data || []
    const ups = upRes.data || []
    const logs = usageRes.data || []

    $('statKeys').textContent = keys.length
    $('statCalls').textContent = keys.reduce((s, k) => s + Number(k.call_count || 0), 0)
    $('statUpstreams').textContent = ups.filter((u) => u.enabled).length

    const today = new Date().toISOString().slice(0, 10)
    $('statToday').textContent = logs.filter((l) => String(l.created_at || '').slice(0, 10) === today).length

    $('curlSnippet').textContent =
      '# OpenAI 格式\n' +
      'curl ' + gwBase + '/v1/chat/completions \\\n' +
      '  -H "Authorization: Bearer <你的Key>" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      '  -d \'{"model":"auto","messages":[{"role":"user","content":"你好"}]}\'\n\n' +
      '# Anthropic 格式（Claude Code / CCR）\n' +
      'curl ' + gwBase + '/v1/messages \\\n' +
      '  -H "x-api-key: <你的Key>" \\\n' +
      '  -H "content-type: application/json" \\\n' +
      '  -d \'{"model":"auto","max_tokens":100,"messages":[{"role":"user","content":"你好"}]}\''
  }

  /* ============================ API Keys ============================ */

  async function loadKeys() {
    const wrap = $('keysTableWrap')
    const { data, error } = await cloud.database
      .from('api_keys')
      .select('id, name, key_prefix, status, call_count, last_used_at, created_at')
      .order('created_at', { ascending: false })

    if (error) {
      wrap.innerHTML = '<div class="empty">加载失败：' + esc(error.message) + '</div>'
      return
    }
    if (!data || data.length === 0) {
      wrap.innerHTML = '<div class="empty">还没有密钥，点上方「一键创建」生成第一个</div>'
      return
    }

    wrap.innerHTML =
      '<table><thead><tr><th>名称</th><th>密钥前缀</th><th>状态</th><th>调用次数</th><th>最后使用</th><th>操作</th></tr></thead><tbody>' +
      data.map((k) => {
        const on = k.status === 'active'
        return '<tr>' +
          '<td>' + esc(k.name) + '</td>' +
          '<td><code>' + esc(k.key_prefix) + '…</code></td>' +
          '<td><span class="badge ' + (on ? 'on' : 'off') + '">' + (on ? '启用' : '已禁用') + '</span></td>' +
          '<td>' + Number(k.call_count || 0) + '</td>' +
          '<td>' + (k.last_used_at ? new Date(k.last_used_at).toLocaleString('zh-CN') : '从未') + '</td>' +
          '<td>' +
            '<button class="btn-sm" data-act="toggle" data-id="' + k.id + '" data-status="' + (on ? 'disabled' : 'active') + '">' + (on ? '禁用' : '启用') + '</button> ' +
            '<button class="btn-sm danger" data-act="del" data-id="' + k.id + '">删除</button>' +
          '</td>' +
        '</tr>'
      }).join('') +
      '</tbody></table>'
  }

  $('keysTableWrap').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]')
    if (!btn) return
    const id = Number(btn.dataset.id)

    if (btn.dataset.act === 'toggle') {
      const { data, error } = await cloud.database
        .from('api_keys')
        .update({ status: btn.dataset.status })
        .eq('id', id)
        .select()
      if (error) return alert('操作失败：' + error.message)
      if (!data || data.length === 0) return alert('未改动任何行（可能不是你的密钥）')
      loadKeys()
    }

    if (btn.dataset.act === 'del') {
      if (!confirm('删除后该密钥立即失效，且不可恢复。确定删除？')) return
      const { data, error } = await cloud.database.from('api_keys').delete().eq('id', id).select()
      if (error) return alert('删除失败：' + error.message)
      if (!data || data.length === 0) return alert('未删除任何行（可能不是你的密钥）')
      loadKeys()
    }
  })

  $('createKey').addEventListener('click', async () => {
    const name = $('newKeyName').value.trim() || '未命名密钥'
    const btn = $('createKey')

    // 明文只在内存与本次展示中出现，入库的只有 SHA-256
    const plain = generateKey()
    const hash = await sha256Hex(plain)
    const prefix = plain.slice(0, 11)

    busy(btn, true, '创建中…')
    const { data, error } = await cloud.database
      .from('api_keys')
      .insert({ name, key_hash: hash, key_prefix: prefix })
      .select()
    busy(btn, false)

    if (error) {
      if (error.code === '23505') return alert('密钥冲突，请重试')
      return alert('创建失败：' + error.message)
    }
    if (!data || data.length === 0) return alert('创建失败：没有写入任何行')

    $('newKeyValue').textContent = plain
    // 直接给出可粘贴的请求地址：云端下请求头通道被平台代理占用，Key 必须走 URL 路径
    $('newKeyUrl').textContent = gwBase + '/' + plain
    $('newKeyBox').classList.remove('hidden')
    $('newKeyName').value = ''
    loadKeys()
  })

  $('copyNewKey').addEventListener('click', async () => {
    const text = $('newKeyValue').textContent
    try {
      await navigator.clipboard.writeText(text)
      $('copyNewKey').textContent = '已复制'
      setTimeout(() => { $('copyNewKey').textContent = '复制' }, 1500)
    } catch {
      alert('复制失败，请手动选中复制')
    }
  })

  $('copyNewKeyUrl').addEventListener('click', async () => {
    const text = $('newKeyUrl').textContent
    try {
      await navigator.clipboard.writeText(text)
      $('copyNewKeyUrl').textContent = '已复制'
      setTimeout(() => { $('copyNewKeyUrl').textContent = '复制' }, 1500)
    } catch {
      alert('复制失败，请手动选中复制')
    }
  })

  /* ============================ 上游配置 ============================ */

  async function loadUpstreams() {
    const wrap = $('upstreamsTableWrap')
    const { data, error } = await cloud.database
      .from('upstreams')
      .select('id, name, kind, base_url, api_keys, model, weight, enabled')
      .order('created_at', { ascending: false })

    if (error) {
      wrap.innerHTML = '<div class="empty">加载失败：' + esc(error.message) + '</div>'
      return
    }
    if (!data || data.length === 0) {
      wrap.innerHTML = '<div class="empty">还没有上游，先在上方添加一个模型服务</div>'
      return
    }

    wrap.innerHTML =
      '<table><thead><tr><th>名称</th><th>类型</th><th>目标</th><th>权重</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
      data.map((u) => {
        const builtin = u.kind === 'builtin'
        const keyCount = String(u.api_keys || '').split(',').filter((s) => s.trim()).length
        const target = builtin
          ? '模型 ' + esc(u.model || 'auto')
          : '<code>' + esc(u.base_url) + '</code> · ' + keyCount + ' 个 Key'
        return '<tr>' +
          '<td>' + esc(u.name) + '</td>' +
          '<td>' + (builtin
            ? '<span class="badge on">内置</span>'
            : '<span class="badge off">自定义</span>') + '</td>' +
          '<td>' + target + '</td>' +
          '<td>' + u.weight + '</td>' +
          '<td><span class="badge ' + (u.enabled ? 'on' : 'off') + '">' + (u.enabled ? '启用' : '停用') + '</span></td>' +
          '<td><button class="btn-sm danger" data-act="delup" data-id="' + u.id + '">删除</button></td>' +
        '</tr>'
      }).join('') +
      '</tbody></table>'
  }

  $('upstreamsTableWrap').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act="delup"]')
    if (!btn) return
    if (!confirm('确定删除这个上游？')) return
    const { data, error } = await cloud.database.from('upstreams').delete().eq('id', Number(btn.dataset.id)).select()
    if (error) return alert('删除失败：' + error.message)
    if (!data || data.length === 0) return alert('未删除任何行')
    loadUpstreams()
  })

  // 类型切换：内置模型只需模型名，自定义服务才要地址与 Key
  $('upKind').addEventListener('change', () => {
    const builtin = $('upKind').value === 'builtin'
    $('upBuiltinFields').classList.toggle('hidden', !builtin)
    $('upOpenaiFields').classList.toggle('hidden', builtin)
    if (builtin && !$('upName').value.trim()) $('upName').value = '内置模型'
  })

  $('addUpstream').addEventListener('click', async () => {
    const kind = $('upKind').value
    const name = $('upName').value.trim() || (kind === 'builtin' ? '内置模型' : '')
    const weight = Number($('upWeight').value) || 1
    const enabled = $('upEnabled').value === 'true'

    if (!name) return alert('请填写名称')

    const row = { name, kind, weight, enabled }

    if (kind === 'builtin') {
      // 内置模型走云服务 LLM，不需要地址和 Key
      row.model = $('upModel').value.trim() || null
    } else {
      let baseUrl = $('upBaseUrl').value.trim()
      const apiKeys = $('upKeys').value.trim()
      if (!/^https?:\/\//i.test(baseUrl)) return alert('Base URL 需以 http:// 或 https:// 开头')
      baseUrl = baseUrl.replace(/\/+$/, '')
      if (!apiKeys) return alert('请至少填写一个上游 API Key')
      row.base_url = baseUrl
      row.api_keys = apiKeys
    }

    const btn = $('addUpstream')
    busy(btn, true, '保存中…')
    const { data, error } = await cloud.database.from('upstreams').insert(row).select()
    busy(btn, false)

    if (error) return alert('保存失败：' + error.message)
    if (!data || data.length === 0) return alert('保存失败：没有写入任何行')

    $('upName').value = ''
    $('upModel').value = ''
    $('upBaseUrl').value = ''
    $('upKeys').value = ''
    $('upWeight').value = '1'
    loadUpstreams()
  })

  /* ============================ 可用模型 ============================ */

  async function loadModels() {
    const wrap = $('modelsTableWrap')
    let models = null
    try {
      models = await cloud.llm.models.list()
    } catch (e) {
      wrap.innerHTML = '<div class="empty">模型目录加载失败：' + esc(e?.error?.message || e.message) + '</div>'
      return
    }
    if (!Array.isArray(models) || models.length === 0) {
      wrap.innerHTML = '<div class="empty">模型目录为空</div>'
      return
    }

    wrap.innerHTML =
      '<table><thead><tr><th>名称</th><th>model id</th><th>上下文</th><th>能力</th></tr></thead><tbody>' +
      models.map((m) => {
        if (m.disabled === true) return ''
        const caps = [
          m.supportsImages === true ? '图片' : null,
          m.supportsToolCall === true ? '工具' : null,
          m.supportsReasoning === true ? '推理' : null,
        ].filter(Boolean).join(' / ') || '-'
        const ctx = m.maxInputTokens ? (m.maxInputTokens >= 1000 ? Math.round(m.maxInputTokens / 1000) + 'K' : m.maxInputTokens) : '-'
        return '<tr>' +
          '<td>' + esc(m.name || m.id) + '</td>' +
          '<td><code>' + esc(m.id) + '</code></td>' +
          '<td>' + ctx + '</td>' +
          '<td>' + caps + '</td>' +
        '</tr>'
      }).join('') +
      '</tbody></table>'
  }

  /* ============================ 用量 ============================ */

  async function loadUsage() {
    const wrap = $('usageTableWrap')
    const { data, error } = await cloud.database
      .from('usage_logs')
      .select('id, key_prefix, model, status, latency_ms, prompt_tokens, completion_tokens, upstream_name, created_at')
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) {
      wrap.innerHTML = '<div class="empty">加载失败：' + esc(error.message) + '</div>'
      return
    }
    if (!data || data.length === 0) {
      wrap.innerHTML = '<div class="empty">还没有调用记录</div>'
      return
    }

    wrap.innerHTML =
      '<table><thead><tr><th>时间</th><th>密钥</th><th>模型</th><th>状态</th><th>耗时</th><th>Tokens</th><th>上游</th></tr></thead><tbody>' +
      data.map((l) =>
        '<tr>' +
          '<td>' + new Date(l.created_at).toLocaleString('zh-CN') + '</td>' +
          '<td><code>' + esc(l.key_prefix || '-') + '</code></td>' +
          '<td>' + esc(l.model || '-') + '</td>' +
          '<td>' + (l.status >= 400
            ? '<span class="badge off">' + l.status + '</span>'
            : '<span class="badge on">' + (l.status || 200) + '</span>') + '</td>' +
          '<td>' + (l.latency_ms != null ? l.latency_ms + ' ms' : '-') + '</td>' +
          '<td>' + Number(l.prompt_tokens || 0) + ' / ' + Number(l.completion_tokens || 0) + '</td>' +
          '<td>' + esc(l.upstream_name || '-') + '</td>' +
        '</tr>'
      ).join('') +
      '</tbody></table>'
  }

  /* ============================ 侧栏导航 ============================ */

  document.querySelectorAll('.side button').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view))
  })

  /* ============================ 启动 ============================ */

  async function boot() {
    // 微信回调必须最先、无条件处理，且早于任何路由守卫 —— code 是一次性的
    try {
      const { data: session, error } = await cloud.auth.handleWechatWebCallback()
      if (error) {
        setAuthMsg(error.message || '微信登录失败', 'err')
      } else if (session) {
        // 成功后必须清掉 URL 上的 code/state，否则刷新会重放已消费的 code
        history.replaceState(null, '', location.pathname)
        return enterApp(session)
      }
    } catch (e) {
      setAuthMsg('登录回调处理异常：' + e.message, 'err')
    }

    // 普通启动
    const { data: session } = await cloud.auth.getSession()
    if (session) return enterApp(session)
    showAuthView()
  }

  boot()
})()

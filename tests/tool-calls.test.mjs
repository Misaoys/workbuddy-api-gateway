import test from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/worker.js'

const env = { CLOUD_ENDPOINT: 'https://fixture.example.com', CLOUD_PUBLISHABLE_KEY: 'wbpk_fixture_key' }
const key = 'sk-wb-' + 'a'.repeat(48)
const originalFetch = globalThis.fetch
let received
let chunks
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('/rpc/gateway_resolve')) return Response.json({ ok: true, upstreams: [{ kind: 'builtin', name: '测试', model: 'deepseek' }] })
  if (url.includes('/rpc/gateway_log')) return Response.json(null)
  if (url.endsWith('/chat/completions')) {
    received = JSON.parse(init.body)
    const data = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(data, { headers: { 'content-type': 'text/event-stream' } })
  }
  throw new Error(`Unexpected fetch ${url}`)
}
test.after(() => { globalThis.fetch = originalFetch })

const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] })
const toolChunks = () => [
  delta({ content: 'Checking.' }),
  delta({ tool_calls: [
    { index: 0, id: 'call_one', type: 'function', function: { name: 'skill', arguments: '{"name":' } },
    { index: 1, id: 'call_two', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
  ] }),
  delta({ tool_calls: [
    { index: 1, function: { arguments: '"E:\\\\中文.txt"}' } },
    { index: 0, function: { arguments: '"diagnose-windows-sandbox-acl"}' } },
  ] }, 'tool_calls'),
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
]
async function request(path, body) {
  return app.fetch(new Request(`https://gateway.test${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env)
}
const messages = [{ role: 'user', content: 'Check folder access using tools.' }]
const tools = [{ type: 'function', function: { name: 'skill', parameters: { type: 'object', properties: { name: { type: 'string' } } } } }]

test('OpenAI preserves tool schema, choices, history, sampling, and fragmented calls', async () => {
  chunks = toolChunks()
  const history = [
    ...messages, { role: 'assistant', content: null, tool_calls: [{ id: 'previous', type: 'function', function: { name: 'skill', arguments: '{"name":"probe"}' } }] },
    { role: 'tool', tool_call_id: 'previous', content: 'eval(x)' },
  ]
  const res = await request('/v1/chat/completions', { model: 'deepseek', messages: history, tools, tool_choice: 'required', parallel_tool_calls: false, max_tokens: 300, temperature: 0, stream: false })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(received.tools, tools)
  assert.equal(received.tool_choice, 'required')
  assert.equal(received.parallel_tool_calls, false)
  assert.equal(received.max_tokens, 300)
  assert.equal(received.temperature, 0)
  assert.deepEqual(received.messages[2].tool_calls, history[1].tool_calls)
  assert.equal(received.messages[2].content, null)
  assert.equal(received.messages[3].tool_call_id, 'previous')
  assert.match(received.messages[3].content, /base64/)
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  const calls = body.choices[0].message.tool_calls
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[0].function.arguments).name, 'diagnose-windows-sandbox-acl')
  assert.equal(JSON.parse(calls[1].function.arguments).path, 'E:\\中文.txt')
})

test('OpenAI streaming preserves native tool deltas', async () => {
  chunks = toolChunks()
  const res = await request('/v1/chat/completions', { model: 'deepseek', messages, tools, stream: true })
  const text = await res.text()
  assert.match(text, /"tool_calls"/)
  assert.match(text, /call_one/)
  assert.match(text, /data: \[DONE\]/)
})

const anthropicTools = [{ name: 'skill', description: 'Run skill', input_schema: tools[0].function.parameters }]
for (const stream of [false, true]) {
  test(`Anthropic tool round trip (${stream ? 'SSE' : 'JSON'})`, async () => {
    chunks = toolChunks()
    const input = { model: 'claude-sonnet', max_tokens: 300, stream, tools: anthropicTools,
      tool_choice: { type: 'tool', name: 'skill', disable_parallel_tool_use: true },
      system: [{ type: 'text', text: 'Use tools.' }], messages: [
        { role: 'user', content: 'Check access.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'previous', name: 'skill', input: { name: 'x'.repeat(500) } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'previous', content: [{ type: 'text', text: 'Done.' }] }, { type: 'text', text: 'Continue.' }] },
      ] }
    const res = await request('/v1/messages', input)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.equal(received.tools[0].function.name, 'skill')
    assert.deepEqual(received.tools[0].function.parameters, anthropicTools[0].input_schema)
    assert.equal(received.tool_choice, 'required')
    assert.equal(received.parallel_tool_calls, false)
    assert.equal(received.messages[2].tool_calls[0].function.arguments.length, 511)
    assert.equal(received.messages[3].role, 'tool')
    assert.equal(received.messages[3].tool_call_id, 'previous')
    assert.equal(received.messages[4].role, 'user')
    if (!stream) {
      const body = JSON.parse(text)
      assert.equal(body.stop_reason, 'tool_use')
      assert.equal(body.content[1].name, 'skill')
      assert.equal(body.content[1].input.name, 'diagnose-windows-sandbox-acl')
      assert.equal(body.content[2].name, 'read_file')
      assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 8 })
    } else {
      const events = text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\ndata: ')[1]))
      const starts = events.filter(e => e.type === 'content_block_start')
      assert.deepEqual(starts.map(e => e.content_block.type), ['text', 'tool_use', 'tool_use'])
      for (const start of starts) {
        assert.equal(events.filter(e => e.type === 'content_block_stop' && e.index === start.index).length, 1)
      }
      const args = events.find(e => e.delta?.type === 'input_json_delta')
      assert.equal(JSON.parse(args.delta.partial_json).name, 'diagnose-windows-sandbox-acl')
      assert.equal(events.at(-2).delta.stop_reason, 'tool_use')
      assert.equal(events.at(-1).type, 'message_stop')
    }
  })
}

test('Anthropic defaults to JSON and maps token limit stop reason', async () => {
  chunks = [delta({ content: 'Hello' }, 'length')]
  const res = await request('/v1/messages', { model: 'x', max_tokens: 1, messages })
  assert.match(res.headers.get('content-type'), /application\/json/)
  assert.equal((await res.json()).stop_reason, 'max_tokens')
})

test('Anthropic tool-only SSE starts at block zero and rejects invalid arguments', async () => {
  chunks = [delta({ tool_calls: [{ index: 0, id: 'call_one', function: { name: 'skill', arguments: '{"name":"probe"}' } }] }, 'tool_calls')]
  let res = await request('/v1/messages', { max_tokens: 100, messages, tools: anthropicTools, stream: true })
  let text = await res.text()
  assert.match(text, /"index":0,"content_block":\{"type":"tool_use"/)
  chunks = [delta({ tool_calls: [{ index: 0, id: 'call_one', function: { name: 'skill', arguments: '{broken' } }] }, 'tool_calls')]
  res = await request('/v1/messages', { max_tokens: 100, messages, tools: anthropicTools, stream: true })
  text = await res.text()
  assert.match(text, /event: error/)
  assert.doesNotMatch(text, /event: message_stop/)
})

test('Content parts remain structured and WAF encoding covers text parts', async () => {
  chunks = [delta({ content: 'OK' }, 'stop')]
  const content = [{ type: 'text', text: 'eval(x)' }, { type: 'image_url', image_url: { url: 'https://example.com/test.png' } }]
  const res = await request('/v1/chat/completions', { messages: [{ role: 'system', content }], stream: false })
  assert.equal(res.status, 200)
  assert.match(received.messages[0].content[0].text, /base64/)
  assert.deepEqual(received.messages[0].content[1], content[1])
})

test('Builtin named choice selects only that tool; none removes the tools', async () => {
  chunks = [delta({ content: 'OK' }, 'stop')]
  await request('/v1/chat/completions', { messages, tools: [...tools, { type: 'function', function: { name: 'other', parameters: { type: 'object' } } }], tool_choice: { type: 'function', function: { name: 'skill' } } })
  assert.equal(received.tool_choice, 'required')
  assert.deepEqual(received.tools, tools)
  await request('/v1/chat/completions', { messages, tools, tool_choice: 'none' })
  assert.equal(received.tools, undefined)
})

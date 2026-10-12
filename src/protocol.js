/** Native tool calls stay structured throughout the model/client round trip. */
export function anthropicRequest(parsed) {
  const messages = []
  const system = Array.isArray(parsed.system)
    ? parsed.system.map((b) => b.text || '').join('\n') : parsed.system
  if (system) messages.push({ role: 'system', content: system })
  for (const message of parsed.messages || []) {
    if (!Array.isArray(message.content)) {
      messages.push({ role: message.role, content: message.content })
      continue
    }
    let parts = []
    let calls = []
    const flush = () => {
      if (!parts.length && !calls.length) return
      const next = { role: message.role, content: parts.length ? parts : null }
      if (calls.length) next.tool_calls = calls
      messages.push(next)
      parts = []
      calls = []
    }
    for (const block of message.content) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text || '' })
      if (block.type === 'image') {
        const source = block.source || {}
        const url = source.type === 'base64'
          ? `data:${source.media_type};base64,${source.data}` : source.url
        if (url) parts.push({ type: 'image_url', image_url: { url } })
      }
      if (block.type === 'tool_use') calls.push({
        id: block.id, type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
      if (block.type === 'tool_result') {
        flush()
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id,
          content: typeof block.content === 'string' ? block.content
            : (block.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n') })
      }
    }
    flush()
  }
  const out = { messages }
  for (const key of ['max_tokens', 'temperature', 'top_p']) {
    if (parsed[key] !== undefined) out[key] = parsed[key]
  }
  if (parsed.stop_sequences !== undefined) out.stop = parsed.stop_sequences
  if (parsed.tools !== undefined) out.tools = parsed.tools.map((tool) => ({
    type: 'function', function: { name: tool.name, description: tool.description,
      parameters: tool.input_schema },
  }))
  const choice = parsed.tool_choice
  if (choice?.type === 'tool') out.tool_choice = { type: 'function', function: { name: choice.name } }
  else if (choice?.type === 'any') out.tool_choice = 'required'
  else if (choice?.type) out.tool_choice = choice.type
  if (choice?.disable_parallel_tool_use !== undefined) out.parallel_tool_calls = !choice.disable_parallel_tool_use
  return out
}

export class ToolCalls {
  calls = new Map()
  add(deltas = []) {
    for (const delta of deltas) {
      const index = delta.index ?? 0
      let call = this.calls.get(index)
      if (!call) {
        call = { id: '', type: 'function', function: { name: '', arguments: '' } }
        this.calls.set(index, call)
      }
      if (delta.id) call.id += delta.id
      if (delta.function?.name) call.function.name += delta.function.name
      if (delta.function?.arguments) call.function.arguments += delta.function.arguments
    }
  }
  values() { return [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) }
  blocks() {
    return this.values().map((call) => {
      if (!call.id || !call.function.name) throw new Error('Incomplete upstream tool call')
      const input = JSON.parse(call.function.arguments || '{}')
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid upstream tool arguments')
      return { type: 'tool_use', id: call.id, name: call.function.name, input }
    })
  }
}

export function anthropicStop(finish, hasTools) {
  if (finish === 'length') return 'max_tokens'
  return hasTools || finish === 'tool_calls' ? 'tool_use' : 'end_turn'
}

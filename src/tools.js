// Ported from functions.py: tool-call parsing utilities and StreamToolParser.

const TOOL_END_TAG_RE = new RegExp(
  '</[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*(?:tool_calls?|calls|invoke|function_call)\\s*>',
  'i'
);
const STREAM_ENTRY_RE = new RegExp(
  '<[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*(tool_calls?|calls|function_call|invoke)\\b[^>]*>',
  'i'
);
const ORPHAN_CLOSER_RE = new RegExp(
  '</[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*(?:tool_calls?|calls|function_call|invoke)\\s*[\\|｜]{0,2}>',
  'gi'
);
const STREAM_ENTRY_TAGS = ['tool_calls', 'tool_call', 'function_call', 'invoke', 'calls'];

function normalizeToolCall(toolDataOrName, argsIfName = null) {
  let name, args;
  if (typeof toolDataOrName === 'string') {
    name = toolDataOrName;
    args = argsIfName != null ? argsIfName : {};
  } else if (toolDataOrName && typeof toolDataOrName === 'object') {
    const toolData = toolDataOrName;
    if (toolData.function && typeof toolData.function === 'object') {
      const fn = toolData.function;
      name = fn.name || toolData.name;
      args = fn.arguments ?? fn.parameters ?? fn.input ?? fn.args ?? fn.params ?? {};
    } else {
      name = toolData.name || toolData.tool || toolData.tool_name || toolData.function || toolData.action;
      args = toolData.arguments ?? toolData.parameters ?? toolData.input ?? toolData.args ?? toolData.params ?? toolData.tool_input ?? toolData.action_input ?? {};
    }
  } else {
    return null;
  }
  if (!name || typeof name !== 'string') return null;
  let argsStr;
  if (args && (typeof args === 'object')) {
    argsStr = JSON.stringify(args);
  } else if (typeof args === 'string') {
    argsStr = args;
    try { JSON.parse(argsStr); } catch { argsStr = JSON.stringify(argsStr); }
  } else {
    argsStr = JSON.stringify({});
  }
  return {
    id: 'call_' + randomCallSuffix(),
    type: 'function',
    function: { name: name.trim(), arguments: argsStr },
  };
}

function randomCallSuffix() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function cleanJsonStr(s) {
  s = s.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}

function codeFenceSpans(text) {
  const spans = [];
  const re = /```[\s\S]*?(?:```|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

function parseTools(text) {
  const tools = [];
  let cleanText = text;
  const fenceSpans = codeFenceSpans(text);
  const fenced = (pos) => fenceSpans.some(([s, e]) => s <= pos && pos < e);

  const paramNames = new Set(['command', 'description', 'file_path', 'content', 'path', 'prompt', 'query', 'subject', 'old_string', 'new_string', 'url', 'input']);
  const toolMatches = [...text.matchAll(/<[\|｜]{0,2}(?:DSML[\|｜]{0,2})?\s*(?:tool_call|invoke|function_call)\s+(?:name|tool)=['"]([^'"]+)['"][^>]*>/gi)];
  const realToolMatches = toolMatches.filter((m) => !fenced(m.index));

  const bar = '[\\|｜]{0,2}';
  if (realToolMatches.length) {
    for (let i = 0; i < realToolMatches.length; i++) {
      const tm = realToolMatches[i];
      const candidateName = tm[1].trim();
      const startIdx = tm.index + tm[0].length;
      const endIdx = i + 1 < realToolMatches.length ? realToolMatches[i + 1].index : text.length;
      const body = text.slice(startIdx, endIdx);
      const args = {};
      const pRe = new RegExp(
        '<[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*(?:parameter|tool_call|param|invoke)\\s+name=[\'"]([^\'"]+)[\'"][^>]*>([\\s\\S]*?)(?:</[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*(?:parameter|tool_call|param|invoke)>|(?=<[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*(?:parameter|tool_call|param|invoke)\\s+name=)|$)',
        'gi'
      );
      let pm;
      while ((pm = pRe.exec(body)) !== null) {
        const pName = pm[1].trim();
        let pVal = pm[2].trim();
        pVal = pVal.replace(/<\/?(?:tool_calls?|invoke|function_call|parameter|param)\b[^>]*>/gi, '').trim();
        try { args[pName] = JSON.parse(pVal); } catch { args[pName] = pVal; }
      }
      const tagParamRe = /<([A-Za-z0-9_\-]+)>([\s\S]*?)(?:<\/\1>|$)/gi;
      while ((pm = tagParamRe.exec(body)) !== null) {
        const tName = pm[1].trim().toLowerCase();
        if (paramNames.has(tName)) {
          let tVal = pm[2].trim();
          tVal = tVal.replace(/<\/?(?:tool_calls?|invoke|function_call|parameter|param)\b[^>]*>/gi, '').trim();
          try { args[tName] = JSON.parse(tVal); } catch { args[tName] = tVal; }
        }
      }
      if (candidateName) {
        const norm = normalizeToolCall(candidateName, args);
        if (norm) tools.push(norm);
      }
    }
  }

  if (tools.length) {
    cleanText = cleanText.replace(new RegExp('<[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*(?:tool_calls?|calls)[^>]*>[\\s\\S]*?(?:</[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*(?:tool_calls?|calls)>|$)', 'gi'), '').trim();
    cleanText = cleanText.replace(new RegExp('<[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*(?:invoke|function_call)[^>]*>[\\s\\S]*?(?:</[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*(?:invoke|function_call)>|$)', 'gi'), '').trim();
  }

  if (!tools.length && text.includes('DSML')) {
    const dsmlBlockPattern = new RegExp('<[\\|｜]{2}DSML[\\|｜]{2}([A-Za-z0-9_]+)>([\\s\\S]*?)(?:</[\\|｜]{2}DSML[\\|｜]{2}\\1>|$)', 'gi');
    const paramPatternB = new RegExp('<[\\|｜]{2}DSML[\\|｜]{2}B([A-Za-z0-9_]+)[^>]*>([\\s\\S]*?)(?:</[\\|｜]{2}DSML[\\|｜]{2}B.*?>|$)', 'gi');
    let m;
    while ((m = dsmlBlockPattern.exec(text)) !== null) {
      if (fenced(m.index)) continue;
      const toolName = m[1].trim();
      const body = m[2];
      const args = {};
      let pm;
      while ((pm = paramPatternB.exec(body)) !== null) {
        const pName = pm[1].toLowerCase().trim();
        const pVal = pm[2].trim();
        try { args[pName] = JSON.parse(pVal); } catch { args[pName] = pVal; }
      }
      const norm = normalizeToolCall(toolName, args);
      if (norm) tools.push(norm);
    }
    if (!tools.length) {
      const toolMatch = /[\\|｜]{2}DSML[\\|｜]{2}(Bash|Read|Write|Edit|Agent|TaskList|TaskCreate|WebSearch|[A-Za-z0-9_]+)/i.exec(text);
      if (toolMatch && !fenced(toolMatch.index)) {
        const candidate = toolMatch[1].trim();
        const toolName = candidate.toLowerCase().startsWith('b') && !['bdescription', 'bparam'].includes(candidate.toLowerCase()) ? 'Bash' : candidate;
        const args = {};
        const cmdMatch = /[\\|｜]{2}B["']?command["']?[^>]*>([\s\S]*?)(?:<\/[\\|｜]{2}B|$)/i.exec(text);
        const descMatch = /[\\|｜]{2}B["']?description["']?[^>]*>([\s\S]*?)(?:<\/[\\|｜]{2}B|$)/i.exec(text);
        if (cmdMatch) {
          args.command = cmdMatch[1].replace(/<\/?[\\|｜]{2}DSML[\\|｜]{2}[^>]*>/g, '').replace(/^["'() ]+|["'() ]+$/g, '');
        }
        if (descMatch) {
          args.description = descMatch[1].replace(/<\/?[\\|｜]{2}DSML[\\|｜]{2}[^>]*>/g, '').replace(/^["'() ]+|["'() ]+$/g, '');
        }
        const norm = normalizeToolCall(toolName, args);
        if (norm) tools.push(norm);
      }
    }
    if (tools.length) {
      cleanText = cleanText.replace(new RegExp('<[\\|｜]{2}DSML[\\|｜]{2}[^>]*>[\\s\\S]*?(?:</[\\|｜]{2}DSML[\\|｜]{2}[^>]*>|$)', 'gi'), '').trim();
      cleanText = cleanText.replace(new RegExp('</?[\\|｜]{2}DSML[\\|｜]{2}[^>]*>', 'gi'), '').trim();
    }
  }

  if (!tools.length) {
    const fnCallPattern = /<function_call>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/function_call>/gi;
    let m;
    while ((m = fnCallPattern.exec(text)) !== null) {
      if (fenced(m.index)) continue;
      const name = m[1].trim();
      const argsRaw = m[2].trim();
      let args;
      try { args = JSON.parse(argsRaw); } catch { args = argsRaw; }
      const norm = normalizeToolCall(name, args);
      if (norm) tools.push(norm);
    }
    if (tools.length) cleanText = cleanText.replace(/<function_call>[\s\S]*?<\/function_call>/gi, '').trim();
  }

  if (!tools.length) {
    const tagRegex = /<(?:tool_call|function_call)(?:\s+(?:name|tool|function)=['"]([^'"]+)['"])?\s*>/gi;
    let m;
    const matches = [];
    while ((m = tagRegex.exec(text)) !== null) if (!fenced(m.index)) matches.push(m);
    if (matches.length) {
      for (const m of matches) {
        const tagName = m[1];
        const afterTag = text.slice(m.index + m[0].length);
        const bracePos = afterTag.indexOf('{');
        if (bracePos !== -1) {
          const jsonSubstr = afterTag.slice(bracePos);
          let data = null;
          try {
            const parsed = tryRawDecode(jsonSubstr);
            data = parsed.value;
          } catch (_) {}
          if (!data) {
            let cleanedJson = jsonSubstr.replace(/<\/?(?:tool_call|function_call|tool_calls|invoke)[^>]*>[\s\S]*/, '').trim();
            const openB = (cleanedJson.match(/\{/g) || []).length;
            const closeB = (cleanedJson.match(/\}/g) || []).length;
            if (openB > closeB) cleanedJson += '}'.repeat(openB - closeB);
            try { data = JSON.parse(cleanedJson); } catch (_) {}
          }
          if (data && typeof data === 'object') {
            let name, args;
            if (tagName) {
              name = tagName;
              if (data.arguments && typeof data.arguments === 'object') args = data.arguments;
              else if (data.parameters && typeof data.parameters === 'object') args = data.parameters;
              else if (data.input && typeof data.input === 'object') args = data.input;
              else {
                args = {};
                for (const k of Object.keys(data)) if (!['name', 'tool', 'function'].includes(k)) args[k] = data[k];
              }
            } else {
              name = data.name || data.tool || data.tool_name || data.function || data.action;
              args = data.arguments ?? data.parameters ?? data.input ?? data.args ?? data.params ?? data.tool_input ?? data.action_input;
              if (args == null) args = {};
            }
            if (name) {
              const norm = normalizeToolCall(name, args);
              if (norm) tools.push(norm);
            }
          }
        }
      }
      cleanText = cleanText.replace(/<(?:tool_call|function_call)[^>]*>[\s\S]*?(?:<\/(?:tool_call|function_call)>|$)/gi, '').trim();
    }
  }

  if (!tools.length) {
    const codeblockPattern = /```(?:tool_call|function_call)\s*([\s\S]*?)\s*```/g;
    let m;
    while ((m = codeblockPattern.exec(cleanText)) !== null) {
      const cleaned = cleanJsonStr(m[1]);
      try {
        const data = JSON.parse(cleaned);
        if (data && typeof data === 'object') {
          const name = data.name || data.tool || data.function || data.action;
          const args = data.arguments ?? data.parameters ?? data.input ?? data.args ?? {};
          const norm = normalizeToolCall(name, args);
          if (norm) tools.push(norm);
        }
      } catch (_) {}
    }
    if (tools.length) cleanText = cleanText.replace(/```(?:tool_call|function_call)\s*[\s\S]*?\s*```/g, '').trim();
  }

  if (!tools.length) {
    const jsonPattern = /```json\s*(\{[\s\S]*?\})\s*```/g;
    let m;
    while ((m = jsonPattern.exec(cleanText)) !== null) {
      const cleaned = cleanJsonStr(m[1]);
      try {
        const data = JSON.parse(cleaned);
        if (data && typeof data === 'object' && ('name' in data || 'tool' in data || 'function' in data)) {
          const name = data.name || data.tool || data.function || data.action;
          const args = data.arguments ?? data.parameters ?? data.input ?? data.args ?? {};
          const norm = normalizeToolCall(name, args);
          if (norm) tools.push(norm);
        }
      } catch (_) {}
    }
    if (tools.length) cleanText = cleanText.replace(/```json\s*\{[\s\S]*?\}\s*```/g, '').trim();
  }

  cleanText = cleanText.replace(/<\/?[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\s*(?:tool_calls?|calls|invoke|function_call|parameter)[^>]*>/gi, '').trim();
  return [tools, cleanText];
}

// JSONDecoder().raw_decode equivalent
function tryRawDecode(str) {
  const { end } = rawDecodeIndex(str);
  return { value: JSON.parse(str.slice(0, end)) };
}

function skipBars(text, pos) {
  for (let i = 0; i < 2; i++) {
    if (pos < text.length && (text[pos] === '|' || text[pos] === '｜')) pos += 1;
  }
  return pos;
}

function isPlausibleStreamEntryPrefix(segment) {
  if (!segment.startsWith('<') || segment.includes('>')) return false;
  const body = segment.slice(1);
  let pos = skipBars(body, 0);
  const length = body.length;
  if (pos < length && (body[pos] === 'D' || body[pos] === 'd')) {
    let matched = 0;
    while (matched < 4 && pos < length && body[pos].toUpperCase() === 'DSML'[matched]) { pos += 1; matched += 1; }
    if (matched < 4) return pos === length;
    pos = skipBars(body, pos);
  }
  while (pos < length && /\s/.test(body[pos])) pos += 1;
  if (pos === length) return true;
  const remainder = body.slice(pos).toLowerCase();
  for (const tag of STREAM_ENTRY_TAGS) {
    if (tag.startsWith(remainder)) return true;
    if (remainder.startsWith(tag)) {
      const suffix = remainder.slice(tag.length);
      if (!suffix || !(/[a-z0-9_]/i.test(suffix[0]))) return true;
    }
  }
  return false;
}

function isPlausibleStreamCloserPrefix(segment) {
  return segment.startsWith('</') && isPlausibleStreamEntryPrefix('<' + segment.slice(2));
}

class StreamToolParser {
  constructor() {
    this.buffer = '';
    this.inTool = false;
    this.hasTool = false;
    this.jsonDone = false;
    this.endRe = null;
  }

  feed(chunk) {
    this.buffer += chunk;
    const results = [];
    for (;;) {
      if (this.inTool) {
        let endMatch = this.endRe ? matchFirst(this.endRe, this.buffer) : null;
        if (endMatch == null) endMatch = matchFirst(TOOL_END_TAG_RE, this.buffer);
        if (endMatch != null) {
          if (!this.jsonDone) {
            const toolXml = this.buffer.slice(0, endMatch);
            const [parsed] = parseTools(toolXml);
            for (const item of parsed) results.push({ tool: item });
          }
          this.buffer = this.buffer.slice(endMatch);
          // endMatch must include the matched closer; adjust:
          this.inTool = false;
          this.jsonDone = false;
          this.endRe = null;
          continue;
        }
        const braceIdx = this.buffer.indexOf('{');
        if (braceIdx !== -1 && !this.jsonDone) {
          try {
            const parsed = tryRawDecode(this.buffer.slice(braceIdx));
            const norm = normalizeToolCall(parsed.value);
            if (norm) {
              results.push({ tool: norm });
              this.jsonDone = true;
              // consume up to end of the JSON object
              this.buffer = consumeJsonPrefix(this.buffer, braceIdx);
              continue;
            }
          } catch (_) {}
        }
        break;
      } else {
        const m = STREAM_ENTRY_RE.exec(this.buffer);
        STREAM_ENTRY_RE.lastIndex = 0;
        if (m) {
          const start = m.index;
          if (start > 0) results.push({ text: this.buffer.slice(0, start).replace(new RegExp(ORPHAN_CLOSER_RE.source, 'g'), '') });
          this.buffer = this.buffer.slice(start);
          const tagName = m[1].toLowerCase();
          this.endRe = new RegExp('</[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\\s*' + tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\|｜]{0,2}\\s*>', 'i');
          this.inTool = true;
          this.hasTool = true;
          continue;
        }
        const lastLt = this.buffer.lastIndexOf('<');
        const tail = lastLt !== -1 ? this.buffer.slice(lastLt) : '';
        const hold = !tail.includes('>') && (isPlausibleStreamEntryPrefix(tail) || isPlausibleStreamCloserPrefix(tail));
        if (lastLt !== -1 && hold) {
          if (lastLt > 0) results.push({ text: this.buffer.slice(0, lastLt).replace(new RegExp(ORPHAN_CLOSER_RE.source, 'g'), '') });
          this.buffer = tail;
          break;
        }
        if (this.buffer) results.push({ text: this.buffer.replace(new RegExp(ORPHAN_CLOSER_RE.source, 'g'), '') });
        this.buffer = '';
        break;
      }
    }
    return results;
  }

  flush() {
    const out = [];
    if (this.buffer && !this.inTool) {
      out.push({ text: this.buffer });
    } else if (this.inTool) {
      const [parsed] = parseTools(this.buffer);
      if (parsed.length) {
        for (const item of parsed) out.push({ tool: item });
      } else if (!this.jsonDone) {
        const stripped = this.buffer.replace(/<\/?[\\|｜]{0,2}(?:DSML[\\|｜]{0,2})?\s*(?:tool_calls?|calls|invoke|function_call|parameter)[^>]*>/gi, '').trim();
        if (stripped) out.push({ text: stripped });
      }
    }
    this.buffer = '';
    this.inTool = false;
    this.jsonDone = false;
    this.endRe = null;
    return out;
  }
}

// Returns the END index (exclusive) of the first match of re in text, or null.
function matchFirst(re, text) {
  const flags = re.flags.replace('g', '');
  const m = new RegExp(re.source, flags).exec(text);
  return m ? m.index + m[0].length : null;
}

function consumeJsonPrefix(buffer, braceIdx) {
  // Remove the JSON object that starts at braceIdx; return the remainder.
  try {
    const { end } = rawDecodeIndex(buffer.slice(braceIdx));
    return buffer.slice(braceIdx + end);
  } catch (_) {
    return buffer;
  }
}

function rawDecodeIndex(str) {
  const trimmed = str.replace(/^\s*/, '');
  if (!trimmed) throw new Error('raw_decode failed');
  const braceMatch = /^[{[]/.exec(trimmed);
  if (braceMatch) {
    let inStr = false;
    let esc = false;
    const stack = [];
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' && stack[stack.length - 1] === '{') stack.pop();
      else if (c === ']' && stack[stack.length - 1] === '[') stack.pop();
      if (stack.length === 0) {
        const candidate = trimmed.slice(0, i + 1);
        try {
          JSON.parse(candidate);
          const offset = str.length - trimmed.length;
          return { end: offset + i + 1 };
        } catch (_) {}
      }
    }
    throw new Error('raw_decode failed');
  }
  if (trimmed[0] === '"') {
    let esc = false;
    for (let i = 1; i < trimmed.length; i++) {
      if (esc) esc = false;
      else if (trimmed[i] === '\\') esc = true;
      else if (trimmed[i] === '"') {
        const candidate = trimmed.slice(0, i + 1);
        try { JSON.parse(candidate); return { end: (str.length - trimmed.length) + i + 1 }; } catch (_) {}
      }
    }
    throw new Error('raw_decode failed');
  }
  const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(trimmed);
  if (m) return { end: (str.length - trimmed.length) + m[1].length };
  throw new Error('raw_decode failed');
}

module.exports = { parseTools, normalizeToolCall, cleanJsonStr, codeFenceSpans, StreamToolParser };

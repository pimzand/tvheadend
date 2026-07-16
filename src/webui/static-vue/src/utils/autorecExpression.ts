// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tvheadend contributors

/*
 * Span-aware JSONC support for the smart autorec expression editor.
 *
 * The server stores the expression as raw JSONC text and is the only
 * validation authority (`api/dvr/autorec/preview` returns its parse
 * errors verbatim). This module does the minimum the editor needs on
 * top of that: a structural parse that keeps source offsets, so the
 * tree panel can render branches and flip a branch's `"skip"` marker
 * with a minimal text edit that leaves everything else — comments
 * included — byte-for-byte intact. Semantic checks (leaf names, value
 * forms) are deliberately NOT duplicated here; a structurally sound
 * but semantically wrong expression surfaces its real server error
 * through the preview action.
 */

export interface ExprNode {
  /* the node's single operator or leaf key ('' while broken) */
  key: string
  /* true when the node carries `"skip": true` */
  skip: boolean
  /* children for all / any / not; empty for leaves */
  children: ExprNode[]
  /* compact raw text of a leaf's value, for the tree row */
  valueText: string
  /* [start, end) span of the node object in the source text */
  start: number
  end: number
  /* skip-member spans, -1 when the node has no skip member. The
   * value span is replaced on toggle-on; the member span (plus the
   * separating comma) is removed on toggle-off. */
  skipKeyStart: number
  skipValueStart: number
  skipValueEnd: number
  skipPrecedingComma: number
  skipFollowingCommaEnd: number
  /* end of the last member's value: the insert point for a new
   * skip member (before any trailing comments in the object) */
  lastMemberEnd: number
}

export interface ExprParse {
  root: ExprNode | null
  error: string | null
  /* offset of the error in the source, for line/col display */
  errorOffset: number
  /* the whole tree prunes away after resolving skips: the rule is
   * valid and matches nothing (mirrors the server semantics) */
  matchesNothing: boolean
}

const OPERATORS = new Set(['all', 'any', 'not'])

class ParseError extends Error {
  offset: number
  constructor(message: string, offset: number) {
    super(message)
    this.offset = offset
  }
}

interface Cursor {
  text: string
  pos: number
}

/* Advance past whitespace and JSONC comments. */
function skipBlank(c: Cursor): void {
  const t = c.text
  for (;;) {
    while (c.pos < t.length && /\s/.test(t[c.pos]!)) c.pos++
    if (t.startsWith('//', c.pos)) {
      while (c.pos < t.length && t[c.pos] !== '\n') c.pos++
      continue
    }
    if (t.startsWith('/*', c.pos)) {
      const end = t.indexOf('*/', c.pos + 2)
      if (end < 0) throw new ParseError('unterminated /* comment', c.pos)
      c.pos = end + 2
      continue
    }
    return
  }
}

function expect(c: Cursor, ch: string): void {
  if (c.text[c.pos] !== ch)
    throw new ParseError(`expected "${ch}"`, c.pos)
  c.pos++
}

function parseString(c: Cursor): string {
  const t = c.text
  expect(c, '"')
  let out = ''
  while (c.pos < t.length) {
    const ch = t[c.pos]!
    if (ch === '"') {
      c.pos++
      return out
    }
    if (ch === '\\') {
      /* decoded only far enough for key comparison; the editor never
       * re-emits decoded strings */
      const esc = t[c.pos + 1]
      if (esc === undefined) break
      out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc
      c.pos += 2
      continue
    }
    out += ch
    c.pos++
  }
  throw new ParseError('unterminated string', c.pos)
}

/* Skip any JSON value, tracking nesting; returns nothing — the caller
 * only needs the cursor to land past it. */
function skipValue(c: Cursor): void {
  skipBlank(c)
  const ch = c.text[c.pos]
  if (ch === undefined) throw new ParseError('unexpected end of text', c.pos)
  if (ch === '"') {
    parseString(c)
    return
  }
  if (ch === '{' || ch === '[') {
    const close = ch === '{' ? '}' : ']'
    c.pos++
    for (;;) {
      skipBlank(c)
      const n = c.text[c.pos]
      if (n === undefined)
        throw new ParseError('unterminated value', c.pos)
      if (n === close) {
        c.pos++
        return
      }
      if (n === ',' || n === ':') {
        c.pos++
        continue
      }
      skipValue(c)
    }
  }
  /* literal: number, true, false, null */
  const start = c.pos
  while (c.pos < c.text.length && /[-+.\w]/.test(c.text[c.pos]!)) c.pos++
  if (c.pos === start)
    throw new ParseError('expected a value', c.pos)
}

/* Collapse a raw value slice for one-line tree display. */
function compact(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > 48 ? s.slice(0, 45) + '…' : s
}

function parseNode(c: Cursor): ExprNode {
  skipBlank(c)
  const start = c.pos
  if (c.text[c.pos] !== '{')
    throw new ParseError('expected a node object', c.pos)
  c.pos++

  const node: ExprNode = {
    key: '',
    skip: false,
    children: [],
    valueText: '',
    start,
    end: -1,
    skipKeyStart: -1,
    skipValueStart: -1,
    skipValueEnd: -1,
    skipPrecedingComma: -1,
    skipFollowingCommaEnd: -1,
    lastMemberEnd: -1,
  }
  let keyCount = 0
  let lastComma = -1

  for (;;) {
    skipBlank(c)
    if (c.text[c.pos] === '}') {
      c.pos++
      node.end = c.pos
      break
    }
    if (keyCount > 0 || node.skipKeyStart >= 0) {
      if (c.text[c.pos] !== ',')
        throw new ParseError('expected "," or "}"', c.pos)
      lastComma = c.pos
      c.pos++
      skipBlank(c)
      /* tolerate a trailing comma the way lenient JSONC readers do
       * not — the server's parser is strict JSON after comment
       * stripping, so mirror it */
      if (c.text[c.pos] === '}')
        throw new ParseError('trailing comma before "}"', c.pos)
    }
    const keyStart = c.pos
    const key = parseString(c)
    skipBlank(c)
    expect(c, ':')
    skipBlank(c)

    if (key === 'skip') {
      node.skipKeyStart = keyStart
      node.skipPrecedingComma = lastComma
      node.skipValueStart = c.pos
      skipValue(c)
      node.skipValueEnd = c.pos
      const raw = c.text.slice(node.skipValueStart, node.skipValueEnd)
      if (raw !== 'true' && raw !== 'false')
        throw new ParseError('"skip" must be true or false',
                             node.skipValueStart)
      node.skip = raw === 'true'
      node.lastMemberEnd = Math.max(node.lastMemberEnd, c.pos)
      /* remember a following comma so removing a first-member skip
       * can take the comma with it */
      const save = c.pos
      skipBlank(c)
      node.skipFollowingCommaEnd = c.text[c.pos] === ',' ? c.pos + 1 : -1
      c.pos = save
      continue
    }

    keyCount++
    if (keyCount > 1)
      throw new ParseError(
        'a node must hold exactly one operator or leaf', keyStart)
    node.key = key

    if (key === 'all' || key === 'any') {
      skipBlank(c)
      if (c.text[c.pos] !== '[')
        throw new ParseError(`"${key}" must hold an array of nodes`, c.pos)
      c.pos++
      for (;;) {
        skipBlank(c)
        if (c.text[c.pos] === ']') {
          c.pos++
          break
        }
        if (node.children.length > 0) {
          if (c.text[c.pos] !== ',')
            throw new ParseError('expected "," or "]"', c.pos)
          c.pos++
        }
        skipBlank(c)
        if (c.text[c.pos] === ']')
          throw new ParseError('trailing comma before "]"', c.pos)
        node.children.push(parseNode(c))
      }
    } else if (key === 'not') {
      node.children.push(parseNode(c))
    } else {
      const vStart = c.pos
      skipValue(c)
      node.valueText = compact(c.text.slice(vStart, c.pos))
    }
    node.lastMemberEnd = Math.max(node.lastMemberEnd, c.pos)
  }

  if (keyCount === 0)
    throw new ParseError('a node must hold an operator or leaf', start)
  return node
}

/* skip pruning: does the tree survive after skips resolve? */
function survives(node: ExprNode): boolean {
  if (node.skip) return false
  if (!OPERATORS.has(node.key)) return true
  return node.children.some(survives)
}

export function parseExpression(text: string): ExprParse {
  const c: Cursor = { text, pos: 0 }
  try {
    skipBlank(c)
    if (c.pos >= text.length)
      return { root: null, error: null, errorOffset: -1,
               matchesNothing: false }
    const root = parseNode(c)
    skipBlank(c)
    if (c.pos < text.length)
      throw new ParseError('unexpected trailing text', c.pos)
    return {
      root,
      error: null,
      errorOffset: -1,
      matchesNothing: !root.skip && !survives(root),
    }
  } catch (e) {
    if (e instanceof ParseError)
      return { root: null, error: e.message, errorOffset: e.offset,
               matchesNothing: false }
    throw e
  }
}

/*
 * Flip a node's skip marker with a minimal text edit. `node` must
 * come from a parseExpression() run over exactly this `text`.
 */
export function toggleSkip(text: string, node: ExprNode,
                           on: boolean): string {
  if (on) {
    if (node.skipValueStart >= 0)
      return text.slice(0, node.skipValueStart) + 'true' +
             text.slice(node.skipValueEnd)
    return text.slice(0, node.lastMemberEnd) + ', "skip": true' +
           text.slice(node.lastMemberEnd)
  }
  if (node.skipKeyStart < 0) return text
  /* remove the whole member: prefer taking the preceding comma;
   * a first-member skip takes the following comma instead */
  if (node.skipPrecedingComma >= 0)
    return text.slice(0, node.skipPrecedingComma) +
           text.slice(node.skipValueEnd)
  const end = node.skipFollowingCommaEnd >= 0
    ? node.skipFollowingCommaEnd : node.skipValueEnd
  return text.slice(0, node.skipKeyStart) + text.slice(end)
}

/* Line/column for an error offset, 1-based, for the editor's
 * error line. */
export function offsetToLineCol(text: string,
                                offset: number): { line: number; col: number } {
  let line = 1
  let col = 1
  const n = Math.max(0, Math.min(offset, text.length))
  for (let i = 0; i < n; i++) {
    if (text[i] === '\n') {
      line++
      col = 1
    } else {
      col++
    }
  }
  return { line, col }
}

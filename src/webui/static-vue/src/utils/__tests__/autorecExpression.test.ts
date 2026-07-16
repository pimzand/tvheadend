// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tvheadend contributors

import { describe, expect, it } from 'vitest'
import {
  parseExpression,
  toggleSkip,
  offsetToLineCol,
} from '../autorecExpression'

/* The RFC example shape: nested any/all with a skipped branch and
 * comments — the round-trip fixture for everything below. */
const RFC = `{
  "all": [
    { "any": [
      { "all": [ { "tag": { "uuid": "abcd", "name": "Documentaries" } },
                 { "title": "polar bears" } ] },
      // too many repeats on this one
      { "all": [ { "channel": { "uuid": "ef01", "name": "Nature+1" } },
                 { "title": "bears" } ],
        "skip": true }
    ] },
    // never record from a "+1" channel
    { "not": { "channel_pattern": "\\\\+1$" } }
  ]
}`

describe('parseExpression', () => {
  it('parses the RFC example into the right tree shape', () => {
    const p = parseExpression(RFC)
    expect(p.error).toBeNull()
    expect(p.root?.key).toBe('all')
    expect(p.root?.children).toHaveLength(2)
    const any = p.root!.children[0]!
    expect(any.key).toBe('any')
    expect(any.children).toHaveLength(2)
    expect(any.children[0]!.skip).toBe(false)
    expect(any.children[1]!.skip).toBe(true)
    const not = p.root!.children[1]!
    expect(not.key).toBe('not')
    expect(not.children[0]!.key).toBe('channel_pattern')
  })

  it('summarizes leaf values compactly', () => {
    const p = parseExpression('{ "title": "polar" }')
    expect(p.root?.key).toBe('title')
    expect(p.root?.valueText).toBe('"polar"')
  })

  it('treats an empty text as no expression, not an error', () => {
    const p = parseExpression('   ')
    expect(p.root).toBeNull()
    expect(p.error).toBeNull()
  })

  it('rejects two operative keys with an offset', () => {
    const p = parseExpression('{ "title": "x", "year": { "min": 2 } }')
    expect(p.error).toContain('exactly one')
    expect(p.errorOffset).toBeGreaterThan(0)
  })

  it('rejects a keyless node and trailing text', () => {
    expect(parseExpression('{}').error).toBeTruthy()
    expect(parseExpression('{ "title": "x" } garbage').error)
      .toContain('trailing')
  })

  it('accepts skip: false as a no-op marker', () => {
    const p = parseExpression('{ "title": "x", "skip": false }')
    expect(p.error).toBeNull()
    expect(p.root?.skip).toBe(false)
    expect(p.root?.skipKeyStart).toBeGreaterThan(0)
  })

  it('flags a fully pruned tree as matching nothing', () => {
    const p = parseExpression(
      '{ "all": [ { "title": "x", "skip": true }, ' +
      '{ "not": { "title": "y", "skip": true } } ] }')
    expect(p.error).toBeNull()
    expect(p.matchesNothing).toBe(true)
  })

  it('does not flag a surviving tree', () => {
    const p = parseExpression(
      '{ "any": [ { "title": "x", "skip": true }, { "title": "y" } ] }')
    expect(p.matchesNothing).toBe(false)
  })
})

describe('toggleSkip', () => {
  it('adds a skip marker with a minimal edit, preserving comments', () => {
    const p = parseExpression(RFC)
    const keep = p.root!.children[0]!.children[0]!
    const out = toggleSkip(RFC, keep, true)
    /* everything else byte-identical: same length + marker */
    expect(out).toHaveLength(RFC.length + ', "skip": true'.length)
    expect(out).toContain('// too many repeats on this one')
    const p2 = parseExpression(out)
    expect(p2.error).toBeNull()
    expect(p2.root!.children[0]!.children[0]!.skip).toBe(true)
  })

  it('removes a skip marker and its separating comma', () => {
    const p = parseExpression(RFC)
    const skipped = p.root!.children[0]!.children[1]!
    const out = toggleSkip(RFC, skipped, false)
    const p2 = parseExpression(out)
    expect(p2.error).toBeNull()
    expect(p2.root!.children[0]!.children[1]!.skip).toBe(false)
    expect(p2.root!.children[0]!.children[1]!.skipKeyStart).toBe(-1)
    expect(out).toContain('// never record')
  })

  it('rewrites an existing skip: false in place', () => {
    const src = '{ "title": "x", "skip": false }'
    const p = parseExpression(src)
    const out = toggleSkip(src, p.root!, true)
    expect(out).toBe('{ "title": "x", "skip": true }')
  })

  it('removes a first-member skip with its following comma', () => {
    const src = '{ "skip": true, "title": "x" }'
    const p = parseExpression(src)
    expect(p.root?.skip).toBe(true)
    const out = toggleSkip(src, p.root!, false)
    const p2 = parseExpression(out)
    expect(p2.error).toBeNull()
    expect(p2.root?.skip).toBe(false)
    expect(p2.root?.key).toBe('title')
  })

  it('round-trips: on then off restores parseable equivalence', () => {
    const p = parseExpression(RFC)
    const target = p.root!.children[1]!
    const on = toggleSkip(RFC, target, true)
    const pOn = parseExpression(on)
    const off = toggleSkip(on, pOn.root!.children[1]!, false)
    expect(off).toBe(RFC)
  })
})

describe('offsetToLineCol', () => {
  it('maps offsets to 1-based line and column', () => {
    expect(offsetToLineCol('ab\ncd', 0)).toEqual({ line: 1, col: 1 })
    expect(offsetToLineCol('ab\ncd', 3)).toEqual({ line: 2, col: 1 })
    expect(offsetToLineCol('ab\ncd', 4)).toEqual({ line: 2, col: 2 })
  })
})

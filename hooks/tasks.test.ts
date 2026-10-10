import { expect, test } from 'claude-code/testing'

import { reconcile } from './tasks'
import type { Tracked } from './tasks'

test('reconcile drops tasks the engine no longer lists', () => {
  const t: Tracked = new Map([['a', { tool: 'Bash', startedAt: 1 }], ['b', { tool: 'Bash', startedAt: 1 }]])
  expect(reconcile(t, [{ id: 'b', status: 'running' }], 5)).toBe(true)
  expect([...t.keys()]).toEqual(['b'])
})

test('reconcile empties on an empty list, which removes the marker', () => {
  const t: Tracked = new Map([['a', { tool: 'Bash', startedAt: 1 }]])
  expect(reconcile(t, [], 5)).toBe(true)
  expect(t.size).toBe(0)
})

test('reconcile adds unseen live tasks and ignores finished or malformed rows', () => {
  const t: Tracked = new Map()
  const rows = [
    { id: 'x', status: 'running', type: 'shell' },
    { id: 'y', status: 'completed' },
    { id: 'z', status: 'killed' },
    { status: 'running' },
    { id: 7 },
  ]
  expect(reconcile(t, rows, 9)).toBe(true)
  expect([...t.keys()]).toEqual(['x'])
  expect(reconcile(t, rows, 10)).toBe(false)
})

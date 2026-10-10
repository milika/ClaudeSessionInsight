/** One in-flight background task as the engine's Stop event lists it. */
export type TaskRow = { id?: unknown; status?: unknown; type?: unknown }

export type Tracked = Map<string, { tool: string; startedAt: number }>

const DEAD = /^(complet|done|fail|error|kill|stop|cancel|exit|finish)/i

/**
 * Makes `tracked` equal to the engine's list of in-flight work: ids the engine no longer
 * lists are dropped (a missed or unmatched notification cannot leave one behind), ids it
 * lists that were never seen start are added. Returns true when anything changed.
 */
export function reconcile(tracked: Tracked, rows: readonly TaskRow[], now: number): boolean {
  const live = new Map<string, string>()
  for (const r of rows) {
    if (typeof r?.id !== 'string' || !r.id) continue
    if (typeof r.status === 'string' && DEAD.test(r.status)) continue
    live.set(r.id, typeof r.type === 'string' ? r.type : 'task')
  }
  let changed = false
  for (const id of [...tracked.keys()]) {
    if (!live.has(id)) {
      tracked.delete(id)
      changed = true
    }
  }
  for (const [id, tool] of live) {
    if (!tracked.has(id)) {
      tracked.set(id, { tool, startedAt: now })
      changed = true
    }
  }
  return changed
}

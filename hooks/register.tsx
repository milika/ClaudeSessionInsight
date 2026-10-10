import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Call, Week } from '../types'
import { barSvg, daysSvg } from './charts'
import { reconcile } from './tasks'
import {
  analyze,
  bar,
  elapsedFrac,
  fmtDay,
  fmtPct,
  fmtSpan,
  fmtWhen,
  levelOf,
  recordSample,
  sanitizeWeeks,
  spark,
  weekText,
} from './weekly'

const PANE = 'session-insights'
const COMPACT_AT = 75
const calls = atom({ plugin: 'session-insights', key: 'calls' } as const, [])
const prompts = atom({ plugin: 'session-insights', key: 'prompts' } as const, 0)
const weeks = atom({ plugin: 'session-insights', key: 'weeks' } as const, [])
const contextPct = atom({ plugin: 'session-insights', key: 'contextPct' } as const, null)
const isAutoCompact = atom({ plugin: 'session-insights', key: 'isAutoCompact' } as const, true)
const isCompacting = atom({ plugin: 'session-insights', key: 'isCompacting' } as const, false)

const fmt = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

const TASK_MARK = '⏳ '
const SESSIONS = 'ccd_session_mgmt'
/** Background tasks started this session and not yet reported finished. */
const running = new Map<string, { tool: string; startedAt: number }>()
const MAX_TASKS = 50
/** A task nobody reported finished within this long is assumed gone, so a marker never sticks. */
const TASK_TTL_MS = 12 * 3_600_000
/** Waits at least this long between auto-compact attempts, whatever the last one did. */
const COMPACT_COOLDOWN_MS = 2 * 60_000
let lastCompactAt = 0

/** Observer-side work must never break the session: runs `fn`, swallows what it throws. */
async function safe(fn: () => unknown): Promise<void> {
  try {
    await fn()
  } catch {
    // the mod only watches; a failed watch is not worth the session's turn
  }
}

function pruneTasks(now: number) {
  for (const [id, t] of running) if (now - t.startedAt > TASK_TTL_MS) running.delete(id)
  while (running.size > MAX_TASKS) running.delete(running.keys().next().value as string)
}
/** What the sidebar title is known to show: true marked, false clean, undefined unchecked. */
let applied: boolean | undefined
let failures = 0
let pausedUntil = 0
let isLogged = false
let chain: Promise<unknown> = Promise.resolve()

const MAX_FAILURES = 3
const RETRY_MS = 15_000
const PAUSE_MS = 5 * 60_000

/** Drops the task a notification names (else the oldest) and updates the title. */
async function finishTask($: EngineInterface, text: string) {
  if (running.size === 0) return
  const hit = [...running.keys()].find(id => text.includes(id))
  running.delete(hit ?? [...running.keys()][0])
  await syncTitle($)
}

/**
 * Puts TASK_MARK at the start of the session's sidebar title while background tasks run
 * and takes it off when none do.
 *
 * Calls run one at a time, so a start and a finish never interleave. A failure is retried
 * after RETRY_MS and on the next task event; after MAX_FAILURES in a row it pauses for
 * PAUSE_MS, logging once, so a broken title tool is never hammered.
 */
function syncTitle($: EngineInterface): Promise<unknown> {
  chain = chain.then(() => applyTitle($)).catch(() => undefined)

  return chain
}

async function applyTitle($: EngineInterface) {
  pruneTasks(Date.now())
  const wanted = running.size > 0
  if (wanted === applied || Date.now() < pausedUntil) return
  try {
    const got = await $.mcp.call(SESSIONS, 'get_session', { session_id: 'self' })
    const block = got.content.find(c => c.type === 'text') as { text?: string } | undefined
    if (got.isError) throw new Error('get_session failed')
    const title = String((JSON.parse(block?.text ?? '{}') as { title?: string }).title ?? '')
    if (!title) throw new Error('no title')
    const base = title.startsWith(TASK_MARK) ? title.slice(TASK_MARK.length) : title
    const next = wanted ? TASK_MARK + base : base
    if (next !== title) {
      const done = await $.mcp.call(SESSIONS, 'set_session_title', { session_id: 'self', title: next })
      if (done.isError) throw new Error('set_session_title refused')
    }
    applied = wanted
    failures = 0
    isLogged = false
  } catch (err) {
    failures += 1
    if (failures >= MAX_FAILURES) {
      failures = 0
      pausedUntil = Date.now() + PAUSE_MS
      if (!isLogged) {
        isLogged = true
        $.ui.log(
          `session-insights: title marker paused for 5 minutes: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    void $.clock.after(RETRY_MS, () => syncTitle($))
  }
}

/** Records the seven-day window's percent and mirrors it into the pane's and band's state. */
async function track($: EngineInterface, limits: Limit[]) {
  const limit = limits.find(l => l.kind === 'seven_day')
  if (!limit?.resetsAt || !Number.isFinite(limit.percentUsed)) return
  const endsAt = Date.parse(limit.resetsAt)
  if (Number.isNaN(endsAt)) return

  const now = Date.now()
  const stored = sanitizeWeeks(await $.store.get('weeks'))
  const next = recordSample(stored, endsAt, now, limit.percentUsed)
  await $.store.set('weeks', next)
  await update($, weeks, () => next)
  $.ui.status('')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await safe(() =>
      $.command.register({
        name: 'insights',
        description: 'Show session insights: tool calls, durations, prompts, weekly limit',
      }),
    )
    await safe(() => $.ui.status(''))
    await safe(async () => {
      const stored = sanitizeWeeks(await $.store.get('weeks'))
      await update($, weeks, () => stored)
    })
    await safe(() => $.ui.open({ id: PANE, title: 'Session insights' }))
    await safe(() => syncTitle($)) // drops a marker left behind by a previous load
    await safe(async () => {
      // no reading yet is fine; session.measure fills it in after the first response
      const usage = await $.session.usage()
      await update($, contextPct, () => usage.context.percent ?? null)
      await track($, usage.rateLimits)
    })

    return next(e)
  })

  let isBusy = false

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await safe(() => track($, e.rateLimits))

    if (e.changed.includes('context')) {
      const pct = e.context.percent ?? null
      await safe(() => update($, contextPct, () => pct))

      const isOn = await read($, isAutoCompact).catch(() => false)
      const isCooled = Date.now() - lastCompactAt > COMPACT_COOLDOWN_MS
      if (pct !== null && pct >= COMPACT_AT && !isBusy && isOn && isCooled) {
        isBusy = true
        lastCompactAt = Date.now()
        await safe(() => update($, isCompacting, () => true))
        await safe(() => $.ui.toast(`Context at ${pct}%, compacting`))
        try {
          const result = await $.session.compact()
          if (result.skip) await safe(() => $.ui.toast(`Compaction skipped: ${result.skip}`))
          else await safe(() => update($, contextPct, () => null))
        } catch {
          await safe(() => $.ui.toast(`Auto-compact failed at ${pct}%; run /compact`))
        } finally {
          isBusy = false
          await safe(() => update($, isCompacting, () => false))
        }
      }
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // background tasks die with the session; never leave the marker on a closed chat's title
    running.clear()
    // exit is on a short clock: give the title a moment, never hold the exit for it
    await safe(() => Promise.race([syncTitle($), $.clock.sleep(1500)]))

    return next(e)
  })

  // The engine lists the work still in flight whenever the agent stops: the one source of
  // truth. Whatever the notifications and tool results guessed, this puts the count right.
  on('classic.Stop', async ($, e, next) => {
    await safe(async () => {
      if (!Array.isArray(e.background_tasks)) return
      reconcile(running, e.background_tasks, Date.now())
      // read the real title once per stop, so a marker that drifted is put right either way
      applied = undefined
      await syncTitle($)
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'task-notification' || e.text.includes('<task-notification>')) {
      await safe(() => finishTask($, e.text))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const auto = await read($, isAutoCompact).catch(() => true)
    const busy = await read($, isCompacting).catch(() => false)
    const all = sanitizeWeeks(await read($, weeks).catch(() => []))
    const now = Date.now()
    const current = all.filter(w => w.endsAt > now).sort((a, b) => a.endsAt - b.endsAt)[0]
    const report = current ? analyze(current, now) : undefined
    if (!report && !busy) return next(e)

    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const isHot = busy || report?.isOutBeforeReset === true
    const parts = [
      busy ? 'compacting…' : undefined,
      report ? weekText(report) : undefined,
    ].filter(Boolean)

    const b = report ? bar(report.pct, elapsedFrac(report, now), 24) : undefined
    const level = report ? levelOf(report) : 'success'

    return (
      <Box alignItems="center">
        {report && Svg && (
          <Box marginRight={1}>
            <Svg
              source={barSvg(report.pct, elapsedFrac(report, now), level, 180, 10)}
              alt={`Weekly limit ${Math.round(report.pct)}% used`}
              width={180}
              height={10}
            />
          </Box>
        )}
        {b && !Svg && (
          <Text>
            <Text color={level}>{b.used}</Text>
            <Text dimColor>
              {b.before}
              {b.tick}
              {b.after}
            </Text>{' '}
          </Text>
        )}
        <Text dimColor={!isHot} bold={isHot}>
          {parts.join(' · ')}{' '}
        </Text>
        <Button
          key="auto"
          label={auto ? `auto-compact ${COMPACT_AT}%: on` : `auto-compact ${COMPACT_AT}%: off`}
          dimColor
          onPress={() => update($, isAutoCompact, v => !v)}
        />
      </Box>
    )
  })

  on('command.run', { command: 'insights' }, async $ => {
    const isOpen = await $.ui.open({ id: PANE, title: 'Session insights' }).then(
      () => true,
      () => false,
    )

    return { text: isOpen ? 'Session insights pane opened.' : 'Could not open the insights pane.' }
  }).catch(() => ({ text: 'Could not open the insights pane.' }))

  // The three hooks below sit on the model's and the person's path: they only watch, so
  // whatever the bookkeeping throws is swallowed and the event goes on unchanged.
  on('prompt.submit', async ($, e, next) => {
    await safe(async () => {
      // a finished background task arrives as a prompt whose origin is a notification
      if (e.origin.kind === 'task-notification' || e.text.includes('<task-notification>')) {
        await finishTask($, e.text)
      } else {
        await update($, prompts, n => n + 1)
      }
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const call: Call = {
      id: e.tool_use_id,
      tool: e.tool,
      startedAt: Date.now(),
      isDone: false,
    }
    await safe(() => update($, calls, list => [...list, call].slice(-500)))
    const ran = await next(e)
    await safe(async () => {
      const out = ran.result as Record<string, unknown> | undefined
      const taskId =
        typeof out?.backgroundTaskId === 'string'
          ? out.backgroundTaskId
          : out?.status === 'async_launched' && typeof out.agentId === 'string'
            ? out.agentId
            : undefined
      if (taskId) {
        running.set(taskId, { tool: e.tool, startedAt: Date.now() })
        pruneTasks(Date.now())
        await syncTitle($)
      }
    })
    const durationMs = Date.now() - call.startedAt
    await safe(() =>
      update($, calls, list =>
        list.map(one => (one.id === call.id ? { ...one, isDone: true, durationMs } : one)),
      ),
    )

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const list = await read($, calls).catch(() => [])
    const promptCount = await read($, prompts).catch(() => 0)
    const allWeeks = sanitizeWeeks(await read($, weeks).catch(() => []))
    const now = Date.now()
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 26)

    const current = allWeeks.filter(w => w.endsAt > now).sort((a, b) => a.endsAt - b.endsAt)[0]
    const report = current ? analyze(current, now) : undefined
    const share = 100 / 7
    const scale = Math.max(share * 2, ...(report?.days.map(d => d.spent) ?? [0]))
    const big = report ? bar(report.pct, elapsedFrac(report, now), 40) : undefined

    const byTool = new Map<string, { n: number; total: number }>()
    for (const c of list) {
      const s = byTool.get(c.tool) ?? { n: 0, total: 0 }
      s.n += 1
      s.total += c.durationMs ?? 0
      byTool.set(c.tool, s)
    }
    const rows = [...byTool.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8)
    const running = list.filter(c => !c.isDone).length
    const totalMs = list.reduce((sum, c) => sum + (c.durationMs ?? 0), 0)

    return (
      <Box flexDirection="column">
        <Text bold>Weekly limit</Text>
        {!report && (
          <Text dimColor>
            No weekly reading yet; it appears after the first response (subscription accounts only).
          </Text>
        )}
        {report && big && (
          <Box flexDirection="column">
            {Svg ? (
              <Box flexDirection="column">
                <Svg
                  source={barSvg(report.pct, elapsedFrac(report, now), levelOf(report), 360, 18)}
                  alt={`Weekly limit ${Math.round(report.pct)}% used`}
                  width={360}
                  height={18}
                />
                <Text>
                  <Text bold>{fmtPct(report.pct)}</Text> used
                </Text>
              </Box>
            ) : (
              <Text>
                <Text color={levelOf(report)}>{big.used}</Text>
                <Text dimColor>
                  {big.before}
                  {big.tick}
                  {big.after}
                </Text>{' '}
                <Text bold>{fmtPct(report.pct)}</Text>
              </Text>
            )}
            <Text dimColor>
              Tick = where an even pace would be now ({Math.round(elapsedFrac(report, now) * 100)}% of the
              week gone)
            </Text>
            <Text>
              Resets {fmtWhen(report.endsAt)} (in {fmtSpan(report.endsAt - now)})
            </Text>
            {report.ratePerDay === undefined && (
              <Text dimColor>Too early in the window to project a run-out time.</Text>
            )}
            {report.ratePerDay !== undefined && (
              <Text>
                Average {report.ratePerDay.toFixed(1)}%/day this week
                {report.runsOutAt === undefined
                  ? ''
                  : report.isOutBeforeReset
                    ? ` · runs out ~${fmtWhen(report.runsOutAt)} (${fmtSpan(report.endsAt - report.runsOutAt)} before reset)`
                    : ` · projected ${Math.round(report.ratePerDay * 7)}% by the reset`}
              </Text>
            )}
            {report.budgetPerDay !== undefined && (
              <Text dimColor>To last until reset: {report.budgetPerDay.toFixed(1)}%/day</Text>
            )}
            <Text> </Text>
            <Text bold>Per day (reset-anchored)</Text>
            {report.untracked > 0 && (
              <Text dimColor>
                {'before tracking'.padEnd(11)} {fmtPct(report.untracked).padStart(6)}
              </Text>
            )}
            {Svg && (
              <Box flexDirection="column">
                <Svg
                  source={daysSvg(
                    report.days.map(d => ({
                      label: fmtDay(d.start).slice(0, 3),
                      spent: d.spent,
                      isFuture: d.isFuture,
                      isToday: d.isToday,
                    })),
                    share,
                    360,
                    130,
                  )}
                  alt={`Percent of the weekly limit spent per day: ${report.days
                    .filter(d => !d.isFuture)
                    .map(d => `${fmtDay(d.start)} ${d.spent.toFixed(1)}%`)
                    .join(', ')}`}
                  width={360}
                  height={130}
                />
                <Text dimColor>Dashed line = even share, {share.toFixed(1)}%/day</Text>
              </Box>
            )}
            {!Svg && report.days.map(d => (
              <Text dimColor={d.isFuture}>
                {fmtDay(d.start)} {d.isFuture ? '      ·' : fmtPct(d.spent).padStart(7)}{' '}
                <Text color={d.spent > share * 2 ? 'error' : d.spent > share * 1.3 ? 'warning' : 'success'}>
                  {'█'.repeat(Math.round((d.spent / scale) * 28))}
                </Text>
                {d.isToday ? ' ◂ today' : ''}
              </Text>
            ))}
            {!Svg && (
              <Text dimColor>
                {spark(report.days.map(d => d.spent))} daily shape · even share is {share.toFixed(1)}%/day
              </Text>
            )}
          </Box>
        )}
        <Text> </Text>
        <Text bold>
          {promptCount} prompts · {list.length} tool calls · {running} running · {fmt(totalMs)} in tools
        </Text>
        <Text> </Text>
        <Text bold>By tool</Text>
        {rows.length === 0 && <Text dimColor>No tool calls yet.</Text>}
        {rows.map(([tool, s]) => (
          <Text>
            {String(s.n).padStart(4)}× {tool} <Text dimColor>({fmt(s.total)})</Text>
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Recent</Text>
        {list.slice(-room).reverse().map(c => (
          <Text dimColor={c.isDone}>
            {c.isDone ? 'done' : 'runs'} {c.tool}
            {c.durationMs !== undefined ? ` ${fmt(c.durationMs)}` : ''}
          </Text>
        ))}
      </Box>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Call, Week } from '../types'
import { barSvg, daysSvg, lineSvg } from './charts'
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
const COMPACT_AT = 30
const calls = atom({ plugin: 'session-insights', key: 'calls' } as const, [])
const prompts = atom({ plugin: 'session-insights', key: 'prompts' } as const, 0)
const weeks = atom({ plugin: 'session-insights', key: 'weeks' } as const, [])
const contextPct = atom({ plugin: 'session-insights', key: 'contextPct' } as const, null)
const isAutoCompact = atom({ plugin: 'session-insights', key: 'isAutoCompact' } as const, true)
const isCompacting = atom({ plugin: 'session-insights', key: 'isCompacting' } as const, false)
const isPanelOpen = atom({ plugin: 'session-insights', key: 'isPanelOpen' } as const, false)
const fiveHour = atom({ plugin: 'session-insights', key: 'fiveHour' } as const, null)
/** When to send "continue": set by the band's toggle, cleared when it is sent. */
const resumeAt = atom({ plugin: 'session-insights', key: 'resumeAt' } as const, null)
/** True after a press that found no live five-hour reset time to aim at. */
const compactLast = atom({ plugin: 'session-insights', key: 'compactLast' } as const, null)
const resumeLast = atom({ plugin: 'session-insights', key: 'resumeLast' } as const, null)
const resumeUnknown = atom({ plugin: 'session-insights', key: 'resumeUnknown' } as const, false)

/** Not `/insights`: that one is a built-in skill's name. */
const COMMAND = 'insight-panel'

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
const RETRY_COMPACT_MS = 20_000
const COMPACT_HANG_MS = 3 * 60_000
/** The five-hour window's tokens are back a little after the reset; wait this long past it. */
const RESUME_DELAY_MS = 6 * 60_000
const RESUME_CHECK_MS = 30_000
const RESUME_COMPACT_TRIES = 30
let lastCompactAt = 0

/** Observer-side work must never break the session: runs `fn`, swallows what it throws. */
async function safe(fn: () => unknown): Promise<void> {
  try {
    await fn()
  } catch {
    // the mod only watches; a failed watch is not worth the session's turn
  }
}

let isCompactBusy = false

/**
 * Compacts the conversation now, from the auto trigger. One at a
 * time, silently, and it never throws: the engine refuses a compaction while a turn runs.
 */
async function runCompact($: EngineInterface, retry = true): Promise<'done' | 'skipped' | 'failed' | 'busy'> {
  if (isCompactBusy) return 'busy'
  isCompactBusy = true
  lastCompactAt = Date.now()
  const note = (text: string) => safe(() => update($, compactLast, () => `${fmtWhen(Date.now())} ${text}`))
  await safe(() => update($, isCompacting, () => true))
  try {
    // a compaction that never answers must not hold the busy flag for good
    const result = await Promise.race([
      $.session.compact(),
      $.clock.sleep(COMPACT_HANG_MS).then(() => 'hung' as const),
    ])
    if (result === 'hung') {
      await note('no answer from the engine')

      return 'failed'
    }
    if (result.skip) {
      await note(`skipped (${String(result.skip).slice(0, 40)})`)

      return 'skipped'
    }
    await safe(() => update($, contextPct, () => null))
    await note('compacted')

    return 'done'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Some hosts (the desktop app) do not offer the direct call: run the /compact command instead.
    if (/not available/i.test(message)) {
      try {
        await $.command.run({ command: 'compact' })
        await safe(() => update($, contextPct, () => null))
        await note('compact run as /compact')

        return 'done'
      } catch (err2) {
        await note(`refused (${(err2 instanceof Error ? err2.message : String(err2)).slice(0, 50)})`)
        lastCompactAt = 0

        return 'failed'
      }
    }
    // The engine refuses while a turn runs: not a real attempt, so no cooldown; the
    // ticker looks again shortly.
    lastCompactAt = 0
    await note(`refused (${message.slice(0, 50)})`)
    if (retry) void $.clock.after(RETRY_COMPACT_MS, () => safe(() => compactIfNeeded($)))

    return 'failed'
  } finally {
    isCompactBusy = false
    await safe(() => update($, isCompacting, () => false))
  }
}

/** Compacts when the context is at or past COMPACT_AT, the toggle is on and the cooldown has passed. */
async function compactIfNeeded($: EngineInterface) {
  const usage = await $.session.usage()
  const pct = usage.context.percent ?? null
  const isOn = await read($, isAutoCompact).catch(() => false)
  const isCooled = Date.now() - lastCompactAt > COMPACT_COOLDOWN_MS
  if (pct !== null && pct >= COMPACT_AT && isOn && isCooled) await runCompact($)
}

/** Turns the scheduled "continue" on, aimed past the five-hour reset, or off again. */
async function toggleResume($: EngineInterface) {
  if ((await read($, resumeAt)) !== null) {
    await update($, resumeAt, () => null)

    return
  }
  // read the reset time fresh, never off a stale reading: a wrong time would send early
  planPausedUntil = 0
  await pollPlan($)
  const five = await read($, fiveHour)
  if (five === null || five.resetsAt <= Date.now()) {
    await update($, resumeUnknown, () => true)

    return
  }
  await update($, resumeUnknown, () => false)
  ensureTicker($)
  await update($, resumeAt, () => five.resetsAt + RESUME_DELAY_MS)
}

let isResuming = false
let lastTick = 0
let lastPlanAt = 0

/**
 * Runs the periodic work: the scheduled "continue" and the five-hour poll. A reload drops
 * the engine's timers without running session.start again, so this is called from the
 * events that keep arriving and starts a fresh timer whenever the last one has gone quiet.
 */
function ensureTicker($: EngineInterface) {
  if (Date.now() - lastTick < RESUME_CHECK_MS * 3) return
  lastTick = Date.now()
  void $.clock.every(RESUME_CHECK_MS, () =>
    safe(async () => {
      lastTick = Date.now()
      await resumeIfDue($)
      await compactIfNeeded($)
      if (Date.now() - lastPlanAt >= PLAN_POLL_MS) await pollPlan($)
    }),
  )
}

/** Sends "continue" once the scheduled time has passed, compacting first if needed; switches the toggle off first. */
async function resumeIfDue($: EngineInterface) {
  if (isResuming) return
  const at = await read($, resumeAt)
  if (at === null || Date.now() < at) return
  isResuming = true
  try {
    await update($, resumeAt, () => null)
    // Compact first unless the context is known to be under the threshold, so the turn
    // that follows starts light. Tries for up to ten minutes (a turn or another compaction
    // may be in the way), then sends "continue" regardless: a long context is better
    // than a chat left idle.
    let note = 'sent'
    await safe(async () => {
      for (let i = 0; i < RESUME_COMPACT_TRIES; i += 1) {
        const live = (await $.session.usage()).context.percent ?? null
        const pct = live ?? (await read($, contextPct))
        if (pct !== null && pct < COMPACT_AT) return
        const outcome = await runCompact($, false)
        if (outcome === 'done') {
          note = 'compacted, sent'

          return
        }
        if (outcome === 'skipped') return
        note = 'could not compact, sent'
        await $.clock.sleep(RETRY_COMPACT_MS)
      }
    })
    await $.prompt.submit({ text: 'continue', asUser: true })
    await safe(() => update($, resumeLast, () => `${fmtWhen(Date.now())} ${note}`))
  } finally {
    isResuming = false
  }
}

/** Whether the insights panel is open and drawn, from the engine's own record. */
async function panelIsShown($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
  } catch {
    return false
  }
}

/** Copies the engine's record of the panel into the band's state; returns it. */
async function syncPanel($: EngineInterface): Promise<boolean> {
  const isShown = await panelIsShown($)
  await safe(() => update($, isPanelOpen, () => isShown))

  return isShown
}

/** Hides the panel when it is shown and shows it when it is not; says which happened. */
async function togglePanel($: EngineInterface): Promise<'shown' | 'hidden' | 'failed'> {
  try {
    if (await panelIsShown($)) {
      await $.ui.close({ id: PANE })
      await syncPanel($)

      return 'hidden'
    }
    await $.ui.open({ id: PANE, title: 'Session insights' })

    return (await syncPanel($)) ? 'shown' : 'failed'
  } catch {
    return 'failed'
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
 * PAUSE_MS, so a broken title tool is never hammered.
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
  } catch {
    failures += 1
    if (failures >= MAX_FAILURES) {
      failures = 0
      pausedUntil = Date.now() + PAUSE_MS
    }
    void $.clock.after(RETRY_MS, () => syncTitle($))
  }
}

let planFailures = 0
let planPausedUntil = 0
const PLAN_POLL_MS = 60_000

/**
 * Reads the plan's five-hour window straight from the desktop app's usage card. The
 * engine's per-response limit list does not always carry it, the card always does.
 * Backs off after repeated failures; never throws.
 */
async function pollPlan($: EngineInterface) {
  if (Date.now() < planPausedUntil) return
  lastPlanAt = Date.now()
  try {
    const got = await $.mcp.call(SESSIONS, 'get_usage', {})
    const block = got.content.find(c => c.type === 'text') as { text?: string } | undefined
    if (got.isError) throw new Error(`get_usage error: ${String(block?.text).slice(0, 160)}`)
    const plan = (
      JSON.parse(block?.text ?? '{}') as {
        plan?: { status?: string; windows?: { label?: string; percentUsed?: number; resetsAt?: string }[] }
      }
    ).plan
    if (plan?.status !== 'ok') throw new Error(`plan status is ${String(plan?.status)}`)
    const w = plan.windows?.find(x => /5.?hour/i.test(x.label ?? ''))
    const at = w?.resetsAt ? Date.parse(w.resetsAt) : NaN
    if (!w || typeof w.percentUsed !== 'number' || !Number.isFinite(w.percentUsed) || !Number.isFinite(at)) {
      throw new Error(`no five-hour window in: ${JSON.stringify(plan.windows ?? null).slice(0, 160)}`)
    }
    await update($, fiveHour, () => ({ pct: w.percentUsed as number, resetsAt: at }))
    planFailures = 0
  } catch {
    planFailures += 1
    if (planFailures >= 5) {
      planFailures = 0
      planPausedUntil = Date.now() + 10 * 60_000
    }
  }
}

/** Records the seven-day window's percent and mirrors it into the panel's and band's state. */
async function track($: EngineInterface, limits: Limit[]) {
  await safe(async () => {
    const five = limits.find(l => l.kind === 'five_hour')
    const at = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
    if (five && Number.isFinite(five.percentUsed) && Number.isFinite(at)) {
      await update($, fiveHour, () => ({ pct: five.percentUsed, resetsAt: at }))
    }
  })

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
        name: COMMAND,
        description: 'Show or hide the session insights panel: weekly limit, tool calls, durations',
      }),
    )
    await safe(() => $.ui.status(''))
    await safe(async () => {
      const stored = sanitizeWeeks(await $.store.get('weeks'))
      await update($, weeks, () => stored)
    })
    // the panel is never opened unasked: the band's button or /insight-panel shows it
    await safe(() => syncPanel($))
    await safe(() => pollPlan($))
    await safe(async () => {
      // keeps the five-hour line moving between responses; dropped on reload, rebuilt here
      ensureTicker($)
    })
    await safe(() => syncTitle($)) // drops a marker left behind by a previous load
    await safe(async () => {
      // no reading yet is fine; session.measure fills it in after the first response
      const usage = await $.session.usage()
      await update($, contextPct, () => usage.context.percent ?? null)
      await track($, usage.rateLimits)
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    ensureTicker($)
    if (e.changed.includes('rateLimits')) await safe(() => track($, e.rateLimits))
    await safe(() => pollPlan($))

    if (e.changed.includes('context')) {
      const pct = e.context.percent ?? null
      await safe(() => update($, contextPct, () => pct))

      // not awaited: the hook is part of the turn's own path, and a compaction answered
      // from inside it could hold the turn up. The ticker retries whatever is refused.
      void safe(() => compactIfNeeded($))
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
    ensureTicker($)
    // the agent has stopped: the best moment to compact, so try without waiting for the tick
    void safe(() => compactIfNeeded($))
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
    ensureTicker($)
    if (e.props.hasSurvey) return next(e)

    const auto = await read($, isAutoCompact).catch(() => true)
    const busy = await read($, isCompacting).catch(() => false)
    const isOpen = await read($, isPanelOpen).catch(() => false)
    const five = await read($, fiveHour).catch(() => null)
    const resume = await read($, resumeAt).catch(() => null)
    const resumeDone = await read($, resumeLast).catch(() => null)
    const compactDone = await read($, compactLast).catch(() => null)
    const resumeNoTime = await read($, resumeUnknown).catch(() => false)
    const all = sanitizeWeeks(await read($, weeks).catch(() => []))
    const now = Date.now()
    const current = all.filter(w => w.endsAt > now).sort((a, b) => a.endsAt - b.endsAt)[0]
    const report = current ? analyze(current, now) : undefined

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

    // the five-hour window: a blue line that fills as it is used; a window that has
    // already reset reads as empty until the next reading arrives
    const isFiveLive = five !== null && five.resetsAt > now
    const fivePct = five !== null && isFiveLive ? five.pct : 0
    const fiveLabel =
      five === null
        ? ''
        : `5h ${Math.round(fivePct)}%${isFiveLive ? ` · resets ${fmtWhen(five.resetsAt)} (in ${fmtSpan(five.resetsAt - now)})` : ''}`
    const fiveLine =
      five !== null && !Svg ? bar(fivePct, 0, 24) : undefined

    return (
      <Box flexDirection="column">
        {(
          <Box alignItems="center">
            {five !== null && Svg ? (
              <Box marginRight={1}>
                <Svg
                  source={lineSvg(fivePct, 180, 4)}
                  alt={`Five-hour limit ${Math.round(fivePct)}% used`}
                  width={180}
                  height={4}
                />
              </Box>
            ) : (
              five !== null && fiveLine && (
                <Text>
                  <Text color="#3b82f6">{fiveLine.used}</Text>
                  <Text dimColor>
                    {fiveLine.before}
                    {fiveLine.tick}
                    {fiveLine.after}
                  </Text>{' '}
                </Text>
              )
            )}
            <Text dimColor>{fiveLabel}</Text>
            <Box flexGrow={1} />
            {compactDone !== null && <Text dimColor>compact {compactDone}{'  '}</Text>}
            {resumeDone !== null && resume === null && <Text dimColor>last continue {resumeDone}{'  '}</Text>}
            <Button
              key="resume"
              label={
                resume !== null
                  ? `continue at ${fmtWhen(resume)}: on`
                  : resumeNoTime
                    ? 'continue after 5h reset: no reset time yet'
                    : 'continue after 5h reset: off'
              }
              dimColor
              onPress={async () => {
                await safe(() => toggleResume($))
              }}
            />
          </Box>
        )}
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
        <Box flexGrow={1} />
        <Button
          key="auto"
          label={auto ? `auto-compact ${COMPACT_AT}%: on` : `auto-compact ${COMPACT_AT}%: off`}
          dimColor
          onPress={() => update($, isAutoCompact, v => !v)}
        />
        <Text> </Text>
        <Button
          key="panel"
          label={isOpen ? 'hide insights' : 'show insights'}
          dimColor
          onPress={async () => {
            await togglePanel($)
          }}
        />
      </Box>
      </Box>
    )
  })

  on('command.run', { command: COMMAND }, async $ => {
    const done = await togglePanel($)
    const text = {
      shown: 'Session insights panel shown.',
      hidden: 'Session insights panel hidden.',
      failed: 'Could not change the insights panel.',
    }[done]

    return { text }
  }).catch(() => ({ text: 'Could not change the insights panel.' }))

  // The person can close the panel with its own mark; keep the band's button honest.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await safe(() => syncPanel($))

    return closed
  }).catch(($, e, next) => next(e))

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

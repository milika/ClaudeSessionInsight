import type { Week } from '../types'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const WEEK = 7 * DAY

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Reads weeks back from the store, dropping anything malformed instead of throwing on it. */
export function sanitizeWeeks(raw: unknown): Week[] {
  if (!Array.isArray(raw)) return []
  const out: Week[] = []
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue
    const { endsAt, samples } = w as { endsAt?: unknown; samples?: unknown }
    if (!isNum(endsAt) || !Array.isArray(samples)) continue
    const clean: [number, number][] = []
    for (const s of samples) {
      if (Array.isArray(s) && s.length === 2 && isNum(s[0]) && isNum(s[1])) clean.push([s[0], s[1]])
    }
    out.push({ endsAt, samples: clean })
  }
  return out
}

/** Adds a (time, percent) sample to the window ending at `endsAt`; keeps the last 4 windows. */
export function recordSample(weeks: Week[], endsAt: number, t: number, pct: number): Week[] {
  const out: Week[] = weeks.map(w => ({ endsAt: w.endsAt, samples: [...w.samples] }))
  let week = out.find(w => Math.abs(w.endsAt - endsAt) < 6 * HOUR)
  if (!week) {
    week = { endsAt, samples: [] }
    out.push(week)
  } else {
    week.endsAt = endsAt
  }
  const last = week.samples[week.samples.length - 1]
  if (!last || last[1] !== pct || t - last[0] > HOUR) {
    week.samples.push([t, pct])
    if (week.samples.length > 1500) week.samples = [week.samples[0], ...week.samples.slice(-1499)]
  }
  return out.sort((a, b) => a.endsAt - b.endsAt).slice(-4)
}

export type DayRow = {
  start: number
  /** Percent of the weekly limit spent in this day, from tracked samples. */
  spent: number
  isToday: boolean
  isFuture: boolean
}

export type WeekReport = {
  start: number
  endsAt: number
  pct: number
  daysLeft: number
  /** Average percent per day since the window began. */
  ratePerDay?: number
  /** When the limit runs out at that average rate; undefined when the rate is unknown. */
  runsOutAt?: number
  isOutBeforeReset: boolean
  /** Percent per day that would make the remainder last until the reset. */
  budgetPerDay?: number
  /** Percent spent before the first sample (history this mod did not see). */
  untracked: number
  days: DayRow[]
}

const pctAt = (samples: [number, number][], t: number): number | undefined => {
  let found: number | undefined
  for (const [st, sp] of samples) {
    if (st <= t) found = sp
    else break
  }
  return found
}

export function analyze(week: Week, now: number): WeekReport | undefined {
  const last = week.samples[week.samples.length - 1]
  if (!last) return undefined
  const start = week.endsAt - WEEK
  const pct = last[1]
  const elapsedDays = Math.max(0, now - start) / DAY
  const daysLeft = Math.max(0, week.endsAt - now) / DAY
  const ratePerDay = elapsedDays > 0.05 ? pct / elapsedDays : undefined
  const runsOutAt =
    ratePerDay && ratePerDay > 0 ? now + ((100 - pct) / ratePerDay) * DAY : undefined
  const first = week.samples[0]
  const days: DayRow[] = []
  for (let i = 0; i < 7; i++) {
    const dayStart = start + i * DAY
    const dayEnd = dayStart + DAY
    const isFuture = dayStart > now
    let spent = 0
    if (!isFuture) {
      const from = dayStart <= first[0] ? first[1] : (pctAt(week.samples, dayStart) ?? first[1])
      const to = pctAt(week.samples, Math.min(dayEnd, now)) ?? from
      spent = Math.max(0, to - from)
    }
    days.push({ start: dayStart, spent, isToday: !isFuture && now < dayEnd, isFuture })
  }
  return {
    start,
    endsAt: week.endsAt,
    pct,
    daysLeft,
    ratePerDay,
    runsOutAt,
    isOutBeforeReset: runsOutAt !== undefined && runsOutAt < week.endsAt,
    budgetPerDay: daysLeft > 0.02 ? Math.max(0, 100 - pct) / daysLeft : undefined,
    untracked: first[0] > start + HOUR ? first[1] : 0,
    days,
  }
}

export type Level = 'success' | 'warning' | 'error'

/** How worried to be: error when it runs out before the reset, warning when projected past 85%. */
export function levelOf(r: WeekReport): Level {
  if (r.isOutBeforeReset) return 'error'
  if ((r.ratePerDay ?? 0) * 7 >= 85) return 'warning'
  return 'success'
}

/** Share of the week that has elapsed, 0 to 1. */
export const elapsedFrac = (r: WeekReport, now: number) =>
  Math.min(1, Math.max(0, (now - r.start) / WEEK))

/**
 * A bar of `width` cells: filled up to `pct`, with a tick where the week's time has
 * reached. Fill past the tick means ahead of an even pace.
 */
export function bar(pct: number, timeFrac: number, width: number) {
  const used = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  const tick = Math.max(0, Math.min(width - 1, Math.floor(timeFrac * width)))
  const before = used > tick ? '' : '░'.repeat(Math.max(0, tick - used))
  return {
    used: '█'.repeat(used),
    before,
    tick: used > tick ? '' : '│',
    after: '░'.repeat(Math.max(0, width - used - before.length - (used > tick ? 0 : 1))),
  }
}

const SPARK = '▁▂▃▄▅▆▇█'

/** One block per value, scaled to the largest. */
export function spark(values: number[]): string {
  const max = Math.max(...values, 0.0001)
  return values.map(v => SPARK[Math.min(7, Math.round((v / max) * 7))]).join('')
}

/** One-line summary:"week 42% · out ~Thu 14:05". */
export function weekText(r: WeekReport): string {
  const tail = r.runsOutAt
    ? r.isOutBeforeReset
      ? `runs out ~${fmtWhen(r.runsOutAt)}`
      : `projected ${Math.round((r.ratePerDay ?? 0) * 7)}%`
    : `resets ${fmtWhen(r.endsAt)}`
  const avg = r.ratePerDay === undefined ? '' : ` · avg ${r.ratePerDay.toFixed(1)}%/day`
  return `week ${Math.round(r.pct)}% used${avg} · ${tail}`
}

const NAMES =['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number) => String(n).padStart(2, '0')

/** "Thu 14:05", local time. */
export function fmtWhen(ms: number): string {
  const d = new Date(ms)
  return `${NAMES[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** "Thu 15/10". */
export function fmtDay(ms: number): string {
  const d = new Date(ms)
  return `${NAMES[d.getDay()]} ${two(d.getDate())}/${two(d.getMonth() + 1)}`
}

/** "2d 5h", "5h 10m", "12m". */
export function fmtSpan(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

export const fmtPct = (p: number) => `${p.toFixed(1)}%`

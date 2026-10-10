import { expect, test } from 'claude-code/testing'

import { DAY, analyze, bar, recordSample, sanitizeWeeks, spark } from './weekly'

test('bar is always exactly width cells, with the tick only while behind the time mark', () => {
  for (const [pct, frac] of [[0, 0], [6, 0.5], [50, 0.5], [90, 0.2], [100, 1]] as const) {
    const b = bar(pct, frac, 20)
    expect((b.used + b.before + b.tick + b.after).length).toBe(20)
  }
  expect(bar(10, 0.5, 20).tick).toBe('│')
  expect(bar(80, 0.5, 20).tick).toBe('')
})

test('sanitizeWeeks drops malformed entries instead of throwing', () => {
  expect(sanitizeWeeks(undefined)).toEqual([])
  expect(sanitizeWeeks('nope')).toEqual([])
  const good = { endsAt: 1000, samples: [[1, 2], [3, 4]] }
  const messy = [null, 5, { endsAt: 'x', samples: [] }, { endsAt: 1, samples: 'y' }, good,
    { endsAt: 2, samples: [[1], [NaN, 1], [5, 6], 'z'] }]
  const out = sanitizeWeeks(messy)
  expect(out.length).toBe(2)
  expect(out[0]).toEqual(good)
  expect(out[1].samples).toEqual([[5, 6]])
})

test('spark scales to the largest value', () => {
  expect(spark([0, 5, 10])).toBe('▁▅█')
})

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)

test('recordSample keeps one window and skips unchanged samples', () => {
  let w = recordSample([], T0 + 7 * DAY, T0, 0)
  w = recordSample(w, T0 + 7 * DAY, T0 + 60_000, 0)
  w = recordSample(w, T0 + 7 * DAY, T0 + 120_000, 3)
  expect(w.length).toBe(1)
  expect(w[0].samples.length).toBe(2)
})

test('analyze projects run-out and splits spend per day', () => {
  const endsAt = T0 + 7 * DAY
  const week = {
    endsAt,
    samples: [
      [T0, 0],
      [T0 + 0.5 * DAY, 10],
      [T0 + 1.5 * DAY, 40],
      [T0 + 2 * DAY, 50],
    ] as [number, number][],
  }
  const r = analyze(week, T0 + 2 * DAY)!
  expect(r.pct).toBe(50)
  expect(r.ratePerDay).toBe(25)
  expect(r.isOutBeforeReset).toBe(true)
  expect(Math.round((r.runsOutAt! - (T0 + 2 * DAY)) / DAY)).toBe(2)
  expect(r.days[0].spent).toBe(10)
  expect(r.days[1].spent).toBe(40)
  expect(r.days[2].isFuture).toBe(false)
  expect(r.days[3].isFuture).toBe(true)
})

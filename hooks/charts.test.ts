import { expect, test } from 'claude-code/testing'

import { barSvg, daysSvg } from './charts'

test('barSvg draws a track, a fill and a tick, whatever the percent', () => {
  for (const pct of [0, 6, 100, 140]) {
    const s = barSvg(pct, 0.4, 'success', 180, 10)
    expect(s.startsWith('<svg')).toBe(true)
    expect(s.endsWith('</svg>')).toBe(true)
    expect(s).not.toContain('NaN')
  }
})

test('daysSvg labels every day and skips bars for future days', () => {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => ({
    label,
    spent: i < 3 ? 12 : 0,
    isFuture: i >= 3,
    isToday: i === 2,
  }))
  const s = daysSvg(days, 100 / 7, 360, 130)
  for (const d of days) expect(s).toContain(`>${d.label}</text>`)
  expect(s).not.toContain('NaN')
  expect(s.match(/fill="#2da44e"/g)?.length).toBe(3)
})

import type { Level } from './weekly'

/** Colors that read on both light and dark backgrounds; an SVG image cannot follow the theme. */
const COLORS: Record<Level, string> = { success: '#2da44e', warning: '#d4a72c', error: '#cf222e' }
const TRACK = 'rgba(128,128,128,0.28)'
const MUTED = 'rgba(128,128,128,0.95)'

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** The rounded track as a clip, so a small fill is cut to the track's own shape, never a bulge. */
const clipDef = (width: number, height: number) =>
  `<defs><clipPath id="t"><rect width="${width}" height="${height}" rx="${height / 2}"/></clipPath></defs>`

/** A rounded progress bar: `pct` filled, and a tick at `timeFrac` of the width (an even pace). */
export function barSvg(pct: number, timeFrac: number, level: Level, width: number, height: number) {
  const r = height / 2
  const fill = (clamp(Number.isFinite(pct) ? pct : 0, 0, 100) / 100) * width
  const tickX = clamp(timeFrac, 0, 1) * width
  // no tick while the window has barely begun: it would sit on the rounded end
  const isTick = timeFrac * width >= 4
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    clipDef(width, height) +
    `<rect width="${width}" height="${height}" rx="${r}" fill="${TRACK}"/>` +
    (fill > 0
      ? `<rect width="${Math.max(fill, 3)}" height="${height}" fill="${COLORS[level]}" clip-path="url(#t)"/>`
      : '') +
    (isTick
      ? `<rect x="${clamp(tickX - 1, 0, width - 2)}" y="-1" width="2" height="${height + 2}" fill="${MUTED}"/>`
      : '') +
    `</svg>`
  )
}

const BLUE = '#3b82f6'

/** A thin blue line that fills left to right with `pct`, on a faint track. */
export function lineSvg(pct: number, width: number, height: number) {
  const fill = (clamp(Number.isFinite(pct) ? pct : 0, 0, 100) / 100) * width
  const r = height / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    clipDef(width, height) +
    `<rect width="${width}" height="${height}" rx="${r}" fill="${TRACK}"/>` +
    (fill > 0 ? `<rect width="${Math.max(fill, 3)}" height="${height}" fill="${BLUE}" clip-path="url(#t)"/>` : '') +
    `</svg>`
  )
}

export type DayBar = { label: string; spent: number; isFuture: boolean; isToday: boolean }

/** Seven columns, one per day of the window, with a dashed line at the even share. */
export function daysSvg(days: DayBar[], share: number, width: number, height: number) {
  const top = 16
  const bottom = 18
  const plot = height - top - bottom
  const scale = Math.max(share * 2, ...days.map(d => d.spent))
  const col = width / days.length
  const bw = col * 0.58
  const y = (v: number) => top + plot * (1 - clamp(v / scale, 0, 1))
  const level = (v: number): Level => (v > share * 2 ? 'error' : v > share * 1.3 ? 'warning' : 'success')

  const parts = days.map((d, i) => {
    const x = i * col + (col - bw) / 2
    const cx = i * col + col / 2
    const h = d.isFuture ? 0 : Math.max(2, top + plot - y(d.spent))
    return (
      `<rect x="${x}" y="${top}" width="${bw}" height="${plot}" rx="3" fill="${TRACK}" opacity="${d.isFuture ? 0.45 : 0.18}"/>` +
      (d.isFuture
        ? ''
        : `<rect x="${x}" y="${top + plot - h}" width="${bw}" height="${h}" rx="3" fill="${COLORS[level(d.spent)]}"/>` +
          `<text x="${cx}" y="${top + plot - h - 4}" font-size="10" text-anchor="middle" fill="${MUTED}">${d.spent.toFixed(d.spent < 10 ? 1 : 0)}</text>`) +
      `<text x="${cx}" y="${height - 5}" font-size="10" text-anchor="middle" fill="${MUTED}"${d.isToday ? ' font-weight="700"' : ''}>${d.label}</text>`
    )
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">` +
    parts.join('') +
    `<line x1="0" x2="${width}" y1="${y(share)}" y2="${y(share)}" stroke="${MUTED}" stroke-width="1" stroke-dasharray="4 3"/>` +
    `</svg>`
  )
}

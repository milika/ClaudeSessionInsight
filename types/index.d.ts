export type Call = {
  id: string
  tool: string
  startedAt: number
  durationMs?: number
  isDone: boolean
}

/** One tracked seven-day rate-limit window: [timestamp ms, percent used] samples. */
export type Week = {
  endsAt: number
  samples: [number, number][]
}

declare module 'claude-code' {
  interface PluginState {
    'session-insights': {
      calls: Call[]
      prompts: number
      weeks: Week[]
      /** Context window fill, whole percent; null until the first response. */
      contextPct: number | null
      /** Whether the mod compacts on its own at the threshold. */
      isAutoCompact: boolean
      /** The five-hour limit window: percent used and when it resets (ms); null until read. */
      fiveHour: { pct: number; resetsAt: number } | null
      /** True while a compaction this mod started runs. */
      isCompacting: boolean
      resumeAt: number | null
      /** True while the insights panel is open and drawn. */
      isPanelOpen: boolean
    }
  }
}

# ClaudeSessionInsight

A [Claude Code mod](https://code.claude.com) (a hooks plugin) that keeps the things
you want to know about a session in sight.

## What it does

- **Weekly limit band** above the prompt: a progress bar for the seven-day limit with a
  tick where an even pace would be, your average %/day this week, and the projected
  total at the reset. Green, amber or red by pace.
- **Insights panel** (never opens by itself; show or hide it with the button in the band
  or `/insight-panel`): the weekly bar, a
  per-day chart of how much of the limit each day spent against an even share, prompt
  and tool-call counts, durations by tool, and the recent calls.
- **Auto-compact at 30% context**, with an on/off toggle in the band. It waits at least
  two minutes between attempts.
- **Background-task marker**: `⏳` is put at the start of the session's title while
  background tasks (shell commands, agents) are running, and removed when none are. The
  count is reconciled against the engine's own in-flight list every time the agent stops.

Everything the mod does around the session is guarded: bookkeeping failures are swallowed
and never block a prompt, a tool call or the exit.

## Install

Needs Claude Code 2.1.275 or later. In a terminal Claude Code session, at the prompt,
add the marketplace first and then install the mod from it:

```
/plugin marketplace add milika/ClaudeSessionInsight
/plugin install session-insights@claude-session-insight
```

Or the same from a shell:

```
claude plugin marketplace add milika/ClaudeSessionInsight
claude plugin install session-insights@claude-session-insight
```

User scope (the default) loads it in every session, including the desktop app's local
sessions. The mod is active at once, with no restart.

If you get `Couldn't find plugin "session-insights"`, the marketplace was not added yet:
run the first line, then install again with the `@claude-session-insight` suffix.

## Run it from a folder instead

For trying changes without installing:

```
git clone https://github.com/milika/ClaudeSessionInsight
claude --plugin-dir ./ClaudeSessionInsight
```

To load a folder in every session the desktop app starts, set `CLAUDE_CODE_PLUGIN_DIRS`
to its absolute path in the `env` block of `~/.claude/settings.json`.

## Notes

- The weekly figures come from the subscription rate-limit windows the engine reports,
  so they appear on subscription accounts only, and after the first response of a session.
  The per-day breakdown starts from when the mod first sees a reading; usage earlier in
  the week shows as one "before tracking" line.
- Samples are kept in the mod's own store (`$.store`), shared across sessions.
- The title marker uses the desktop app's session-management tool through `$.mcp.call`.
  If that tool is unavailable the marker retries, then pauses; nothing else is affected.

## Check it

```
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)

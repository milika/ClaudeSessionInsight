import { expect, test } from 'claude-code/testing'

import { register } from './register'

test('pane draws a summary and an empty by-tool list', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'session-insights',
      surface,
      component: 'Pane',
      requestId: 'session-insights',
      props: {},
    })
    const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(texts).toContain('Weekly limit')
    expect(texts).toContain('0 prompts')
    expect(texts).toContain('No tool calls yet.')
    await pane.unmount()
  }
})

test('band draws its three buttons even with no limit reading yet', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'session-insights',
      surface,
      component: 'AbovePrompt',
      requestId: 'band',
      props: { hasSurvey: false },
    })
    const buttons = await band.findAll({ type: 'Button' })
    expect(buttons.length).toBe(3) // continue-after-reset toggle, auto-compact toggle, show/hide insights
    await band.unmount()
  }
})

void register

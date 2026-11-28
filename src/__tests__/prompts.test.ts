import { describe, expect, it } from 'vitest'

import { JENKINS_ASYNC_BUILD_PROMPT, NEXT_ACTION_NO_NOTIFICATION, NEXT_ACTION_WAIT_NOTIFICATION, triggerNotice } from '../prompts.js'

describe('Jenkins async build prompt', () => {
  it('states the no-sleep/no-poll contract and notification path', () => {
    expect(JENKINS_ASYNC_BUILD_PROMPT).toContain('立即结束当前 turn')
    expect(JENKINS_ASYNC_BUILD_PROMPT).toContain('不要 sleep')
    expect(JENKINS_ASYNC_BUILD_PROMPT).toContain('不要轮询')
    expect(JENKINS_ASYNC_BUILD_PROMPT).toContain('自动向当前会话回推通知')
  })

  it('returns distinct next actions for notify on/off', () => {
    expect(NEXT_ACTION_WAIT_NOTIFICATION).not.toBe(NEXT_ACTION_NO_NOTIFICATION)
    expect(triggerNotice(true)).toContain('立即结束本轮')
    expect(triggerNotice(false)).toContain('未开启完成通知')
  })
})

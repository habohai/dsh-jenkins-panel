import { describe, expect, it, vi } from 'vitest'

import { ensureAsyncBuildPrompt, JENKINS_ASYNC_BUILD_PROMPT, NEXT_ACTION_NO_NOTIFICATION, NEXT_ACTION_WAIT_NOTIFICATION, triggerNotice } from '../prompts.js'

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


describe('per-agent async prompt registration', () => {
  it('registers once on the agent context, not globally', () => {
    const section = vi.fn(() => () => {})
    const effect = vi.fn((callback: () => unknown) => callback())
    const agent = { ctx: { systemPrompt: { section }, effect } }
    ensureAsyncBuildPrompt(agent)
    ensureAsyncBuildPrompt(agent)
    expect(section).toHaveBeenCalledTimes(1)
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'dsh-jenkins-panel:async-builds',
      text: JENKINS_ASYNC_BUILD_PROMPT,
    }))
    expect(effect).toHaveBeenCalledTimes(1)
  })

  it('registers separately for different agents and tolerates a missing prompt service', () => {
    const section = vi.fn(() => () => {})
    const effect = vi.fn((callback: () => unknown) => callback())
    ensureAsyncBuildPrompt({ ctx: { systemPrompt: { section }, effect } })
    ensureAsyncBuildPrompt({ ctx: { systemPrompt: { section }, effect } })
    expect(section).toHaveBeenCalledTimes(2)
    expect(() => ensureAsyncBuildPrompt({ ctx: {} })).not.toThrow()
    expect(() => ensureAsyncBuildPrompt(undefined)).not.toThrow()
  })
})

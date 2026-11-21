/**
 * 构建完成通知器单测：成功通知、2 秒合并、离线跳过、失败默认不重复、notify=false。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildCompletionPrompt, buildStartedPrompt, createBuildNotifications, notificationVersion } from '../notifications.js'
import type { TriggerRecord, TriggerRegistry } from '../registry.js'

function record(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    id: 'r1',
    connection: 'ai-dx',
    jobName: 'ai-dx',
    displayName: 'ai-dx',
    buildNumber: 5489,
    params: { app_name: 'taichu-web-new', GITEE_BRANCH: 'dev' },
    status: 'ok',
    triggeredAt: 1,
    statusUpdatedAt: 2,
    sessionId: 's1',
    source: 'conversation',
    notify: true,
    durationMs: 154_000,
    buildUrl: 'https://jenkins.example.com/job/ai-dx/5489/',
    ...overrides,
  }
}

function setup(overrides: Partial<Parameters<typeof createBuildNotifications>[0]> = {}) {
  const markNotification = vi.fn(async () => true)
  const markStartedNotification = vi.fn(async () => true)
  const registry = { markNotification, markStartedNotification } as unknown as TriggerRegistry
  const followup = vi.fn()
  const getAgent = vi.fn(() => ({ followup }))
  const notifier = createBuildNotifications({
    enabled: true,
    onSuccess: true,
    onFailure: false,
    onAborted: false,
    onStarted: true,
    startedThresholdMs: 30_000,
    debounceMs: 10,
    registry,
    getAgent,
    logger: () => {},
    ...overrides,
  })
  return { notifier, markNotification, markStartedNotification, followup, getAgent }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('构建完成通知', () => {
  it('成功构建回推一条通知并标记 pending → sent', async () => {
    const { notifier, markNotification, followup } = setup()
    await notifier.handle(record(), 'running', 'ok')
    await vi.advanceTimersByTimeAsync(11)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(markNotification).toHaveBeenNthCalledWith(1, 'r1', 'pending')
    expect(markNotification).toHaveBeenNthCalledWith(2, 'r1', 'sent')
    const message = followup.mock.calls[0]![0] as { content: Array<{ text: string }> }
    expect(message.content[0]!.text).toContain('taichu-web-new.ai-dx')
    expect(message.content[0]!.text).toContain('分支 dev')
    expect(message.content[0]!.text).toContain('2m 34s')
  })

  it('同一会话 2 秒内完成多个构建合并为一条', async () => {
    const { notifier, followup } = setup()
    await notifier.handle(record({ id: 'r1' }), 'running', 'ok')
    await notifier.handle(record({ id: 'r2', buildNumber: 5490 }), 'running', 'ok')
    await vi.advanceTimersByTimeAsync(11)
    expect(followup).toHaveBeenCalledTimes(1)
    const text = (followup.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('#5489')
    expect(text).toContain('#5490')
  })

  it('会话离线时标记 skipped，不注入', async () => {
    const { notifier, markNotification, followup } = setup({ getAgent: () => undefined })
    await notifier.handle(record(), 'running', 'ok')
    await vi.advanceTimersByTimeAsync(11)
    expect(followup).not.toHaveBeenCalled()
    expect(markNotification).toHaveBeenCalledWith('r1', 'skipped')
  })

  it('notify=false 或失败默认关闭时不通知', async () => {
    const disabled = setup()
    await disabled.notifier.handle(record({ notify: false }), 'running', 'ok')
    await vi.advanceTimersByTimeAsync(11)
    expect(disabled.followup).not.toHaveBeenCalled()

    const failure = setup()
    await failure.notifier.handle(record({ status: 'fail', rawResult: 'FAILURE' }), 'running', 'fail')
    await vi.advanceTimersByTimeAsync(11)
    expect(failure.followup).not.toHaveBeenCalled()
  })
})

describe('通知文案', () => {
  it('展示 app、版本和耗时，并提醒不要自动重试', () => {
    const text = buildCompletionPrompt([record({ failureStage: 'docker_login' })])
    expect(text).toContain('taichu-web-new.ai-dx')
    expect(text).toContain('失败阶段: docker_login')
    expect(text).toContain('分支 dev')
    expect(text).toContain('2m 34s')
    expect(text).toContain('不要再次触发构建')
  })

  it('版本按 Tag → 分支 → Commit 取值', () => {
    expect(notificationVersion({ params: { TAG_NAME: 'v1.2.3', GITEE_BRANCH: 'dev' } })).toBe('Tag v1.2.3')
    expect(notificationVersion({ params: { GITEE_BRANCH: 'origin/dev' } })).toBe('分支 dev')
    expect(notificationVersion({ params: { GIT_COMMIT: 'abcdef1234567890' } })).toBe('Commit abcdef12')
  })
})


describe('构建开始通知（排队阈值）', () => {
  it('排队超过阈值才发，且只发一次', async () => {
    vi.setSystemTime(100_000)
    const { notifier, followup, markStartedNotification } = setup()
    const started = record({ id: 'started', triggeredAt: 60_000, startedNotification: undefined })
    await notifier.handleStarted(started)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(markStartedNotification).toHaveBeenCalledWith('started', 'sent')
    const text = (followup.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('triggerId: started')
    expect(text).toContain('构建在排队约 40 秒后已开始')
  })

  it('快速开始的构建不发，标记 skipped', async () => {
    vi.setSystemTime(100_000)
    const { notifier, followup, markStartedNotification } = setup()
    await notifier.handleStarted(record({ id: 'fast', triggeredAt: 99_000, startedNotification: undefined }))
    expect(followup).not.toHaveBeenCalled()
    expect(markStartedNotification).toHaveBeenCalledWith('fast', 'skipped')
  })
})

describe('开始通知文案', () => {
  it('包含 triggerId、构建号和阈值说明', () => {
    const text = buildStartedPrompt(record())
    expect(text).toContain('triggerId: r1')
    expect(text).toContain('#5489')
    expect(text).toContain('不是要求轮询')
  })
})

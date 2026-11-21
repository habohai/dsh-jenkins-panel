/**
 * 构建完成主动通知（成功/失败/取消 → 回推触发 Session）。
 *
 * 设计边界（与需求方确认）：
 * - 只通知 `notify=true` 的插件触发记录；手动构建不在此链路；
 * - 失败默认仍由 failure-analysis 推送分析任务，notifications.onFailure 默认关闭，避免双唤醒；
 * - 同一 Session 的完成事件在 debounceMs 内合并为一条；隔几分钟完成的构建仍分别通知；
 * - 只回 DSH Session（ctx.agents.get(sessionId).followup），不发飞书群；
 * - 会话不在线时标记 skipped 并记日志，不做 pending 补推（第二阶段再考虑）；
 * - 通知只带元数据，日志由模型按需调用 jenkins_build_log，避免撑上下文。
 */
import { createUserMessage, type ContentBlock, type MessageSourceMap, type UserMessage } from '@deepseek-ai/dsh-llm'

import { redactParams } from './params.js'
import type { TriggerRecord, TriggerRegistry, TriggerStatus } from './registry.js'

/** 活跃 agent 的最小面（与 failure-analysis 一致） */
export interface NotificationAgentLike {
  followup(message: UserMessage): void
}

export interface BuildNotificationsOptions {
  enabled: boolean
  onSuccess: boolean
  onFailure: boolean
  onAborted: boolean
  onStarted: boolean
  startedThresholdMs: number
  debounceMs: number
  registry: TriggerRegistry
  getAgent: (sessionId: string) => NotificationAgentLike | undefined
  logger?: (message: string) => void
}

export interface BuildNotifications {
  /** registry 的 onBuildStarted 入口（排队超过阈值的构建才通知） */
  handleStarted(record: TriggerRecord): Promise<void>
  /** registry 的 onBuildTerminal 入口 */
  handle(record: TriggerRecord, previous: TriggerStatus, next: TriggerStatus): Promise<void>
  /** 插件卸载：清 timer，pending 标记 skipped（不阻塞） */
  dispose(): void
}

/** 展示用耗时（与面板口径一致：<60s、m+s、h+m） */
export function formatNotificationDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** 触发参数里的版本信息（Tag / 分支 / Commit；与总览展示同口径）。 */
export function notificationVersion(record: Pick<TriggerRecord, 'params'>): string {
  const groups: Array<[string, readonly string[]]> = [
    ['Tag', ['GITEE_TAG', 'GIT_TAG', 'TAG_NAME', 'TAG', 'git_tag', 'tag', 'release_tag']],
    ['分支', ['GITEE_BRANCH', 'GIT_BRANCH', 'BRANCH_NAME', 'BRANCH', 'git_branch', 'branch']],
    ['Commit', ['GITEE_COMMIT', 'GIT_COMMIT', 'COMMIT_ID', 'COMMIT', 'GIT_SHA', 'SHA', 'commit_id', 'git_commit', 'commit']],
  ]
  for (const [label, keys] of groups) {
    for (const key of keys) {
      const raw = record.params?.[key]
      if (typeof raw !== 'string') continue
      let value = raw.trim().replace(/^refs\/tags\//, '').replace(/^refs\/heads\//, '').replace(/^origin\//, '')
      if (value === '') continue
      if (label === 'Commit' && /^[0-9a-f]{10,40}$/i.test(value)) value = value.slice(0, 8)
      return `${label} ${value}`
    }
  }
  return ''
}

/** 单条构建摘要（通知正文一行） */
export function buildCompletionLine(record: TriggerRecord): string {
  const app = typeof record.params?.app_name === 'string' ? record.params.app_name.trim() : ''
  const title = app !== '' ? `${app}.${record.displayName}` : record.displayName
  const version = notificationVersion(record)
  const result = record.rawResult === 'UNSTABLE'
    ? 'UNSTABLE（不稳定）'
    : record.status === 'ok' ? 'SUCCESS' : record.status === 'fail' ? 'FAILURE' : 'ABORTED'
  const duration = formatNotificationDuration(record.durationMs)
  const build = record.buildNumber != null ? `#${record.buildNumber}` : ''
  const parts = [title, build, version, result, duration !== '' ? `耗时 ${duration}` : ''].filter((part) => part !== '')
  return `- ${parts.join(' · ')}${record.buildUrl ? `\n  ${record.buildUrl}` : ''}${record.failureStage ? `\n  失败阶段: ${record.failureStage}` : ''}`
}

/** 排队超过阈值的构建开始通知正文。 */
export function buildStartedPrompt(record: TriggerRecord): string {
  const app = typeof record.params?.app_name === 'string' ? record.params.app_name.trim() : ''
  const title = app !== '' ? `${app}.${record.displayName}` : record.displayName
  const version = notificationVersion(record)
  const queueSeconds = Math.max(0, Math.round((Date.now() - record.triggeredAt) / 1000))
  return [
    '[构建开始通知 | dsh-jenkins-panel]',
    `构建在排队约 ${queueSeconds} 秒后已开始：`,
    `- triggerId: ${record.id}`,
    `- 任务: ${title}${record.buildNumber != null ? ` #${record.buildNumber}` : ''}`,
    ...(version !== '' ? [`- 版本: ${version}`] : []),
    ...(record.buildUrl !== undefined ? [`- 链接: ${record.buildUrl}`] : []),
    ...(Object.keys(redactParams(record.params)).length > 0 ? [`- 参数: ${JSON.stringify(redactParams(record.params))}`] : []),
    '',
    '这是开始通知，不是要求轮询。构建完成后会再发完成通知。',
  ].join('\n')
}

/** 注入消息正文（失败仍由 failure-analysis 另发，不在这里重复） */
export function buildCompletionPrompt(records: readonly TriggerRecord[]): string {
  return [
    '[构建完成通知 | dsh-jenkins-panel]',
    '你触发的 Jenkins 构建已结束：',
    ...records.map(buildCompletionLine),
    ...records.map((record) => `- triggerId: ${record.id}`),
    '',
    '这是完成通知，不是自动重试指令。',
    '需要查看日志时调用 jenkins_build_log（可按 tail/分段读取）；',
    '除非用户原任务明确要求，否则不要再次触发构建或重试。',
  ].join('\n')
}

/** 创建通知器（index.ts 在 registry 之后接线 onBuildTerminal） */
export function createBuildNotifications(options: BuildNotificationsOptions): BuildNotifications {
  const logger = options.logger ?? ((message: string) => console.log(message))
  const pending = new Map<string, { records: TriggerRecord[]; timer?: ReturnType<typeof setTimeout> }>()
  const handled = new Set<string>()
  let disposed = false

  const markAll = async (records: readonly TriggerRecord[], state: 'skipped' | 'sent' | 'failed'): Promise<void> => {
    for (const record of records) {
      try {
        await options.registry.markNotification(record.id, state)
      } catch (err) {
        logger(`[dsh-jenkins-panel] 通知状态写盘失败（${record.displayName}）：${String(err)}`)
      }
    }
  }

  const flush = async (sessionId: string): Promise<void> => {
    const batch = pending.get(sessionId)
    if (batch === undefined) return
    pending.delete(sessionId)
    if (batch.timer !== undefined) clearTimeout(batch.timer)
    if (batch.records.length === 0) return
    const agent = (() => {
      try {
        return options.getAgent(sessionId)
      } catch {
        return undefined
      }
    })()
    if (agent === undefined || typeof agent.followup !== 'function') {
      logger(`[dsh-jenkins-panel] 会话不在线，跳过完成通知：sessionId=${sessionId}`)
      await markAll(batch.records, 'skipped')
      return
    }
    const summary = batch.records.length === 1
      ? `Jenkins 构建完成：${batch.records[0]!.displayName} ${batch.records[0]!.buildNumber != null ? `#${batch.records[0]!.buildNumber}` : ''}`.trim()
      : `Jenkins 完成 ${batch.records.length} 个构建`
    const source: MessageSourceMap['jenkins-panel'] = {
      kind: 'jenkins-panel',
      form: 'notice',
      summary: summary.slice(0, 120),
    }
    const content: ContentBlock[] = [{ type: 'text', text: buildCompletionPrompt(batch.records) }]
    try {
      agent.followup(createUserMessage({ content, source }))
      await markAll(batch.records, 'sent')
    } catch (err) {
      logger(`[dsh-jenkins-panel] 完成通知注入失败：${String(err)}`)
      await markAll(batch.records, 'failed')
    }
  }

  return {
    async handleStarted(record): Promise<void> {
      if (disposed) return
      if (!options.enabled || !options.onStarted || record.notify !== true) return
      if (record.startedNotification !== undefined) return
      const waited = Date.now() - record.triggeredAt
      if (waited < options.startedThresholdMs) {
        await options.registry.markStartedNotification(record.id, 'skipped')
        return
      }
      const agent = (() => {
        try {
          return options.getAgent(record.sessionId)
        } catch {
          return undefined
        }
      })()
      if (agent === undefined || typeof agent.followup !== 'function') {
        logger(`[dsh-jenkins-panel] 会话不在线，跳过开始通知：sessionId=${record.sessionId}`)
        await options.registry.markStartedNotification(record.id, 'skipped')
        return
      }
      const source: MessageSourceMap['jenkins-panel'] = {
        kind: 'jenkins-panel',
        form: 'notice',
        summary: `Jenkins 构建已开始：${record.displayName}`.slice(0, 120),
      }
      try {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: buildStartedPrompt(record) }], source }))
        await options.registry.markStartedNotification(record.id, 'sent')
      } catch (err) {
        logger(`[dsh-jenkins-panel] 开始通知注入失败：${String(err)}`)
        await options.registry.markStartedNotification(record.id, 'failed')
      }
    },

    async handle(record, _previous, next): Promise<void> {
      if (disposed) return
      if (!options.enabled || record.notify !== true) return
      if (record.notification !== undefined) return
      const enabled = next === 'ok'
        ? options.onSuccess
        : next === 'aborted' ? options.onAborted : options.onFailure
      if (!enabled) return
      if (record.sessionId === '' || handled.has(record.id)) return
      handled.add(record.id)
      // pending 先落盘，防止同一 terminal 流转被重复处理；真正发送后再改 sent。
      await options.registry.markNotification(record.id, 'pending')
      const batch = pending.get(record.sessionId) ?? { records: [] }
      batch.records.push(record)
      if (batch.timer === undefined) {
        batch.timer = setTimeout(() => { void flush(record.sessionId) }, Math.max(0, options.debounceMs))
        batch.timer.unref?.()
      }
      pending.set(record.sessionId, batch)
    },

    dispose(): void {
      disposed = true
      for (const [sessionId, batch] of pending) {
        if (batch.timer !== undefined) clearTimeout(batch.timer)
        void markAll(batch.records, 'skipped')
        pending.delete(sessionId)
      }
    },
  }
}

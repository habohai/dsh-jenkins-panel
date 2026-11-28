/** 触发后行为约束：工具描述/返回只能提示，系统提示负责让模型在触发前就知道。 */
export const JENKINS_ASYNC_BUILD_PROMPT = [
  '## Jenkins 构建是异步的',
  '调用 jenkins_build_trigger 或 jenkins_build_retry 成功后，构建已在后台运行。',
  '除非用户明确要求同步等待，否则必须立即结束当前 turn：不要 sleep、不要轮询、不要写 Python/Bash 等待脚本。',
  '插件会在构建开始（排队超过阈值）和完成时自动向当前会话回推通知；收到通知后再继续处理。',
  '触发结果里的 queueUrl 可立即告知用户；需要构建号/构建链接时等待通知，不要为了拿它轮询。',
].join('\n')

/** trigger/retry 返回值里的下一步动作（模型可见的显式契约）。 */
export const NEXT_ACTION_WAIT_NOTIFICATION = 'end_turn_and_wait_for_jenkins_notification'
export const NEXT_ACTION_NO_NOTIFICATION = 'end_turn_or_query_status_later'

export function triggerNotice(notify: boolean): string {
  return notify
    ? '构建已异步触发。请立即结束本轮，不要 sleep/轮询；开始/完成通知会自动回推到当前会话。'
    : '构建已异步触发；本次未开启完成通知，需要状态时再调用 jenkins_build_status。'
}

/** 仅用于从 dsh ToolRunContext 拿到的 agent 最小结构面（不依赖完整 Agent 类型）。 */
export interface PromptAgentLike {
  ctx?: {
    systemPrompt?: {
      section: (section: { name: string; order: number; text: string }) => unknown
    }
    effect?: (callback: () => unknown, label?: string) => unknown
  }
}

const promptedAgents = new WeakSet<object>()

/**
 * 首次真正使用 Jenkins 触发/重试工具时，仅给该 agent 注册异步提示。
 * 不做全局 systemPrompt 注册，避免所有会话都承担固定 token。
 * 首次调用的即时约束由工具返回的 nextAction/notice 承担；此提示从下一次请求开始生效。
 */
export function ensureAsyncBuildPrompt(agent: unknown): void {
  if (agent === undefined || agent === null || typeof agent !== 'object') return
  const candidate = agent as PromptAgentLike
  const ctx = candidate.ctx
  if (ctx === undefined) return
  const section = ctx.systemPrompt?.section
  if (section === undefined || promptedAgents.has(candidate)) return
  promptedAgents.add(candidate)
  const register = (): unknown => section({
    name: 'dsh-jenkins-panel:async-builds',
    order: 1600,
    text: JENKINS_ASYNC_BUILD_PROMPT,
  })
  try {
    if (ctx.effect !== undefined) ctx.effect(register, 'dsh-jenkins-panel: async build prompt')
    else register()
  } catch (err) {
    promptedAgents.delete(candidate)
    console.warn(`[dsh-jenkins-panel] 注册异步构建提示失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

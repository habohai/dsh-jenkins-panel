/** 参数脱敏：触发响应/通知只回放安全字段，绝不把密码类值暴露给模型或会话记录。 */
const SENSITIVE = /(pass(word|wd)?|pwd|token|secret|api[_-]?key|credential|authorization|private[_-]?key)/i

export function redactParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (params === undefined) return {}
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    result[key] = SENSITIVE.test(key) ? '***' : value
  }
  return result
}

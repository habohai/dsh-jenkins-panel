/**
 * 面板「总览」视图（CLIENT-M2-03；docs §3.3 OverviewView、prototype .chips/.row 口径）
 *
 * - 数据：`triggered.list`（跨连接混合，按 sessionId 隔离，必须带 sessionId）→ `{ records, total }`；
 * - 状态过滤 chips：全部/排队中/构建中/成功/失败/已取消（**多选**；空选 = 全部；
 *   「排队中+构建中」= 原「运行中」视角，不设独立 tab）；「全部」计数 = total，各状态计数 =
 *   已加载记录（分页数据，标注说明）；
 * - 记录行：状态点 + displayName + job 路径 + #号/排队中 + 连接 tag + 时间/状态文案；
 *   点击 → 构建详情（BuildDetailEntry 直接映射，status 同口径 M2-06 deriveState 兜底）；
 * - 刷新联动：`visible` 门控轮询（15s 重拉当前视图）+ 手动刷新（面板头部按钮经
 *   refreshToken 传入 + 视图内刷新按钮）+ 打开构建详情强制刷新（onOpenBuild 后 reload）；
 * - 删除只在构建详情里操作（列表不提供删除入口，避免误删）；
 *
 * 纯函数（matchesFilter / statusDotClass / formatRecordTime / buildListQuery）导出供单测。
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchTriggeredList,
  listConnections,
  type ConnectionInfo,
  type TriggerRecord,
  type TriggeredListResult,
  type TriggerStatus,
} from '../api.js'
import type { BuildDetailEntry } from './build-detail-view.js'

export interface OverviewViewProps {
  sessionId?: string
  /** 面板是否可见（官方右侧栏展开且本页签激活；0.1.5 起由宿主注入，替代原 panelStore.isVisible） */
  visible: boolean
  /** 面板头部刷新按钮递增 → 强制重拉 */
  refreshToken: number
  /** 记录行点击 → 构建详情（M2-06） */
  onOpenBuild: (entry: BuildDetailEntry) => void
}

/** 默认每页条数 / 加载更多步长 */
export const OVERVIEW_PAGE_SIZE = 50
/** visible 门控轮询间隔（host registry.pollIntervalMs 默认 15s，客户端联动刷新） */
export const OVERVIEW_POLL_INTERVAL_MS = 15_000

const STATUS_TEXT: Record<TriggerStatus, string> = {
  queued: '排队中',
  running: '构建中',
  ok: '成功',
  fail: '失败',
  aborted: '已取消',
}

const CHIP_ORDER: TriggerStatus[] = ['queued', 'running', 'ok', 'fail', 'aborted']

/** 过滤匹配（纯函数）：空选 = 全部 */
export function matchesFilter(status: TriggerStatus, selected: ReadonlySet<TriggerStatus>): boolean {
  return selected.size === 0 || selected.has(status)
}

/** 状态点 CSS 类（纯函数） */
export function statusDotClass(status: TriggerStatus): string {
  switch (status) {
    case 'ok':
      return 'jenkins_stOk'
    case 'fail':
      return 'jenkins_stFail'
    case 'running':
      return 'jenkins_stRun'
    case 'queued':
      return 'jenkins_stQueued'
    case 'aborted':
      return 'jenkins_stAborted'
  }
}

/** 总览行主标签：有 app_name 时显示 `<app_name>.<job>`，否则沿用 displayName。 */
export function overviewRecordLabel(record: Pick<TriggerRecord, 'displayName' | 'jobName' | 'params'>): string {
  const base = record.displayName.trim() !== '' ? record.displayName.trim() : record.jobName
  const app = typeof record.params?.app_name === 'string' ? record.params.app_name.trim() : ''
  if (app === '' || base.toLowerCase().startsWith(`${app.toLowerCase()}.`)) return base
  return `${app}.${base}`
}

/** 构建版本：Tag / 分支 / Commit，用于总览第二行。 */
export type OverviewVersionKind = 'tag' | 'branch' | 'commit'

export interface OverviewVersion {
  kind: OverviewVersionKind
  value: string
}

const VERSION_KEYS: Record<OverviewVersionKind, readonly string[]> = {
  tag: ['GITEE_TAG', 'GIT_TAG', 'TAG_NAME', 'TAG', 'git_tag', 'tag', 'release_tag'],
  branch: ['GITEE_BRANCH', 'GIT_BRANCH', 'BRANCH_NAME', 'BRANCH', 'git_branch', 'branch'],
  commit: ['GITEE_COMMIT', 'GIT_COMMIT', 'COMMIT_ID', 'COMMIT', 'GIT_SHA', 'SHA', 'commit_id', 'git_commit', 'commit'],
}

/** 从触发参数里取一个用于展示的构建版本；Tag 优先，其次分支，最后 Commit。 */
export function overviewVersion(record: Pick<TriggerRecord, 'params'>): OverviewVersion | undefined {
  for (const kind of ['tag', 'branch', 'commit'] as const) {
    for (const key of VERSION_KEYS[kind]) {
      const raw = record.params?.[key]
      if (typeof raw !== 'string') continue
      let value = raw.trim()
      if (value === '') continue
      value = value.replace(/^refs\/tags\//, '').replace(/^refs\/heads\//, '').replace(/^origin\//, '')
      if (kind === 'commit' && /^[0-9a-f]{10,40}$/i.test(value)) value = value.slice(0, 8)
      if (value !== '') return { kind, value }
    }
  }
  return undefined
}

/** 兼容旧调用：只取分支，不展示 tag/commit。 */
export function overviewBranch(record: Pick<TriggerRecord, 'params'>): string | undefined {
  const version = overviewVersion(record)
  return version?.kind === 'branch' ? version.value : undefined
}

/** 触发时间显示/** 触发时间显示（epoch ms → 本地 HH:MM:SS；无效 → '—'） */
export function formatRecordTime(ts: number | undefined): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

/** triggered.list 查询构造（纯函数）：空选不带 status（= 全部） */
export function buildListQuery(
  filter: ReadonlySet<TriggerStatus>,
  limit: number,
): { status?: TriggerStatus[]; limit: number } {
  return filter.size > 0 ? { status: CHIP_ORDER.filter((s) => filter.has(s)), limit } : { limit }
}

/**
 * 工作区过滤未生效时的如实提示（P0-b；纯函数，供单测）。
 *
 * 用户报障：重启后「当前工作区」chip 亮着，却列出全部工作区的记录。host 侧旧行为在解析不到
 * 当前工作区时**静默**降级为"不过滤"（为保住记录可见性），但面板不吭声 → UI 说谎。
 * 现在 host 用 `workspaceResolved=false` 如实标注，这里据此出提示。
 * @returns 需要展示的提示文案；无需提示时 null
 */
export function workspaceFilterNotice(workspace: 'current' | 'all', workspaceResolved?: boolean): string | null {
  if (workspace !== 'current') return null
  if (workspaceResolved !== false) return null
  return '未能解析当前工作区（本会话未归属任何工作区），下列记录来自全部工作区'
}

/** 连接下拉（自定义，不用原生 <select>，风格对齐 dsh/Codex UI） */
function ConnectionSelect({
  connections,
  value,
  onChange,
}: {
  connections: ConnectionInfo[]
  value: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const label = value || '全部连接'
  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
  }

  return (
    <div className="jenkins_selectWrap" ref={rootRef} data-open={open || undefined}>
      <button type="button" className="jenkins_selectTrigger" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="jenkins_selectValue">{label}</span>
        <svg className="jenkins_selectChevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="jenkins_selectMenu" role="listbox" aria-label="按连接过滤">
          <li
            className={value === '' ? 'jenkins_selectOption jenkins_selectOptionOn' : 'jenkins_selectOption'}
            role="option"
            aria-selected={value === ''}
            onClick={() => pick('')}
          >
            <span className="jenkins_selectOptionLabel">全部连接</span>
          </li>
          {connections.map((c) => (
            <li
              key={c.name}
              className={value === c.name ? 'jenkins_selectOption jenkins_selectOptionOn' : 'jenkins_selectOption'}
              role="option"
              aria-selected={value === c.name}
              onClick={() => pick(c.name)}
            >
              <span className="jenkins_selectOptionLabel">{c.name}</span>
              {c.isDefault && <span className="jenkins_selectOptionTag">默认</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Icons for Tag / branch / commit. */
function VersionGlyph({ kind }: { kind: OverviewVersionKind }) {
  if (kind === 'tag') {
    return (
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2 2h3l5 5-3 3-5-5V2Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
        <circle cx="4" cy="4" r=".75" fill="currentColor" />
      </svg>
    )
  }
  if (kind === 'commit') {
    return (
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1" />
        <path d="M1 6h3M8 6h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="3" cy="2" r="1.1" stroke="currentColor" strokeWidth="1" />
      <circle cx="3" cy="10" r="1.1" stroke="currentColor" strokeWidth="1" />
      <circle cx="9" cy="4" r="1.1" stroke="currentColor" strokeWidth="1" />
      <path d="M3 3.1v5.8M9 5.1v1a2.9 2.9 0 0 1-2.9 2.9H3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

/** One Tag / branch / commit chip for the metadata line. */
function VersionChip({ record }: { record: TriggerRecord }) {
  const version = overviewVersion(record)
  if (version === undefined) return null
  const label = version.kind === 'tag' ? 'Tag' : version.kind === 'branch' ? '分支' : 'Commit'
  return (
    <span className="jenkins_versionTag" data-kind={version.kind} title={`${label} ${version.value}`}>
      <VersionGlyph kind={version.kind} />
      <span className="jenkins_versionText">{version.value}</span>
    </span>
  )
}

export function OverviewView({ sessionId, visible, refreshToken, onOpenBuild }: OverviewViewProps) {
  const [result, setResult] = useState<TriggeredListResult | null>(null)
  const [filter, setFilter] = useState<ReadonlySet<TriggerStatus>>(new Set())
  const [limit, setLimit] = useState(OVERVIEW_PAGE_SIZE)
  const [reloadTick, setReloadTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // V7：工作区过滤（默认「当前工作区」）+ 连接下拉过滤
  const [workspace, setWorkspace] = useState<'current' | 'all'>('current')
  const [connection, setConnection] = useState('')
  const [connections, setConnections] = useState<ConnectionInfo[]>([])


  // 连接列表（下拉数据源）：conn.list 只含名称/默认标记/是否有 Token
  useEffect(() => {
    let cancelled = false
    listConnections()
      .then((list) => {
        if (!cancelled) setConnections(list)
      })
      .catch(() => {
        if (!cancelled) setConnections([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 加载查询：workspace='current' 需 sessionId 供 host 解析当前工作区；connection='' 不按连接过滤
  const buildQuery = () =>
    fetchTriggeredList({
      sessionId: workspace === 'current' ? sessionId : undefined,
      workspace,
      connection: connection || undefined,
      ...buildListQuery(filter, limit),
    })

  // 主加载：filter/limit/workspace/connection/refreshToken/reloadTick 变化时重拉当前页
  useEffect(() => {
    if (workspace === 'current' && !sessionId) return
    let cancelled = false
    setError(null)
    buildQuery()
      .then((res) => {
        if (!cancelled) setResult(res)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, filter, limit, workspace, connection, refreshToken, reloadTick])

  // visible 门控轮询：面板打开期间按 pollInterval 重拉（host 注册表状态在后台更新）
  useEffect(() => {
    if (!visible) return
    if (workspace === 'current' && !sessionId) return
    const timer = setInterval(() => {
      buildQuery()
        .then((res) => setResult(res))
        .catch(() => {
          // 轮询瞬时错误静默，下一轮重试
        })
    }, OVERVIEW_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [visible, sessionId, workspace, connection, filter, limit])

  const toggleFilter = (status: TriggerStatus) => {
    setFilter((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  const reload = () => setReloadTick((n) => n + 1)

  // 操作提示自动消失（用户反馈：删除提示不应一直展示）：3s 后清除；
  // timer ref 防竞态（连续操作时旧 timer 不得清掉新消息），卸载时清理。
  // 计数：优先 host 返回的基础作用域 counts（不受 status 过滤影响）；缺省回退按已加载记录统计
  const counts = useMemo(() => {
    // 会话级 counts（host 恒返回当前基础作用域分布，不受状态过滤影响）优先 —— 过滤只改数据区，不改统计。
    // 旧后端/测试无 counts 时回退：all = 过滤后 total，各状态 = 已加载记录（仅作兼容）。
    const base = result?.counts
    const c: Record<string, number> = { all: base?.all ?? result?.total ?? 0 }
    for (const st of CHIP_ORDER) c[st] = base?.[st] ?? 0
    if (!base) for (const r of result?.records ?? []) c[r.status]++
    return c
  }, [result])

  const records = result?.records ?? []
  // P0-b：host 如实标注"当前工作区未解析"时，显式提示，避免 chip 与列表内容不符却不吭声
  const wsNotice = workspaceFilterNotice(workspace, result?.workspaceResolved)

  return (
    <div className="jenkins_overview" data-dsh-jenkins-panel-overview="">
      <div className="jenkins_overviewToolbar">
        <label className="jenkins_connLabel">连接</label>
        <ConnectionSelect connections={connections} value={connection} onChange={setConnection} />
        <span className="jenkins_overviewToolbarRight">
          <button
            type="button"
            className={workspace === 'current' ? 'jenkins_chip jenkins_chipOn' : 'jenkins_chip'}
            title="默认只显示当前会话所在工作区触发的任务；点击切换为全部"
            onClick={() => setWorkspace(workspace === 'current' ? 'all' : 'current')}
          >
            当前工作区
          </button>
          <button type="button" className="jenkins_pillBtn" onClick={reload}>
            刷新
          </button>
        </span>
      </div>

      {wsNotice && (
        <div className="jenkins_wsWarn" role="status" data-dsh-jenkins-panel-ws-warn="">
          {wsNotice}
        </div>
      )}

      <div className="jenkins_chips">
        <span
          className={filter.size === 0 ? 'jenkins_chip jenkins_chipOn' : 'jenkins_chip'}
          data-chip="all"
          onClick={() => setFilter(new Set())}
        >
          全部 <span className="jenkins_chipCount">{counts.all}</span>
        </span>
        {CHIP_ORDER.map((st) => (
          <span
            key={st}
            className={filter.has(st) ? 'jenkins_chip jenkins_chipOn' : 'jenkins_chip'}
            data-chip={st}
            onClick={() => toggleFilter(st)}
          >
            {STATUS_TEXT[st]} <span className="jenkins_chipCount">{counts[st]}</span>
          </span>
        ))}
      </div>

      {!sessionId ? (
        <div className="jenkins_empty">无激活会话</div>
      ) : error && !result ? (
        <div className="jenkins_empty">加载失败：{error}</div>
      ) : !result ? (
        <div className="jenkins_empty">加载记录…</div>
      ) : records.length === 0 ? (
        <div className="jenkins_empty">
          {filter.size === 0 ? '暂无触发记录（对话触发构建后出现在这里）' : '无符合该状态的记录'}
        </div>
      ) : (
        <>
          {records.map((r) => (
            <div
              key={r.id}
              className="jenkins_row"
              data-go-overview-build={r.id}
              onClick={() => {
                onOpenBuild({
                  connection: r.connection,
                  jobName: r.jobName,
                  buildNumber: r.buildNumber,
                  displayName: overviewRecordLabel(r),
                  status: r.status,
                  params: r.params,
                  // 记录 id 带入详情：构建已被 Jenkins 过期清理时可就地删除这条失效记录
                  recordId: r.id,
                })
                reload() // 打开构建详情强制刷新一次
              }}
              title={`打开 ${r.jobName}${r.buildNumber ? ` #${r.buildNumber}` : ''}`}
            >
              <span className={`jenkins_st ${statusDotClass(r.status)}`} />
              <span className="jenkins_rowMain">
                <span className="jenkins_overviewTop">
                  <span className="jenkins_tnodeDisplay">{overviewRecordLabel(r)}</span>
                  <span className="jenkins_overviewBuild">
                    {r.buildNumber ? `#${r.buildNumber}` : '排队中'}
                  </span>
                  <span className="jenkins_overviewMeta">
                    <span className="jenkins_overviewStatus">{STATUS_TEXT[r.status]}</span>
                    <span className="jenkins_overviewTime">{formatRecordTime(r.triggeredAt)}</span>
                  </span>
                </span>
                <span className="jenkins_overviewBottom">
                  <span className="jenkins_connTag">{r.connection}</span>
                  <VersionChip record={r} />
                  {r.workspaceName && (
                    <span className="jenkins_wsTag" title={r.workspaceName}>{r.workspaceName}</span>
                  )}
                  <span className="jenkins_overviewJob">{r.jobName}</span>
                </span>
              </span>
            </div>
          ))}
          {records.length < result.total && (
            <div className="jenkins_toolbar" style={{ marginTop: 8 }}>
              <button type="button" className="jenkins_pillBtn" onClick={() => setLimit((n) => n + OVERVIEW_PAGE_SIZE)}>
                加载更多（{records.length}/{result.total}）
              </button>
            </div>
          )}
          {error && <div className="jenkins_tnodeError">{error}</div>}
        </>
      )}
      <div className="jenkins_note">
        记录来自插件「触发记录注册表」：仅存元数据；默认按当前会话所在工作区聚合（可切「全部」），可按连接/状态收敛；排队中/构建中由 host 自动轮询更新（面板打开期间联动刷新）。
      </div>
    </div>
  )
}

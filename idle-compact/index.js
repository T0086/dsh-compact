// idle-compact · 闲置压缩
//
// 为什么必须等"人走开了"才压：
//   压缩会改写会话历史的前缀。前缀一变，provider 的 KV cache 就整段失效，
//   之后每一步都要重新算全部历史 —— 压缩本身反而更贵。
//   所以只在「用户已经安静足够久、会话也没在跑」的边界上压，且一轮对话只压一次。
//
// 判定链（缺一不压）：
//   enabled → 不在运行 → 本轮没压过 → 静满 idleMs → 距上次模型动作超过半程
//
// 先 dryRun 验证判定，再开真压。

export const name = 'idle-compact'
export const inject = ['compaction', 'agents']

import { appendFileSync, mkdirSync } from 'node:fs'

const LOG_FILE = 'D:\\DeepSeek\\workspace\\tmp\\idle-compact.log'

export function apply(ctx, config) {
  const cfg = {
    enabled: true,
    idleMs: 30 * 60 * 1000,
    scanMs: 60 * 1000,
    halfLifeMs: null, // 默认取 idleMs/2
    dryRun: true,
    ...(config || {}),
  }
  const halfMs = Number(cfg.halfLifeMs) > 0 ? Number(cfg.halfLifeMs) : Math.floor(cfg.idleMs / 2)

  const agents = new Map()      // sessionId -> agent
  const lastUserAt = new Map()  // sessionId -> 最后一条用户消息时间
  const lastActionAt = new Map() // sessionId -> 最后一次模型侧动静（状态转 running）
  const compacted = new Map()   // sessionId -> 本轮已压时间（用户下条消息解锁）
  const failUntil = new Map()   // sessionId -> 失败冷却到期时间（失败不锁死，只退避）
  let running = new Set()
  let timer = null
  let disposed = false

  const log = (...a) => console.log('[idle-compact]', ...a)

  function trace(line) {
    const text = `${new Date().toISOString()} ${line}`
    log(line)
    // 落文件是为了在没有控制台的环境里也能确认判定到底走了哪一步
    try {
      mkdirSync('D:\\DeepSeek\\workspace\\tmp', { recursive: true })
      appendFileSync(LOG_FILE, text + '\n')
    } catch { /* 诊断日志失败不影响主流程 */ }
  }

  function remember(agent) {
    const id = String(agent?.id || '')
    if (!id) return null
    agents.set(id, agent)
    return id
  }

  // Agent 出现/消失
  ctx.on('agent/created', (payload) => {
    const id = remember(payload?.agent)
    if (id) trace(`agent created: ${id}`)
  })
  ctx.on('agent/disposed', (payload) => {
    const id = String(payload?.agent?.id || '')
    if (!id) return
    agents.delete(id)
    lastUserAt.delete(id)
    lastActionAt.delete(id)
    compacted.delete(id)
    running.delete(id)
  })

  // 运行状态：running 说明它正在干活，绝不动
  ctx.on('agent/status', (payload) => {
    const id = remember(payload?.agent)
    if (!id) return
    if (payload?.status === 'running') {
      running.add(id)
      lastActionAt.set(id, Date.now())
    } else {
      running.delete(id)
    }
  })

  // 用户发消息：重置计时 + 解锁"本轮还能再压一次"
  ctx.on('agent/inbox/inserted', (payload) => {
    const id = remember(payload?.agent)
    if (!id) return
    lastUserAt.set(id, Date.now())
    compacted.delete(id)
  })

  // 兜底：从会话事件里也收一份 agent（插件若在 agent 创建之后才加载）
  ctx.on('session/event', (session, event) => {
    if (!session) return
    if (event?.type === 'user/message') {
      const id = String(session.id || session.sessionId || '')
      if (id) lastUserAt.set(id, Date.now())
    }
  })

  async function scan() {
    if (disposed || !cfg.enabled) return
    const now = Date.now()

    for (const [id, agent] of agents) {
      if (running.has(id)) continue
      if (compacted.has(id)) continue
      if ((failUntil.get(id) || 0) > now) continue

      let last = lastUserAt.get(id) || 0
      if (!last) { lastUserAt.set(id, now); continue }
      const idleFor = now - last
      if (idleFor < cfg.idleMs) continue

      // 模型自己刚动过就先不动手（半程保护）
      const lastAct = lastActionAt.get(id) || 0
      if (lastAct && now - lastAct < halfMs) continue

      const mins = Math.round(idleFor / 60000)
      if (cfg.dryRun) {
        trace(`DRY-RUN 可压: ${id} 已闲置 ${mins} 分钟`)
        compacted.set(id, now) // dryRun 也记一笔，避免每分钟刷同一条
        continue
      }

      trace(`开始压缩: ${id} 已闲置 ${mins} 分钟`)
      const controller = new AbortController()
      try {
        const result = await ctx.compaction.compactNow(agent, controller.signal)
        // 只有真的压了（或明确没有可压范围）才锁住本轮，否则用户下条消息前不会再试
        compacted.set(id, now)
        if (result) {
          // CompactionResult 的真实字段：shadowedRange / shadowedTokenCount / startSeq..endSeq
          const range = result.shadowedRange
          trace(`压缩完成: ${id} 压掉 ${result.shadowedTokenCount ?? '?'} tokens / ${result.shadowedSeqs?.length ?? '?'} 个节点` +
            ` · seq ${result.startSeq}→${result.endSeq}` +
            (range ? ` · 覆盖 ${range.start}–${range.end}` : ''))
        } else {
          trace(`压缩跳过（没有可压的范围）: ${id}`)
        }
      } catch (err) {
        // 失败不锁死：退避 5 分钟再试（"agent 还忙"是正常拒绝，不该变成永久放弃）
        failUntil.set(id, now + 5 * 60 * 1000)
        trace(`压缩失败（5 分钟后重试）: ${id} ${err?.message || err}`)
      }
    }
  }

  timer = setInterval(() => { void scan() }, Math.max(5000, Number(cfg.scanMs) || 60000))

  ctx.effect(() => () => {
    disposed = true
    if (timer) clearInterval(timer)
  })

  // 插件可能晚于会话加载：主动收编当前所有 live agent，
  // 并把「现在」当作它们的闲置起点（重启后最坏多等一个 idleMs）。
  try {
    const live = ctx.agents.list()
    for (const agent of live) {
      const id = remember(agent)
      if (id && !lastUserAt.has(id)) lastUserAt.set(id, Date.now())
    }
    trace(`挂载完成：接手 ${live.length} 个在线 agent`)
  } catch (err) {
    trace('列举 agent 失败: ' + (err?.message || err))
  }

  log(`已挂载 · 闲置 ${Math.round(cfg.idleMs / 60000)} 分钟触发 · ${cfg.dryRun ? 'DRY-RUN 模式（只判定不压缩）' : '真压模式'}`)
}

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'auto-compact'
// 不能把 'compaction' 写进 inject：它挂在 agent 的上下文里，宿主级插件声明它会永远
// pending（waiting for service: compaction）。改成执行时在 agent.ctx 上做一次性 inject。
export const inject = ['tools']

/**
 * compaction 是按 agent 挂载的服务。直接读 agent.ctx.compaction 会报
 * "cannot get property without inject"，ctx.get() 又返回 undefined —— 说明服务在，
 * 只是这个上下文没声明依赖。所以用一次性的 ctx.inject(['compaction'], cb) 取。
 */
async function getCompaction(agent) {
  const actx = agent && agent.ctx
  if (!actx) return null

  try {
    if (actx.compaction && typeof actx.compaction.compactNow === 'function') return actx.compaction
  } catch { /* 没注入，走下面 */ }

  if (typeof actx.inject !== 'function') return null

  return await new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, 1500)
    try {
      actx.inject(['compaction'], (scoped) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          let svc = null
          try { svc = scoped.compaction } catch { /* ignore */ }
          resolve(svc || null)
        }
        return () => {}
      })
    } catch {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(null)
      }
    }
  })
}

/**
 * 宿主有 compaction.compactNow()，但没暴露成工具，agent 自己压不了上下文，
 * 只能等人手敲命令。这里补一个，好让定时任务把「压缩」也做成自动的一环。
 *
 * 压缩会替换掉之前的上下文，所以放在一轮任务的最后一步用，别放在中间。
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'compact_context',
    description:
      '立刻压缩当前会话的上下文（等价于用户手动触发的压缩）。'
      + '会替换掉之前的上下文，所以只在任务收尾时调用一次；压缩前的信息该记的要先记、该落盘的先落盘。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        if (value && value.ok) return [{ type: 'text', text: '🗜 ' + String(value.message || '已压缩') }]
        return [{ type: 'text', text: '✗ ' + String((value && value.message) || '没压成') }]
      },
    },
    async execute(_args, exec) {
      const agent = exec && (exec.agent || exec.caller)
      if (!agent) return { ok: false, message: '拿不到 agent，压缩需要绑定一个会话' }
      const compaction = await getCompaction(agent)
      if (!compaction) return { ok: false, message: '取不到 compaction 服务（agent 上下文注入超时）' }
      const ac = new AbortController()
      try {
        const result = await compaction.compactNow(agent, ac.signal)
        if (!result) return { ok: true, message: '没有需要压缩的内容' }
        return { ok: true, message: '已压缩上下文' }
      } catch (err) {
        return { ok: false, message: String((err && err.message) || err) }
      }
    },
  }))
}

import { randomUUID } from 'node:crypto'
import { joinProviderUrl } from './url'
import type { QueueStatus } from './types'

export interface ComfyImageOutput { filename: string; subfolder?: string; type?: string }
export interface ComfyUploadResult { name: string; subfolder: string; type: string }
export interface ComfySlotAddress { node: string; input: string }
export type ComfySlots = Record<string, ComfySlotAddress>

export async function submitPrompt(baseUrl: string, workflowApi: Record<string, unknown>, clientId = randomUUID()): Promise<string> {
  const resp = await fetch(joinProviderUrl(baseUrl, '', '/prompt'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflowApi, client_id: clientId }),
  })
  if (!resp.ok) throw new Error(`ComfyUI /prompt 失败: HTTP ${resp.status}: ${await resp.text()}`)
  const result: any = await resp.json()
  if (!result?.prompt_id) throw new Error('ComfyUI /prompt 响应缺少 prompt_id')
  return String(result.prompt_id)
}

export async function getHistory(baseUrl: string, promptId: string): Promise<any> {
  const resp = await fetch(joinProviderUrl(baseUrl, '', `/history/${encodeURIComponent(promptId)}`), { method: 'GET' })
  if (!resp.ok) throw new Error(`ComfyUI /history 失败: HTTP ${resp.status}`)
  return resp.json()
}

/**
 * 查询任务在 ComfyUI 队列中的位置。
 * /history/{prompt_id} 在排队与执行期间都返回空对象，无法区分二者；
 * /queue 的 queue_pending / queue_running 才能区分「排队中」与「执行中」。
 */
export async function getQueueState(baseUrl: string, taskId: string): Promise<QueueStatus> {
  const resp = await fetch(joinProviderUrl(baseUrl, '', '/queue'), { method: 'GET' })
  if (!resp.ok) throw new Error(`ComfyUI /queue 失败: HTTP ${resp.status}`)
  const data: any = await resp.json()
  const contains = (rows: any[] | undefined) => Array.isArray(rows) && rows.some((row) => row?.[1] === taskId)
  if (contains(data?.queue_pending)) return 'queued'
  if (contains(data?.queue_running)) return 'processing'
  return 'missing'
}

export function buildViewUrl(baseUrl: string, output: ComfyImageOutput): string {
  const url = new URL(joinProviderUrl(baseUrl, '', '/view'))
  url.searchParams.set('filename', output.filename)
  url.searchParams.set('subfolder', output.subfolder || '')
  url.searchParams.set('type', output.type || 'output')
  return url.toString()
}

export async function uploadImage(baseUrl: string, bytes: Uint8Array, filename: string): Promise<ComfyUploadResult> {
  const data = new Uint8Array(bytes.byteLength)
  data.set(bytes)
  const form = new FormData()
  form.append('image', new Blob([data.buffer]), filename)
  form.append('overwrite', 'true')
  const resp = await fetch(joinProviderUrl(baseUrl, '', '/upload/image'), { method: 'POST', body: form })
  if (!resp.ok) throw new Error(`ComfyUI /upload/image 失败: HTTP ${resp.status}: ${await resp.text()}`)
  const result: any = await resp.json()
  if (!result?.name) throw new Error('ComfyUI /upload/image 响应缺少 name')
  return { name: result.name, subfolder: result.subfolder || '', type: result.type || 'input' }
}

export function firstHistoryEntry(history: any): any {
  const key = Object.keys(history ?? {})[0]
  return key ? history[key] : null
}

export function extractImageOutput(entry: any): ComfyImageOutput | null {
  return firstOutput(entry, 'images')
}

export function extractVideoOutput(entry: any): ComfyImageOutput | null {
  return firstOutput(entry, 'gifs') ?? firstOutput(entry, 'images')
}

function firstOutput(entry: any, kind: 'images' | 'gifs'): ComfyImageOutput | null {
  for (const nodeId of Object.keys(entry?.outputs ?? {})) {
    const list = entry.outputs[nodeId]?.[kind]
    if (Array.isArray(list) && list.length && list[0]?.filename) return list[0]
  }
  return null
}

export function extFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.')
  const ext = dot >= 0 ? filename.slice(dot) : ''
  return /^\.[a-z0-9]{1,4}$/i.test(ext) ? ext : '.bin'
}

export function historyErrorMessage(entry: any): string {
  for (const item of entry?.messages ?? []) {
    const errors = item?.[1]?.errors
    if (Array.isArray(errors) && errors.length) {
      const msgs = errors.map((e: any) => e?.message || String(e)).filter(Boolean)
      if (msgs.length) return msgs.join('; ')
    }
  }
  return 'ComfyUI 任务执行失败'
}

export function applySlots(template: Record<string, any>, slots: ComfySlots, values: Record<string, unknown>): Record<string, any> {
  const out = structuredClone(template)
  for (const [slot, addr] of Object.entries(slots)) {
    const value = values[slot]
    if (value === undefined || value === null || value === '') continue
    const node = out[addr.node]
    if (!node || typeof node.inputs !== 'object') {
      throw new Error(`ComfyUI 模板缺少节点 ${addr.node}（slot ${slot}）`)
    }
    node.inputs[addr.input] = value
  }
  return out
}

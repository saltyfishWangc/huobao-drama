import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { joinProviderUrl } from './url'
import { getAbsolutePath, parseDataUrl } from '../../utils/storage.js'
import type { AIConfig, ProviderRequest, VideoGenerationRecord, VideoGenResponse, VideoPollResponse, VideoProviderAdapter } from './types'
import { applySlots, buildViewUrl, extFromFilename, extractVideoOutput, firstHistoryEntry, historyErrorMessage, uploadImage, type ComfySlots } from './comfyui-client'
import i2v from './comfyui/templates/i2v.json' with { type: 'json' }
import slotsFile from './comfyui/templates/slots.json' with { type: 'json' }

const MODEL_TEMPLATES: Record<string, { template: Record<string, any>; slots: ComfySlots }> = {
  'huobao-i2v-v1': { template: i2v as any, slots: (slotsFile as any)['huobao-i2v-v1'] },
}

const RESOLUTION_SIZE: Record<string, { width: number; height: number }> = {
  '480p': { width: 864, height: 480 },
  '720p': { width: 1280, height: 736 },
  '1080p': { width: 1920, height: 1088 },
}

// MiniMax H3 encodes duration at 24fps on a 17-frame grid: valid lengths are 5 + 17k.
function lengthFromDuration(duration: number): number {
  const raw = Math.max(5, Math.round(duration * 24))
  return Math.min(3600, raw + ((5 - (raw % 17) + 17) % 17))
}

function mimeExt(mimeType: string): string {
  const map: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
  return map[mimeType] || '.png'
}

function firstReferenceImage(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === 'string' && item.trim()) return item.trim()
      }
      return ''
    }
  } catch {
    // 非 JSON 数组时按单个 URL 字面处理（后端通常传 JSON 数组字符串）
  }
  return raw.trim()
}

async function firstFrameBytes(value: string): Promise<{ bytes: Uint8Array; name: string }> {
  if (value.startsWith('data:')) {
    const parsed = parseDataUrl(value)
    if (!parsed) throw new Error('首帧 data URL 解析失败')
    return { bytes: new Uint8Array(Buffer.from(parsed.data, 'base64')), name: `huobao-first-${randomUUID()}${mimeExt(parsed.mimeType)}` }
  }
  if (/^https?:\/\//i.test(value)) {
    const resp = await fetch(value, { signal: AbortSignal.timeout(30_000) })
    if (!resp.ok) throw new Error(`下载首帧失败: HTTP ${resp.status}`)
    const ext = path.extname(new URL(value).pathname) || '.png'
    return { bytes: new Uint8Array(await resp.arrayBuffer()), name: `huobao-first-${randomUUID()}${ext}` }
  }
  const ext = path.extname(value) || '.png'
  const filePath = path.isAbsolute(value) ? value : getAbsolutePath(value)
  return { bytes: new Uint8Array(fs.readFileSync(filePath)), name: `huobao-first-${randomUUID()}${ext}` }
}

export class ComfyUIVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const model = record.model || config.model
    const entry = MODEL_TEMPLATES[model || '']
    if (!entry) throw new Error(`ComfyUI 视频模板未知：${model}（支持 huobao-i2v-v1）`)
    // 前端镜头生成只提交 reference_image_urls（场景图在前），ComfyUI i2v 需要首帧：回退取第一张参考图
    const firstFrame = (
      record.firstFrameUrl ||
      record.imageUrl ||
      firstReferenceImage(record.referenceImageUrls) ||
      ''
    ).trim()
    if (!firstFrame) throw new Error('ComfyUI 图生视频需要首帧图（first_frame_url / image_url / reference_image_urls）')

    const { bytes, name } = await firstFrameBytes(firstFrame)
    const uploaded = await uploadImage(config.baseUrl, bytes, name)
    const size = RESOLUTION_SIZE[String(record.resolution || '720p')] ?? RESOLUTION_SIZE['720p']
    const length = lengthFromDuration(record.duration ?? 5)

    const workflow = applySlots(entry.template, entry.slots, {
      prompt: record.prompt || '',
      width: size.width,
      height: size.height,
      length,
      seed: record.seed,
      firstFrame: uploaded.name,
    })
    return {
      url: joinProviderUrl(config.baseUrl, '', '/prompt'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { prompt: workflow, client_id: randomUUID() },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const promptId = result?.prompt_id
    if (!promptId) throw new Error('ComfyUI /prompt 响应缺少 prompt_id')
    return { isAsync: true, taskId: String(promptId) }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return { url: joinProviderUrl(config.baseUrl, '', `/history/${encodeURIComponent(taskId)}`), method: 'GET', headers: {}, body: undefined }
  }

  parsePollResponse(result: any, config?: AIConfig): VideoPollResponse {
    const entry = firstHistoryEntry(result)
    if (!entry) return { status: 'processing' }
    if (entry.status?.status_str === 'error') return { status: 'failed', error: historyErrorMessage(entry) }
    const output = extractVideoOutput(entry)
    if (output) {
      return { status: 'completed', videoUrl: buildViewUrl(config!.baseUrl, output), ext: extFromFilename(output.filename) }
    }
    if (entry.status?.completed) return { status: 'failed', error: 'ComfyUI 任务完成但未产出视频' }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null { return null }
}

import { randomUUID } from 'node:crypto'
import { joinProviderUrl } from './url'
import type { AIConfig, ImageGenerationRecord, ImageGenResponse, ImagePollResponse, ImageProviderAdapter, ProviderRequest, QueueStatus } from './types'
import { applySlots, buildViewUrl, extractImageOutput, extFromFilename, firstHistoryEntry, getQueueState, historyErrorMessage, type ComfySlots } from './comfyui-client'
import t2i from './comfyui/templates/t2i.json' with { type: 'json' }
import slotsFile from './comfyui/templates/slots.json' with { type: 'json' }

const MODEL_TEMPLATES: Record<string, { template: Record<string, any>; slots: ComfySlots }> = {
  'huobao-t2i-v1': { template: t2i as any, slots: (slotsFile as any)['huobao-t2i-v1'] },
}

function parseSize(size?: string | null): { width?: number; height?: number } {
  if (!size) return {}
  const [w, h] = String(size).split('x')
  const width = Number.parseInt(w, 10)
  const height = Number.parseInt(h, 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return {}
  return { width, height }
}

export class ComfyUIImageAdapter implements ImageProviderAdapter {
  provider = 'comfyui'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = record.model || config.model
    const entry = MODEL_TEMPLATES[model || '']
    if (!entry) throw new Error(`ComfyUI 图片模板未知：${model}（支持 huobao-t2i-v1）`)
    const { width, height } = parseSize(record.size)
    const workflow = applySlots(entry.template, entry.slots, { prompt: record.prompt || '', width, height })
    return {
      url: joinProviderUrl(config.baseUrl, '', '/prompt'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { prompt: workflow, client_id: randomUUID() },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const promptId = result?.prompt_id
    if (!promptId) throw new Error('ComfyUI /prompt 响应缺少 prompt_id')
    return { isAsync: true, taskId: String(promptId) }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return { url: joinProviderUrl(config.baseUrl, '', `/history/${encodeURIComponent(taskId)}`), method: 'GET', headers: {}, body: undefined }
  }

  parsePollResponse(result: any, config?: AIConfig): ImagePollResponse {
    const entry = firstHistoryEntry(result)
    if (!entry) return { status: 'processing' }
    if (entry.status?.status_str === 'error') return { status: 'failed', error: historyErrorMessage(entry) }
    const output = extractImageOutput(entry)
    if (output) {
      return { status: 'completed', imageUrl: buildViewUrl(config!.baseUrl, output), ext: extFromFilename(output.filename) }
    }
    if (entry.status?.completed) return { status: 'failed', error: 'ComfyUI 任务完成但未产出图片' }
    return { status: 'processing' }
  }

  async getQueueStatus(config: AIConfig, taskId: string): Promise<QueueStatus> {
    return getQueueState(config.baseUrl, taskId)
  }

  extractImageUrl(result: any): string | null { return null }
  extractImageBase64(result: any): { data: string; mimeType: string } | null { return null }
}

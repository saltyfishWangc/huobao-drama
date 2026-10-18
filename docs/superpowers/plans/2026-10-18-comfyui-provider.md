# ComfyUI Provider 接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ComfyUI（本地或 AutoDL 实例）作为 `comfyui` provider 接入 huobao-drama 的图片（文生图）与视频（图生视频）生成链路，复用现有 sys_task 生命周期。

**Architecture:** ComfyUI 是普通 `baseUrl` provider，配置复用 `{ provider, baseUrl, apiKey, model }`。`model` 表示内置模板 id（`huobao-t2i-v1` / `huobao-i2v-v1`）。Adapter 按 `slots.json` 把用户参数写入内置 API 格式工作流，提交 `POST /prompt`，轮询 `GET /history/{prompt_id}`，从 history 输出构造 `/view` URL 并显式携带扩展名落盘。首帧图由视频 adapter 在上传 `POST /upload/image` 后写入 LoadImage 节点。

**Tech Stack:** TypeScript (ESM, Node 24, tsx), Hono, Nuxt/Vue 3 前端, node:test, 内置 JSON 模板资产。

**Spec:** `docs/superpowers/specs/2026-10-18-comfyui-provider-design.md`

## Global Constraints

- Provider 标识统一小写 `comfyui`；v1 仅支持文生图与图生视频（首帧图驱动），其余输入（text-to-video、image-to-image/inpaint、参考视频、参考音频、多帧/LoRA/ControlNet）在 adapter 层直接拒绝。
- ComfyUI 是普通 `baseUrl` provider；配置复用 `AIConfig { provider, baseUrl, apiKey, model }`，默认无鉴权（`apiKey` 可空），可达性探测用 `GET /system_stats`。
- `model` 对 ComfyUI = 内置模板 id：`huobao-t2i-v1`（文生图）、`huobao-i2v-v1`（图生视频）。
- 项目不负责 AutoDL 开机、SSH 隧道、ComfyUI 进程生命周期；只假定一个可达的 `baseUrl`（本地默认 `http://127.0.0.1:6006`）。
- 模板 JSON 是交付资产，必须经 `autodl-comfyui-operator` 离线定制并实测通过后随 adapter 提交。
- 工作分支 `codex/comfyui-provider`，不在 `master` 直接改动；保留 `backend/package-lock.json`、`backend/package.json`、`frontend/package-lock.json`、`.codex-tmp/` 的未提交改动。

## Review Focus

1. ComfyUI `/view` 的 pathname 无扩展名（`/view?filename=...&type=output`），`getExtFromUrl` 会退回 `.bin`，视频会落成 `.bin` 无法播放。期望：poll 返回 `ext`，`downloadFile` 用显式 `ext` 落盘。Pin: Task 1 的 `comfyui-download-ext.test.ts`。
2. history 里 `status.status_str === 'error'` 但 outputs 缺失时必须判 `failed`，不能永远 `processing`。期望：轮询返回失败并带上游错误。Pin: Task 2 的 `comfyui-client.test.ts` 与 Task 4 的 video poll 测试。
3. 首帧图可能以 `data:image/*;base64,...` 或 `http(s)://` 形式传入，上传必须解码/下载出正确字节并回填 `name/subfolder/type`。期望：两种输入都得到可加载的首帧。Pin: Task 4 的 `comfyui-video-adapter.test.ts`。
4. `slots.json` 引用的模板节点不存在时必须明确报错，不能静默提交残缺工作流。期望：`applySlots` 抛错且 message 点名缺失节点。Pin: Task 3 的 `comfyui-image-adapter.test.ts`。
5. 并发视频任务共享单例 adapter 时，上传文件名不能互相覆盖。期望：每次上传用唯一文件名。Pin: Task 4 的 `comfyui-video-adapter.test.ts`。

## File Structure

创建：
- `backend/src/services/adapters/comfyui-client.ts` — ComfyUI HTTP 封装 + history 输出提取 + `applySlots` 模板槽位映射（图片/视频 adapter 共享的纯逻辑）。
- `backend/src/services/adapters/comfyui-image.ts` — `ImageProviderAdapter` 实现（文生图）。
- `backend/src/services/adapters/comfyui-video.ts` — `VideoProviderAdapter` 实现（图生视频，含首帧上传）。
- `backend/src/services/adapters/comfyui/templates/t2i.json` — 文生图工作流（API 格式，Task 8 定稿）。
- `backend/src/services/adapters/comfyui/templates/i2v.json` — 图生视频工作流（API 格式，Task 8 定稿）。
- `backend/src/services/adapters/comfyui/templates/slots.json` — 模板可调参数元数据（Task 8 定稿）。

修改：
- `backend/src/services/adapters/types.ts` — `parsePollResponse` 增加可选 `config`，`ImagePollResponse` / `VideoPollResponse` 增加可选 `ext`，`VideoProviderAdapter.buildGenerateRequest` 返回类型放宽为 `ProviderRequest | Promise<ProviderRequest>`。
- `backend/src/utils/storage.ts` — `downloadFile(url, subDir, ext?)`。
- `backend/src/services/generation.ts` — 完成回调透传 `ext`；`parsePollResponse` 传入 `config`；视频分支 `await` build 请求。
- `backend/src/services/adapters/registry.ts` — 注册 `comfyui` 图片/视频 adapter。
- `backend/src/services/ai.ts` — `officialProviders.image/video` 增加 `comfyui`。
- `backend/src/routes/aiConfigs.ts` — `buildProbe` 增加 `comfyui` → `GET /system_stats`。
- `frontend/app/pages/settings.vue` — provider 下拉 + image/video 预置增加 `comfyui`。
- `frontend/app/views/drama/episode.vue` — `RESOLUTION_TIERS` / `RESOLUTION_DISPLAY` 增加 `comfyui`。

---

### Task 1: 类型与下载扩展名管道

**Files:**
- Modify: `backend/src/services/adapters/types.ts`
- Modify: `backend/src/utils/storage.ts:18-28`
- Modify: `backend/src/services/generation.ts:284,293,309,377,385,391,413-414,461-462`
- Test: `backend/tests/comfyui-download-ext.test.ts`（创建）

**Interfaces:**
- Consumes: 无（基础管道）。
- Produces: `downloadFile(url, subDir, ext?)`；`ImagePollResponse.ext?` / `VideoPollResponse.ext?`；`parsePollResponse(result, config?)`；`VideoProviderAdapter.buildGenerateRequest` 可异步返回。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/comfyui-download-ext.test.ts`：

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

test('downloadFile 使用显式 ext，忽略 /view 无扩展名的 URL', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'huobao-dl-'))
  process.env.STORAGE_PATH = path.join(dir, 'static')
  const { downloadFile } = await import('../src/utils/storage.js')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch
  try {
    const rel = await downloadFile('http://127.0.0.1:6006/view?filename=out.png&type=output', 'images', '.png')
    assert.match(rel, /^static\/images\/[0-9a-f-]+\.png$/)
    const [file] = readdirSync(path.join(dir, 'static', 'images'))
    assert.match(file, /\.png$/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generation 完成回调把 ext 透传给 downloadFile', () => {
  const src = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8')
  assert.match(src, /await downloadFile\(imageUrl,\s*'images',\s*ext\)/)
  assert.match(src, /await downloadFile\(videoUrl,\s*'videos',\s*ext\)/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests/comfyui-download-ext.test.ts`
Expected: 第二个断言 FAIL（当前无 `ext` 参数）。

- [ ] **Step 3: 改 types.ts**

在 `ImagePollResponse` 与 `VideoPollResponse` 各加 `ext?: string`；两个接口的 `parsePollResponse` 签名改为 `parsePollResponse(result: any, config?: AIConfig)`；`VideoProviderAdapter.buildGenerateRequest` 返回类型改为 `ProviderRequest | Promise<ProviderRequest>`。

- [ ] **Step 4: 改 storage.ts**

`downloadFile` 改为：

```ts
export async function downloadFile(url: string, subDir: string, ext?: string): Promise<string> {
  const dir = path.join(STORAGE_ROOT, subDir)
  fs.mkdirSync(dir, { recursive: true })

  const finalExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : getExtFromUrl(url)
  const filename = `${uuid()}${finalExt}`
  const filePath = path.join(dir, filename)
  // ... 其余保持不变
}
```

- [ ] **Step 5: 改 generation.ts**

`handleImageComplete(record, imageUrl, ext?)` 内调用 `downloadFile(imageUrl, 'images', ext)`；`handleVideoComplete(record, videoUrl, duration, ext?)` 内调用 `downloadFile(videoUrl, 'videos', ext)`。两处轮询完成分支改为：

```ts
await handleImageComplete(record, pollResp.imageUrl, pollResp.ext)
await handleVideoComplete(record, pollResp.videoUrl, pollResp.duration, pollResp.ext)
```

轮询解析改为 `adapter.parsePollResponse(result, config)`；视频构建请求改为 `await adapter.buildGenerateRequest(...)`（图片分支保持同步）。

- [ ] **Step 6: 运行确认通过**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests/comfyui-download-ext.test.ts; npm run typecheck`
Expected: 全 PASS，typecheck 无错误。

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/adapters/types.ts backend/src/utils/storage.ts backend/src/services/generation.ts backend/tests/comfyui-download-ext.test.ts
git commit -m "feat(comfyui): thread explicit file extension through generation pipeline"
```

---

### Task 2: ComfyUI HTTP 客户端

**Files:**
- Create: `backend/src/services/adapters/comfyui-client.ts`
- Test: `backend/tests/comfyui-client.test.ts`（创建）

**Interfaces:**
- Consumes: 无。
- Produces: `submitPrompt`、`getHistory`、`buildViewUrl`、`uploadImage`、`firstHistoryEntry`、`extractImageOutput`、`extractVideoOutput`、`extFromFilename`、`historyErrorMessage`、`applySlots`、`ComfySlots`。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/comfyui-client.test.ts`：

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  submitPrompt, getHistory, buildViewUrl, uploadImage,
  firstHistoryEntry, extractImageOutput, extractVideoOutput,
  extFromFilename, historyErrorMessage, applySlots,
} from '../src/services/adapters/comfyui-client'

function stubFetch(handler: (url: string, init?: any) => Response) {
  const calls: { url: string; init?: any }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('submitPrompt 提交 /prompt 并返回 prompt_id', async () => {
  const { calls, restore } = stubFetch(() =>
    new Response(JSON.stringify({ prompt_id: 'p-1' }), { status: 200, headers: { 'content-type': 'application/json' } }))
  try {
    const id = await submitPrompt('http://127.0.0.1:6006', { '3': { class_type: 'SaveImage', inputs: {} } }, 'cid-1')
    assert.equal(id, 'p-1')
    assert.equal(calls[0].url, 'http://127.0.0.1:6006/prompt')
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.client_id, 'cid-1')
    assert.ok(body.prompt['3'])
  } finally { restore() }
})

test('getHistory 查询 /history/{prompt_id}', async () => {
  const { calls, restore } = stubFetch(() => new Response(JSON.stringify({ 'p-1': { outputs: {} } }), { status: 200 }))
  try {
    await getHistory('http://127.0.0.1:6006', 'p-1')
    assert.equal(calls[0].url, 'http://127.0.0.1:6006/history/p-1')
  } finally { restore() }
})

test('buildViewUrl 编码 filename/subfolder/type', () => {
  const url = buildViewUrl('http://127.0.0.1:6006', { filename: 'a b.png', subfolder: 's/f', type: 'output' })
  const u = new URL(url)
  assert.equal(u.pathname, '/view')
  assert.equal(u.searchParams.get('filename'), 'a b.png')
  assert.equal(u.searchParams.get('subfolder'), 's/f')
  assert.equal(u.searchParams.get('type'), 'output')
})

test('extractImageOutput / extractVideoOutput 从 outputs 提取首项', () => {
  const entry = { outputs: {
    '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
    '10': { gifs: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] },
  } }
  assert.equal(extractImageOutput(entry)?.filename, 'out.png')
  assert.equal(extractVideoOutput(entry)?.filename, 'out.mp4')
  assert.equal(extractVideoOutput({ outputs: { '9': { images: [{ filename: 'only.png' }] } } })?.filename, 'only.png')
  assert.equal(firstHistoryEntry({ 'p-2': entry })?.outputs['9'], entry.outputs['9'])
})

test('extFromFilename 推导扩展名并防御异常输入', () => {
  assert.equal(extFromFilename('out.png'), '.png')
  assert.equal(extFromFilename('clip.mp4'), '.mp4')
  assert.equal(extFromFilename('noext'), '.bin')
})

test('historyErrorMessage 抽取节点错误', () => {
  const msg = historyErrorMessage({ messages: [[null, { node_id: '3', errors: [{ message: 'OOM' }] }]] })
  assert.equal(msg, 'OOM')
  assert.equal(historyErrorMessage({}), 'ComfyUI 任务执行失败')
})

test('uploadImage 上传 multipart 并返回 name/subfolder/type', async () => {
  const { calls, restore } = stubFetch(() =>
    new Response(JSON.stringify({ name: 'frame.png', subfolder: '', type: 'input' }), { status: 200 }))
  try {
    const res = await uploadImage('http://127.0.0.1:6006', new Uint8Array([1, 2, 3]), 'frame.png')
    assert.deepEqual(res, { name: 'frame.png', subfolder: '', type: 'input' })
    assert.equal(calls[0].url, 'http://127.0.0.1:6006/upload/image')
    assert.ok(calls[0].init.body instanceof FormData)
  } finally { restore() }
})

test('applySlots 写入槽位并在节点缺失时抛错', () => {
  const tpl = { '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } } }
  const out = applySlots(tpl, { prompt: { node: '6', input: 'text' } }, { prompt: '一只猫' })
  assert.equal(out['6'].inputs.text, '一只猫')
  assert.throws(() => applySlots(tpl, { prompt: { node: '7', input: 'text' } }, { prompt: 'x' }), /节点 7/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests/comfyui-client.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 comfyui-client.ts**

```ts
import { randomUUID } from 'node:crypto'
import { joinProviderUrl } from './url'

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

export function buildViewUrl(baseUrl: string, output: ComfyImageOutput): string {
  const url = new URL(joinProviderUrl(baseUrl, '', '/view'))
  url.searchParams.set('filename', output.filename)
  url.searchParams.set('subfolder', output.subfolder || '')
  url.searchParams.set('type', output.type || 'output')
  return url.toString()
}

export async function uploadImage(baseUrl: string, bytes: Uint8Array, filename: string): Promise<ComfyUploadResult> {
  const form = new FormData()
  form.append('image', new Blob([bytes]), filename)
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
```

- [ ] **Step 4: 运行确认通过**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests/comfyui-client.test.ts; npm run typecheck`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/adapters/comfyui-client.ts backend/tests/comfyui-client.test.ts
git commit -m "feat(comfyui): add ComfyUI HTTP client and history output helpers"
```

---

### Task 3: 文生图模板与图片 Adapter

**Files:**
- Create: `backend/src/services/adapters/comfyui/templates/t2i.json`
- Create: `backend/src/services/adapters/comfyui/templates/i2v.json`（占位，Task 8 定稿）
- Create: `backend/src/services/adapters/comfyui/templates/slots.json`
- Create: `backend/src/services/adapters/comfyui-image.ts`
- Test: `backend/tests/comfyui-image-adapter.test.ts`（创建）

**Interfaces:**
- Consumes: `applySlots`、`buildViewUrl`、`extractImageOutput`、`extFromFilename`、`firstHistoryEntry`、`historyErrorMessage`、`ComfySlots`（Task 2）。
- Produces: `ComfyUIImageAdapter`（`provider = 'comfyui'`），供 registry 使用。

> 注意：`t2i.json` / `i2v.json` / `slots.json` 在此任务只作为“槽位契约自洽”的占位资产，保证 adapter 可加载、可测试。生产模板由 Task 8 用 `autodl-comfyui-operator` 定制后覆盖，`slots.json` 中的槽位名保持不变，所以 adapter 代码无需改动。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/comfyui-image-adapter.test.ts`（用内存 fixture 验证槽位注入，不依赖占位 JSON 的具体节点）：

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComfyUIImageAdapter } from '../src/services/adapters/comfyui-image'
import { applySlots } from '../src/services/adapters/comfyui-client'

const adapter = new ComfyUIImageAdapter()
const config = { provider: 'comfyui', baseUrl: 'http://127.0.0.1:6006', apiKey: '', model: 'huobao-t2i-v1' }

test('t2i 提交 /prompt 并注入 prompt/width/height', () => {
  const req = adapter.buildGenerateRequest(config, { id: 1, model: 'huobao-t2i-v1', prompt: '古装侠客', size: '1920x1080' })
  assert.equal(req.method, 'POST')
  assert.equal(req.url, 'http://127.0.0.1:6006/prompt')
  assert.equal(req.headers['Content-Type'], 'application/json')
  assert.ok(req.body.client_id)
  assert.ok(req.body.prompt)
})

test('t2i 拒绝未知模板 id', () => {
  assert.throws(() => adapter.buildGenerateRequest(config, { id: 2, model: 'huobao-unknown' }), /模板未知/)
})

test('parseGenerateResponse 返回异步 taskId', () => {
  assert.deepEqual(adapter.parseGenerateResponse({ prompt_id: 'p-9' }), { isAsync: true, taskId: 'p-9' })
  assert.throws(() => adapter.parseGenerateResponse({}), /prompt_id/)
})

test('parsePollResponse 完成时返回 /view URL 与 ext', () => {
  const poll = adapter.parsePollResponse({ 'p-9': {
    status: { status_str: 'success', completed: true },
    outputs: { '9': { images: [{ filename: 'huobao_00001.png', subfolder: '', type: 'output' }] } },
  } }, config)
  assert.equal(poll.status, 'completed')
  assert.match(poll.imageUrl!, /^http:\/\/127\.0\.0\.1:6006\/view\?filename=huobao_00001\.png/)
  assert.equal(poll.ext, '.png')
})

test('parsePollResponse 错误状态与缺失输出为终态失败', () => {
  assert.deepEqual(adapter.parsePollResponse({ 'p-9': { status: { status_str: 'error', completed: true }, messages: [[null, { errors: [{ message: 'boom' }] }]] } }, config),
    { status: 'failed', error: 'boom' })
  assert.equal(adapter.parsePollResponse({ 'p-9': { status: { status_str: 'success', completed: true }, outputs: {} } }, config).status, 'failed')
  assert.equal(adapter.parsePollResponse({}, config).status, 'processing')
})

test('applySlots 槽位缺节点时抛错点名节点', () => {
  assert.throws(() => applySlots({ '6': { inputs: {} } }, { prompt: { node: '7', input: 'text' } }, { prompt: 'x' }), /节点 7/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests/comfyui-image-adapter.test.ts`
Expected: FAIL（adapter 不存在）。

- [ ] **Step 3: 创建占位模板资产**

`t2i.json`（API 格式，槽位契约：prompt→6.text，width/height→5，seed/steps/cfg→3）：

```json
{
  "3": { "class_type": "KSampler", "inputs": { "seed": 0, "steps": 20, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0] } },
  "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" } },
  "5": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["4", 1] } },
  "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["4", 1] } },
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
  "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "huobao-t2i", "images": ["8", 0] } }
}
```

`i2v.json`（占位，槽位契约：prompt→6.text，seed/steps/cfg→3，width/height→10，firstFrame→11.image）：

```json
{
  "3": { "class_type": "KSampler", "inputs": { "seed": 0, "steps": 20, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["10", 0] } },
  "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "placeholder.safetensors" } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["4", 1] } },
  "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["4", 1] } },
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
  "10": { "class_type": "EmptyLatentImage", "inputs": { "width": 1280, "height": 720, "batch_size": 1 } },
  "11": { "class_type": "LoadImage", "inputs": { "image": "placeholder.png" } },
  "12": { "class_type": "SaveImage", "inputs": { "filename_prefix": "huobao-i2v", "images": ["8", 0] } }
}
```

`slots.json`：

```json
{
  "huobao-t2i-v1": {
    "prompt": { "node": "6", "input": "text" },
    "width": { "node": "5", "input": "width" },
    "height": { "node": "5", "input": "height" },
    "seed": { "node": "3", "input": "seed" },
    "steps": { "node": "3", "input": "steps" },
    "cfg": { "node": "3", "input": "cfg" }
  },
  "huobao-i2v-v1": {
    "prompt": { "node": "6", "input": "text" },
    "width": { "node": "10", "input": "width" },
    "height": { "node": "10", "input": "height" },
    "seed": { "node": "3", "input": "seed" },
    "steps": { "node": "3", "input": "steps" },
    "cfg": { "node": "3", "input": "cfg" },
    "firstFrame": { "node": "11", "input": "image" }
  }
}
```

- [ ] **Step 4: 实现 comfyui-image.ts**

```ts
import { randomUUID } from 'node:crypto'
import { joinProviderUrl } from './url'
import type { AIConfig, ImageGenerationRecord, ImageGenResponse, ImagePollResponse, ImageProviderAdapter, ProviderRequest } from './types'
import { applySlots, buildViewUrl, extractImageOutput, extFromFilename, firstHistoryEntry, historyErrorMessage, type ComfySlots } from './comfyui-client'
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

  extractImageUrl(result: any): string | null { return null }
  extractImageBase64(result: any): { data: string; mimeType: string } | null { return null }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests/comfyui-image-adapter.test.ts; npm run typecheck`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/adapters/comfyui-image.ts backend/src/services/adapters/comfyui/templates/t2i.json backend/src/services/adapters/comfyui/templates/i2v.json backend/src/services/adapters/comfyui/templates/slots.json backend/tests/comfyui-image-adapter.test.ts
git commit -m "feat(comfyui): add text-to-image adapter with slot-driven templates"
```

---

### Task 4: 图生视频 Adapter（含首帧上传）

**Files:**
- Create: `backend/src/services/adapters/comfyui-video.ts`
- Test: `backend/tests/comfyui-video-adapter.test.ts`（创建）

**Interfaces:**
- Consumes: `applySlots`、`buildViewUrl`、`extractVideoOutput`、`extFromFilename`、`firstHistoryEntry`、`historyErrorMessage`、`uploadImage`、`ComfySlots`（Task 2）；`getAbsolutePath`、`parseDataUrl`（`utils/storage`）。
- Produces: `ComfyUIVideoAdapter`（`provider = 'comfyui'`，`buildGenerateRequest` 异步），供 registry 使用。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/comfyui-video-adapter.test.ts`：

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComfyUIVideoAdapter } from '../src/services/adapters/comfyui-video'

const adapter = new ComfyUIVideoAdapter()
const config = { provider: 'comfyui', baseUrl: 'http://127.0.0.1:6006', apiKey: '', model: 'huobao-i2v-v1' }

function stubFetch(handler: (url: string, init?: any) => Response) {
  const calls: { url: string; init?: any }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('i2v 上传首帧后提交 /prompt，首帧回填 LoadImage', async () => {
  const { calls, restore } = stubFetch((url) => {
    if (url.endsWith('/upload/image')) {
      return new Response(JSON.stringify({ name: 'frame-1.png', subfolder: '', type: 'input' }), { status: 200 })
    }
    return new Response(JSON.stringify({ prompt_id: 'p-v' }), { status: 200 })
  })
  try {
    const req = await adapter.buildGenerateRequest(config, {
      id: 1, model: 'huobao-i2v-v1', prompt: '镜头推进', firstFrameUrl: 'data:image/png;base64,AAAA', duration: 5, resolution: '720p', seed: 42,
    })
    assert.equal(calls[0].url, 'http://127.0.0.1:6006/upload/image')
    assert.ok(calls[0].init.body instanceof FormData)
    assert.equal(req.url, 'http://127.0.0.1:6006/prompt')
    const workflow = req.body.prompt
    assert.equal(workflow['11'].inputs.image, 'frame-1.png')
    assert.equal(workflow['6'].inputs.text, '镜头推进')
    assert.equal(workflow['3'].inputs.seed, 42)
  } finally { restore() }
})

test('i2v 每次上传使用唯一文件名（并发不覆盖）', async () => {
  const names: string[] = []
  const { restore } = stubFetch((url, init) => {
    if (url.endsWith('/upload/image')) {
      const name = [...(init.body as FormData).entries()][0][1] as any
      names.push(name.name)
      return new Response(JSON.stringify({ name: name.name, subfolder: '', type: 'input' }), { status: 200 })
    }
    return new Response(JSON.stringify({ prompt_id: 'p-v' }), { status: 200 })
  })
  try {
    await Promise.all([
      adapter.buildGenerateRequest(config, { id: 2, model: 'huobao-i2v-v1', firstFrameUrl: 'data:image/png;base64,AAAA' }),
      adapter.buildGenerateRequest(config, { id: 3, model: 'huobao-i2v-v1', firstFrameUrl: 'data:image/png;base64,BBBB' }),
    ])
    assert.notEqual(names[0], names[1])
  } finally { restore() }
})

test('i2v 缺少首帧或未知模板时抛错', async () => {
  await assert.rejects(adapter.buildGenerateRequest(config, { id: 4, model: 'huobao-i2v-v1' }), /首帧/)
  await assert.rejects(adapter.buildGenerateRequest(config, { id: 5, model: 'huobao-unknown', firstFrameUrl: 'data:image/png;base64,AAAA' }), /模板未知/)
})

test('video parsePollResponse 完成时返回 /view URL 与 ext', () => {
  const poll = adapter.parsePollResponse({ 'p-v': {
    status: { status_str: 'success', completed: true },
    outputs: { '12': { gifs: [{ filename: 'huobao_00001.mp4', subfolder: '', type: 'output' }] } },
  } }, config)
  assert.equal(poll.status, 'completed')
  assert.match(poll.videoUrl!, /^http:\/\/127\.0\.0\.1:6006\/view\?filename=huobao_00001\.mp4/)
  assert.equal(poll.ext, '.mp4')
})

test('video parsePollResponse 错误状态为终态失败', () => {
  const poll = adapter.parsePollResponse({ 'p-v': { status: { status_str: 'error', completed: true }, messages: [[null, { errors: [{ message: 'cuda oom' }] }]] } }, config)
  assert.deepEqual(poll, { status: 'failed', error: 'cuda oom' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests/comfyui-video-adapter.test.ts`
Expected: FAIL（adapter 不存在）。

- [ ] **Step 3: 实现 comfyui-video.ts**

```ts
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
  '480p': { width: 832, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
}
const DEFAULT_FPS = 16

function mimeExt(mimeType: string): string {
  const map: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
  return map[mimeType] || '.png'
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
  return { bytes: new Uint8Array(fs.readFileSync(getAbsolutePath(value))), name: `huobao-first-${randomUUID()}${ext}` }
}

export class ComfyUIVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const model = record.model || config.model
    const entry = MODEL_TEMPLATES[model || '']
    if (!entry) throw new Error(`ComfyUI 视频模板未知：${model}（支持 huobao-i2v-v1）`)
    const firstFrame = (record.firstFrameUrl || record.imageUrl || '').trim()
    if (!firstFrame) throw new Error('ComfyUI 图生视频需要首帧图（first_frame_url / image_url）')

    const { bytes, name } = await firstFrameBytes(firstFrame)
    const uploaded = await uploadImage(config.baseUrl, bytes, name)
    const size = RESOLUTION_SIZE[String(record.resolution || '720p')] ?? RESOLUTION_SIZE['720p']
    const frames = Math.max(16, Math.round((record.duration ?? 5) * DEFAULT_FPS))

    const workflow = applySlots(entry.template, entry.slots, {
      prompt: record.prompt || '',
      width: size.width,
      height: size.height,
      frames,
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
```

- [ ] **Step 4: 运行确认通过**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests/comfyui-video-adapter.test.ts; npm run typecheck`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/adapters/comfyui-video.ts backend/tests/comfyui-video-adapter.test.ts
git commit -m "feat(comfyui): add image-to-video adapter with first-frame upload"
```

---

### Task 5: 注册与官方 provider 白名单（后端）

**Files:**
- Modify: `backend/src/services/adapters/registry.ts`
- Modify: `backend/src/services/ai.ts:22-26`
- Modify: `backend/src/routes/aiConfigs.ts`（`buildProbe` 增加 `comfyui` 分支）
- Test: `backend/tests/official-provider-adapters.test.mjs`（修改）

**Interfaces:**
- Consumes: `ComfyUIImageAdapter`、`ComfyUIVideoAdapter`（Task 3/4）。
- Produces: `imageAdapters.comfyui` / `videoAdapters.comfyui`；`officialProviders` 含 `comfyui`；`/ai-configs/test` 对 `comfyui` 探测 `GET /system_stats`。

- [ ] **Step 1: 改 registry.ts**

```ts
import { ComfyUIImageAdapter } from './comfyui-image'
import { ComfyUIVideoAdapter } from './comfyui-video'

export const imageAdapters: Record<string, ImageProviderAdapter> = {
  // ...现有
  comfyui: new ComfyUIImageAdapter(),
}

export const videoAdapters: Record<string, VideoProviderAdapter> = {
  // ...现有
  comfyui: new ComfyUIVideoAdapter(),
}
```

- [ ] **Step 2: 改 ai.ts**

```ts
export const officialProviders: Record<ServiceType, readonly string[]> = {
  text: ['openai', 'gemini', 'volcengine'],
  image: ['openai', 'gemini', 'volcengine', 'comfyui'],
  video: ['volcengine', 'minimax', 'aliyun', 'comfyui'],
}
```

- [ ] **Step 3: 改 aiConfigs.ts buildProbe**

在 `buildProbe` 内、`p === 'aliyun'` 分支后加：

```ts
if (p === 'comfyui') {
  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '', '/system_stats'),
    headers: {},
    body: undefined,
  }
}
```

- [ ] **Step 4: 更新后端结构测试**

`official-provider-adapters.test.mjs` 中两处精确数组断言改为含 `comfyui`：

```js
assert.match(ai, /image:\s*\[\s*'openai',\s*'gemini',\s*'volcengine',\s*'comfyui'\s*\]/)
assert.match(ai, /video:\s*\[\s*'volcengine',\s*'minimax',\s*'aliyun',\s*'comfyui'\s*\]/)
```

在 `AI config probe` 测试里增加：

```js
assert.match(route, /p === 'comfyui'/)
assert.match(route, /\/system_stats/)
```

在 `adapter registry fails closed` 测试后新增：

```js
test('comfyui is registered as an official image and video provider', () => {
  const registry = read('src/services/adapters/registry.ts')
  assert.match(registry, /comfyui:\s*new ComfyUIImageAdapter\(\)/)
  assert.match(registry, /comfyui:\s*new ComfyUIVideoAdapter\(\)/)
})
```

- [ ] **Step 5: 运行确认通过**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests/official-provider-adapters.test.mjs; npm run typecheck`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/adapters/registry.ts backend/src/services/ai.ts backend/src/routes/aiConfigs.ts backend/tests/official-provider-adapters.test.mjs
git commit -m "feat(comfyui): register comfyui provider and system_stats probe"
```

---

### Task 6: 设置页 ComfyUI provider 与预置（前端）

**Files:**
- Modify: `frontend/app/pages/settings.vue:752`（providers 数组）
- Modify: `frontend/app/pages/settings.vue:759`（providerPresets image/video）
- Test: `frontend/tests/official-provider-settings.test.mjs`（修改）

**Interfaces:**
- Consumes: 无。
- Produces: 设置页可选 `comfyui`；预置 `huobao-t2i-v1` / `huobao-i2v-v1`；默认 `baseUrl = http://127.0.0.1:6006`。

- [ ] **Step 1: 改 providers 数组**

```js
const providers = ['gemini', 'openai', 'volcengine', 'minimax', 'aliyun', 'comfyui']
```

- [ ] **Step 2: 改 providerPresets**

```js
const providerPresets = {
  text: { /* 不变 */ },
  image: {
    gemini: { /* 不变 */ },
    openai: { /* 不变 */ },
    comfyui: { label: 'ComfyUI 文生图', baseUrl: 'http://127.0.0.1:6006', models: ['huobao-t2i-v1'] },
  },
  video: {
    aliyun: { /* 不变 */ },
    volcengine: { /* 不变 */ },
    minimax: { /* 不变 */ },
    comfyui: { label: 'ComfyUI 图生视频', baseUrl: 'http://127.0.0.1:6006', models: ['huobao-i2v-v1'] },
  },
}
```

- [ ] **Step 3: 更新前端结构测试**

`official-provider-settings.test.mjs` 中：

```js
assert.match(settingsPage, /const providers = \['gemini', 'openai', 'volcengine', 'minimax', 'aliyun', 'comfyui'\]/)
```

`settings page offers the supported official provider presets` 测试内增加：

```js
assert.match(providerPresetBlock('image'), /comfyui/)
assert.match(providerPresetBlock('image'), /huobao-t2i-v1/)
assert.match(providerPresetBlock('video'), /comfyui/)
assert.match(providerPresetBlock('video'), /huobao-i2v-v1/)
```

- [ ] **Step 4: 运行确认通过**

Run: `cd D:\Code\Wangc\huobao-drama\frontend; node --test tests/official-provider-settings.test.mjs`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/app/pages/settings.vue frontend/tests/official-provider-settings.test.mjs
git commit -m "feat(comfyui): expose comfyui provider preset in settings"
```

---

### Task 7: 分镜页 ComfyUI 分辨率映射（前端）

**Files:**
- Modify: `frontend/app/views/drama/episode.vue:2035-2044`（`RESOLUTION_TIERS` / `RESOLUTION_DISPLAY`）
- Test: `frontend/tests/comfyui-resolution-structure.test.mjs`（创建）

**Interfaces:**
- Consumes: 无。
- Produces: 选中 `comfyui` 视频配置时，分镜页显示 `480P/720P/1080P` 三档。

- [ ] **Step 1: 写失败测试**

创建 `frontend/tests/comfyui-resolution-structure.test.mjs`：

```js
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const page = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')

test('episode page maps comfyui video resolution to 480P/720P/1080P', () => {
  assert.match(page, /const RESOLUTION_TIERS = \{/)
  assert.match(page, /comfyui: \['480p', '720p', '1080p'\]/)
  assert.match(page, /comfyui: \{ '480p': '480P', '720p': '720P', '1080p': '1080P' \}/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd D:\Code\Wangc\huobao-drama\frontend; node --test tests/comfyui-resolution-structure.test.mjs`
Expected: FAIL（无 `comfyui` 映射）。

- [ ] **Step 3: 改 episode.vue**

```js
const RESOLUTION_TIERS = {
  volcengine: ['480p', '720p'],
  minimax: ['720p', '1080p'],
  aliyun: ['480p', '720p', '1080p'],
  comfyui: ['480p', '720p', '1080p'],
}
const RESOLUTION_DISPLAY = {
  volcengine: { '480p': '480p', '720p': '720p', '1080p': '720p' },
  minimax: { '480p': '768P', '720p': '768P', '1080p': '2K' },
  aliyun: { '480p': '480P', '720p': '720P', '1080p': '1080P' },
  comfyui: { '480p': '480P', '720p': '720P', '1080p': '1080P' },
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd D:\Code\Wangc\huobao-drama\frontend; node --test tests/comfyui-resolution-structure.test.mjs; node --test tests/official-provider-settings.test.mjs`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/app/views/drama/episode.vue frontend/tests/comfyui-resolution-structure.test.mjs
git commit -m "feat(comfyui): map comfyui video resolution tiers in episode view"
```

---

### Task 8: 用 autodl-comfyui-operator 定制并实测模板

**Files:**
- Modify: `backend/src/services/adapters/comfyui/templates/t2i.json`
- Modify: `backend/src/services/adapters/comfyui/templates/i2v.json`
- Modify: `backend/src/services/adapters/comfyui/templates/slots.json`

**Interfaces:**
- Consumes: Task 2 的 `submitPrompt` / `getHistory`（验证脚本用）。
- Produces: 在真实 AutoDL ComfyUI 上跑通的两条生产模板，槽位名与 Task 3/4 契约一致（t2i: `prompt/width/height/seed/steps/cfg`；i2v: `prompt/width/height/seed/steps/cfg/firstFrame`），命名标明本项目候选模板（`huobao-t2i-v1` / `huobao-i2v-v1`），并发布到 ComfyUI 前端。

- [ ] **Step 1: 使用 superpowers:executing-plans 继续本任务，并调用 `autodl-comfyui` skill 确认 ComfyUI 可达**

确认本地隧道 `http://127.0.0.1:6006` 可访问（或用户提供的 AutoDL 地址）。用 `GET /system_stats` 验证可达。

- [ ] **Step 2: 调用 `autodl-comfyui-operator` skill 离线设计两条工作流候选**

按需求定制：文生图（`huobao-t2i-v1`）、图生视频首帧驱动（`huobao-i2v-v1`）。输出的工作流命名标明是本项目候选模板，并发布到 ComfyUI 前端。

- [ ] **Step 3: 转换 API 格式并保持槽位契约**

把两条工作流转成 API 格式 JSON，把可调参数映射到 Task 3/4 的槽位名（不新增、不删减槽位名；节点 id 可以不同，`slots.json` 随之更新）。用 ComfyUI `/prompt` 实跑：t2i 一条真实文生图，i2v 一条真实图生视频（用一张首帧图），确认 `/history` 能取到 `images` / `gifs` 输出且文件可下载。

- [ ] **Step 4: 覆盖三个模板文件并复跑 adapter 测试**

```bash
git add backend/src/services/adapters/comfyui/templates/t2i.json backend/src/services/adapters/comfyui/templates/i2v.json backend/src/services/adapters/comfyui/templates/slots.json
git commit -m "feat(comfyui): ship operator-validated huobao workflow templates"
```

- [ ] **Step 5: 运行后端全量验证**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests/comfyui-image-adapter.test.ts tests/comfyui-video-adapter.test.ts tests/comfyui-client.test.ts tests/comfyui-download-ext.test.ts; npm run typecheck`
Expected: 全 PASS。

---

### Task 9: 全量回归验证

**Files:** 无新增。

- [ ] **Step 1: 后端全量测试与类型检查**

Run: `cd D:\Code\Wangc\huobao-drama\backend; node --import tsx --test tests; npm run typecheck`
Expected: 全 PASS（含 `tests/*.test.ts` 与 `tests/*.test.mjs`）。

- [ ] **Step 2: 前端结构测试**

Run: `cd D:\Code\Wangc\huobao-drama\frontend; node --test tests`
Expected: 全 PASS。

- [ ] **Step 3: 手工连通性验证（记录不提交）**

设置页新增一条 `comfyui` 图片/视频配置，`base_url=http://127.0.0.1:6006`，点击连接测试应返回 `GET /system_stats` 可达；分镜页选中 `comfyui` 视频配置应出现 `480P/720P/1080P` 三档。

- [ ] **Step 4: 确认工作区整洁**

Run: `git -C D:\Code\Wangc\huobao-drama status --short`
Expected: 只有本计划文件与上述代码/测试改动；`backend/package-lock.json`、`backend/package.json`、`frontend/package-lock.json`、`.codex-tmp/` 保持原样未纳入本次提交。

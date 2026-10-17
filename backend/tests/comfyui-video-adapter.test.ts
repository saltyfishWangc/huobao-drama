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
    assert.equal(workflow['114'].inputs.image, 'frame-1.png')
    assert.equal(workflow['105:104'].inputs.prompt, '镜头推进')
    assert.equal(workflow['105:15'].inputs.noise_seed, 42)
    assert.equal(workflow['105:104'].inputs.length, 124)
    assert.equal(workflow['105:104'].inputs.width, 1280)
    assert.equal(workflow['105:104'].inputs.height, 736)
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

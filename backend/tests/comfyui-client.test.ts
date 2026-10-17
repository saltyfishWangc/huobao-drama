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

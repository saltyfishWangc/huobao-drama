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

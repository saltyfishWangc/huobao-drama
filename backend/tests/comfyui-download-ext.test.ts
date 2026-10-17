import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

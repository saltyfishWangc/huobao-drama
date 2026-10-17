import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const page = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')

test('episode page maps comfyui video resolution to 480P/720P/1080P', () => {
  assert.match(page, /const RESOLUTION_TIERS = \{/)
  assert.match(page, /comfyui: \['480p', '720p', '1080p'\]/)
  assert.match(page, /comfyui: \{ '480p': '480P', '720p': '720P', '1080p': '1080P' \}/)
})

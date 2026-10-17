# ComfyUI Provider 接入设计（huobao-drama 二次开发）

日期：2026-10-18

状态：设计待评审（架构级 spec）

分支：`codex/comfyui-provider`（不在 `master` 上直接改动，避免与上游 fork 合并冲突）

## 1. 背景与目标

huobao-drama 现有图片/视频生成走统一 Adapter 架构（`backend/src/services/adapters`），已接入 OpenAI / Gemini / Volcengine（图片）与 Volcengine / MiniMax / Aliyun（视频）。目标是把 ComfyUI（本地或 AutoDL 实例）作为一级 provider 接入，复用现有生成生命周期：创建任务 → 轮询 → 下载 → 缩略图/海报 → 业务表回写。

v1 目标场景：

- 文生图：角色、场景、道具配图。
- 图生视频：分镜视频（用首帧图驱动）。

## 2. 范围与边界

v1 支持：

- `comfyui` 图片 provider：text-to-image。
- `comfyui` 视频 provider：image-to-video（首帧图驱动）。

v1 明确不支持，输入校验阶段直接拒绝：

- text-to-video。
- image-to-image / inpaint。
- 参考视频、参考音频。
- 多帧序列、LoRA / ControlNet 动态注入等高级参数（后续通过新增模板扩展，不改代码）。

## 3. 连接模型

ComfyUI 对项目而言只是普通 `baseUrl` provider：

- 配置复用 `AIConfig { provider, baseUrl, apiKey, model }`；ComfyUI 默认无鉴权，`apiKey` 允许为空、可忽略。
- 项目不负责 AutoDL 开机、SSH 隧道、ComfyUI 进程生命周期；这些由用户通过 `autodl-comfyui` 等外部手段保证，项目只假定一个可达的 `baseUrl`。
- 可达性探测使用 ComfyUI 自带端点 `GET /system_stats`。

## 4. 组件与文件

### 4.1 新增文件

- `backend/src/services/adapters/comfyui-client.ts`
  - 封装 ComfyUI HTTP：`submitPrompt(workflow) -> prompt_id`、`getHistory(promptId)`、`buildViewUrl(output)`、`getSystemStats()`、`uploadImage(bytes, filename)`。
  - 负责从 `history.outputs` 提取输出文件（图片取 `images` 数组，视频取 `gifs` 数组，VHS 视频输出在 `gifs`）并推导扩展名。
- `backend/src/services/adapters/comfyui-image.ts`：实现 `ImageProviderAdapter`。
- `backend/src/services/adapters/comfyui-video.ts`：实现 `VideoProviderAdapter`。
- `backend/src/services/adapters/comfyui/templates/t2i.json`：文生图工作流（API 格式）。
- `backend/src/services/adapters/comfyui/templates/i2v.json`：图生视频工作流（API 格式）。
- `backend/src/services/adapters/comfyui/templates/slots.json`：模板可调参数元数据。

### 4.2 修改文件

- `backend/src/services/adapters/registry.ts`：`imageAdapters` / `videoAdapters` 注册 `comfyui`。
- `backend/src/services/ai.ts`：`officialProviders.image` / `officialProviders.video` 增加 `comfyui`。
- `backend/src/routes/aiConfigs.ts`：`buildProbe` 增加 `comfyui` 分支，探测 `GET /system_stats`。
- `backend/src/services/adapters/types.ts`：`ImagePollResponse` / `VideoPollResponse` 增加可选 `ext`。
- `backend/src/services/generation.ts`：图片/视频完成回调把 `ext` 传给 `downloadFile`。
- `backend/src/utils/storage.ts`：`downloadFile` 增加可选 `ext`，覆盖 URL 扩展名推断。
- `frontend/app/pages/settings.vue`：provider 下拉增加 `comfyui` 及预置。
- `frontend/app/views/drama/episode.vue`：ComfyUI 分辨率/时长映射。

## 5. 数据流

图片与视频走同一条链路：

1. 用户提交 → 创建 `sysTask`（`provider=comfyui`，`model=模板 id`）。
2. `adapter.buildGenerateRequest`：
   - 按 `model` 读取内置模板（`t2i.json` / `i2v.json`）。
   - 按 `slots.json` + `record` 字段把 prompt / seed / width / height / frames 写入模板节点。
   - i2v：把首帧图上传到 ComfyUI `POST /upload/image`，把返回文件名写入模板的 LoadImage 节点。
   - `POST {baseUrl}/prompt`，body 为 `{ prompt: workflowApi, client_id: uuid }`。
3. `parseGenerateResponse`：取 `prompt_id`，返回 `isAsync=true`。
4. `buildPollRequest`：`GET {baseUrl}/history/{prompt_id}`。
5. `parsePollResponse`：查 `outputs`；未完成返回 `pending` / `processing`；完成则取首个图片或视频输出，构造 `/view` URL，并携带从输出 `filename` 推导的 `ext`（`.png` / `.jpg` / `.webp` / `.mp4` 等）。
6. `generation.ts` 调用 `downloadFile(url, subDir, ext)` 落盘，复用既有缩略图/海报/业务表回写流程。

### 5.1 `/view` URL 与扩展名

ComfyUI `/view` 的参数在 query 中（`/view?filename=...&subfolder=...&type=output`），pathname 无扩展名，现有 `getExtFromUrl` 会退回 `.bin`。因此 adapter 必须从 history 输出 `filename` 显式给出 `ext`，否则视频会被存成 `.bin` 无法播放。这是必须改 `downloadFile` 签名的原因。

## 6. 工作流模板与 slots

- `model` 对 ComfyUI 的含义 = 内置模板 id：`huobao-t2i-v1`（文生图）、`huobao-i2v-v1`（图生视频）。
- `slots.json` 是数据驱动映射，把友好参数名映射到模板节点输入地址，形如 `{ "name": "prompt", "node": "6", "input": "text" }`。adapter 提交前按 slots 把用户输入写入模板 JSON；换模板或加参数无需改代码。
- 模板 JSON 本身是内置交付资产，需在实现阶段用 `autodl-comfyui-operator` 按需求离线定制、实测通过后随 adapter 一起提交；adapter 只加载，不生成。

## 7. 错误处理

- `/prompt` 非 2xx：任务标记失败，错误信息落库。
- 轮询失败：复用现有 polling profile 的重试/超时机制（`attempts`、`maxDurationMs`），耗尽后标记失败。
- history 状态异常或 output 缺失：标记失败，附上游信息。
- 模板缺失/解析失败：启动时校验 `templates` 目录完整性，运行时报明确错误。

## 8. 测试策略

- `comfyui-client`：单测覆盖 submit / history / viewUrl / 输出提取，mock fetch。
- slots 映射：单测覆盖 t2i / i2v 参数注入与首帧图注入。
- 集成：对可达的 ComfyUI 实例（AutoDL）跑通 t2i 与 i2v 各一条真实任务，验证下载、缩略图/海报、业务回写。
- 手工：settings 页探测连通性；分镜页选择 `comfyui` 出图/出视频。

## 9. 不在本次范围

- ComfyUI 队列/任务管理界面、多 GPU 调度。
- 模型下载/管理（由 ComfyUI 侧负责）。
- 模板在线编辑 UI（先用内置模板 + 配置）。
- text-to-video、参考视频、参考音频。

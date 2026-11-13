# 变更记录

## 0.1.0

首个版本，提供五个工具，均按 DeepSeek 官方工具 API 文档实现：

- `deepseek_search` — `POST /v1/tools/search`
- `deepseek_fetch` — `POST /v1/tools/fetch`
- `deepseek_ocr` — `POST /v1/tools/ocr`
- `deepseek_tts` — `POST /v1/tools/tts`
- `deepseek_asr` — `POST /v1/tools/asr`

实现要点：

- API Key 每次调用重新解析：`config.apiKey` → credentials 的 `DEEPSEEK_API_KEY` → 进程环境变量 → 已登录账号凭据；换 Key 无需改配置或重启。
- 408 / 429 / 5xx 自动重试两次并尊重 `Retry-After`，402 不重试。
- TTS 音色 `stella` / `tide`，格式 `wav` / `pcm`；流式合成返回的 WAV 头常带 `0xFFFFFFFF` 占位长度，时长按实际字节计算。
- OCR 偶发在 200 响应里返回全空白页时会自动重试一次，仍为空则明确标记，不把空白当成功结果。
- ASR 只接受 16 位 PCM WAV 或 Ogg Opus，调用前校验大小与时长上限。
- 零运行时依赖，只用 Node 内置 `fetch` / `FormData` / `Blob`。

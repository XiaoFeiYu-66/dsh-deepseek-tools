# dsh-deepseek-tools

把 DeepSeek 官方「工具 API」接成 DSH 里模型可以直接调用的五个工具：网页搜索、网页抓取、OCR、语音合成、语音识别。

安装后模型会在需要时自己调用它们，也可以在任何会话里直接点名使用，例如「搜一下 DeepSeek 最新的工具 API」「把这份 PDF 识别成文字」「把这段话读出来」。

- 版本：0.1.0
- 许可：MIT
- 依赖：零运行时依赖（只用 Node 内置 `fetch` / `FormData` / `Blob`）
- 对应文档：[网页搜索与抓取](https://api-docs.deepseek.com/zh-cn/guides/search)、[OCR](https://api-docs.deepseek.com/zh-cn/guides/ocr)、[语音合成](https://api-docs.deepseek.com/zh-cn/guides/tts)、[语音识别](https://api-docs.deepseek.com/zh-cn/guides/asr)

## 工具一览

| 工具 | 端点 | 作用 |
| --- | --- | --- |
| `deepseek_search` | `POST /v1/tools/search` | DeepSeek 自研搜索引擎检索实时网页，支持搜索语法 |
| `deepseek_fetch` | `POST /v1/tools/fetch` | 抓取单个网页，返回 Markdown 正文 |
| `deepseek_ocr` | `POST /v1/tools/ocr` | PDF / Word / PowerPoint / 图片按页识别文字 |
| `deepseek_tts` | `POST /v1/tools/tts` | 文字合成语音，保存为 wav / pcm 文件 |
| `deepseek_asr` | `POST /v1/tools/asr` | 音频转写文字（WAV / Ogg Opus） |

## 环境要求

- 一个带 `tools` 服务的 DSH（正常安装的桌面版或 CLI 版都满足）。
- 一个 DeepSeek 平台 API Key：<https://platform.deepseek.com/api_keys>。
- 不需要 `npm install`，也无需编译。

> 注意：DSH 里「登录 DeepSeek 账号」得到的凭据只能用于模型推理，调用工具 API 会返回 401，必须另外准备平台 API Key。

## 安装

1. 把压缩包解压到任意本地目录（路径不要含空格），例如 `~/plugins/dsh-deepseek-tools`。
2. 用 Plugin Manager 以「目录」方式安装，`target` 填这个目录的**绝对路径**：

   ```
   plugin_manager  action=install_bundle  target=<解压目录的绝对路径>
   ```

3. 看返回值：`application: applied` 且 `warnings` 为空即已生效。确认方式：

   ```
   cordis_inspect_query  platform=host  provider=Tool  method=listTools
   ```

   列表里应出现 `deepseek_search`、`deepseek_fetch`、`deepseek_ocr`、`deepseek_tts`、`deepseek_asr`。

4. 卸载：

   ```
   plugin_manager  action=remove_bundle  target=dsh-deepseek-tools
   ```

安装会把该目录 link 进当前 profile 的 `node_modules`，所以之后修改目录里的文件，重启 DSH 后即按新文件运行。

## 配置

配置项全部可省略。需要改动时，在 profile 的 `cordis.patch.yml` 里按 `id` 覆盖本插件那一行（覆盖会替换整块 `config`，请把要保留的字段一并写出）：

```yaml
- id: deepseek-tools
  name: 'dsh-deepseek-tools'
  config:
    apiKey: sk-xxxxxxxxxxxxxxxx
    maxRenderChars: 40000
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | 空 | 显式指定 Key。留空时按下面的顺序自动解析，通常不需要填 |
| `baseUrl` | `https://api.deepseek.com` | API 根地址 |
| `timeoutMs` | `300000` | 单次请求总超时（毫秒）；OCR / TTS 会取 `max(timeoutMs, 180000)` / `max(timeoutMs, 300000)` |
| `maxRenderChars` | `30000` | 单次结果交给模型的字符上限，超出截断并注明 |
| `outputDir` | 空（= 会话工作目录） | `deepseek_tts` 的默认输出目录 |

### API Key 的解析顺序

每次调用都会重新解析，所以换了 Key 下一次工具调用就生效，不用改配置、不用重启：

1. `config.apiKey`（显式配置优先）
2. credentials 里的 `DEEPSEEK_API_KEY` 引用——即在 DSH 设置里填的 API Key，也会回退到同名环境变量和 `.env`
3. 进程环境变量 `DEEPSEEK_API_KEY`
4. 已登录的 DeepSeek 账号凭据（仅推理端点有效，工具 API 会 401）

最省事的做法是在 DSH 设置里填一次 `DEEPSEEK_API_KEY`，或给 DSH 进程设同名环境变量。

## 工具参考

### deepseek_search

按查询检索网页，按相关度排序返回结构化结果。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 搜索词，1–128 个字符，不能全为空白，支持搜索语法 |
| `count` | integer | 否 | 返回条数 1–50，默认 10 |
| `ori_question` | string | 否 | 触发搜索的用户原始问题（1–128 字符），帮助理解意图 |
| `need_content` | boolean | 否 | 是否同时返回每条结果的网页正文，默认 `false` |

支持的搜索语法（可组合）：

| 语法 | 示例 | 说明 |
| --- | --- | --- |
| `site:` | `DeepSeek site:github.com OR site:huggingface.co` | 限定站点，多个用空格 + `OR` |
| `-site:` | `DeepSeek -site:example.com` | 排除站点 |
| `-词` / `-"短语"` | `DeepSeek -广告` | 排除含该词 / 短语的页面 |
| `"短语"` | `DeepSeek "精确短语"` | 精确匹配 |
| `lang:` | `DeepSeek lang:zh,en` | 限定语言 |
| `after:` / `before:` | `DeepSeek after:2025-01-01` | 限定发布日期的区间 |

返回：`results[]`，每项含 `rank`、`title`、`url`、`snippet`、`summary`、`content`、`siteName`、`date`、`authority`（0–4，-1 未知）、`score`（0–3，≥1.5 为优质结果）。

### deepseek_fetch

抓取单个网页，返回 Markdown 正文。适合读取 `deepseek_search` 结果里的具体链接。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 含 host 的 http/https URL，不能带用户名或密码，长度 ≤ 8192 |

返回：`url`、`title`、`content`、`contentChars`、`truncated`。抓不到可提取正文时返回 404 类错误。

### deepseek_ocr

识别文档或图片里的文字，按页返回。文件只用于识别，不会存入 Files API，也不会进入对话上下文。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | string | 是 | 本地文件路径（绝对路径，或以会话工作目录为基准）。支持 PDF、DOC/DOCX、PPT/PPTX、PNG/JPEG/WebP/GIF/BMP/TIFF |
| `purpose` | string | 否 | `text_recognition`（默认）或 `rich_layout_recognition` |
| `output` | string | 否 | 把逐页文本写成 Markdown 文件，便于长文档分段读取 |
| `maxChars` | integer | 否 | 返回给模型的总字符上限，默认取 `maxRenderChars` |

限制：单个文件 ≤ 100 MiB、≤ 1000 页，从上传到返回 ≤ 180 秒。

返回：`pageCount`、`pages[]`（`index` / `finishReason` / `chars`）、`text`、`textChars`、`truncated`、`emptyResult`、`output`、`usage`。

`purpose` 为逐页识别时，文本里会保留 `<｜ref｜>` / `<｜box｜>` 版面标记与坐标，坐标形如 `[[x1, y1, x2, y2]]`，按页面宽高归一化到 0–1000。`finishReason` 为 `length` 表示该页输出达到上限、文本不完整。

### deepseek_tts

把文字合成语音并保存为音频文件。整段合成，语种按文本自动识别，不支持调节语速。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 要朗读的文本，≤ 10,000 个计费字符（汉字算 2，其他算 1） |
| `voice_id` | string | 否 | `stella`（海星，女声，默认）或 `tide`（暗潮，男声） |
| `format` | string | 否 | `wav`（默认）或 `pcm`（24 kHz、16 位、单声道裸 PCM） |
| `filter_markdown` | boolean | 否 | 朗读前是否去掉 Markdown 标记，默认 `true` |
| `output` | string | 否 | 输出文件路径 |

返回：`path`、`format`、`voiceId`、`chars`（计费字符）、`bytes`、`durationSeconds`。单次最长 30 分钟音频。

### deepseek_asr

把一段音频转写为文字。一次发送完整音频，不支持流式识别。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | string | 是 | 本地音频路径：16 位 PCM WAV（8000/16000/22050/24000/32000/44100/48000 Hz）或 Ogg Opus |

限制：≤ 8 MiB、≤ 120 秒；双声道只识别左声道。

返回：`text`、`durationMs`、`requestId`、`bytes`。其它格式会直接报错，请先用 ffmpeg 等工具转成 16 kHz 单声道 WAV。

## 计费与限速

按 DeepSeek 官方口径，调用这些接口除模型 Token 费用外另计工具费：

| API | 价格 | 限速 |
| --- | --- | --- |
| Search / Fetch | 5 元 / 1000 次成功请求 | Search 100 QPS、Fetch 25 QPS（账号级） |
| OCR | 1.5 元 / 1000 页 | 同时最多 15 个识别 |
| TTS | 3 元 / 10,000 字符（限时 5 折 1.5 元） | 同时最多 50 个请求 |
| ASR | 0.78 元 / 小时音频（限时 5 折 0.39 元） | 同时最多 50 个请求 |

插件对 408 / 429 / 5xx 自动重试两次并尊重 `Retry-After`；402（余额不足）不重试。失败请求官方不计费。

## 自检

不联网、不花钱，验证注册、参数校验、渲染与本地文件读写：

```
node scripts/self-check.mjs
```

全部通过时最后一行是 `全部离线自检通过。`。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 401 `Authentication Fails` | Key 无效，或用了账号登录凭据 | 在设置或环境变量里换平台 API Key；插件会在错误里注明是不是账号凭据导致的 |
| 402 | 余额不足 | 充值后重试 |
| 404（fetch） | URL 不可用、被站点拦截，或页面没有可提取正文 | 换链接；或用 `deepseek_search` 的 `need_content` 拿正文 |
| 408 / 504 | 上传或识别超时 | 缩小文件、稍后重试 |
| 413 | 文件超过上限 | OCR ≤ 100 MiB，ASR ≤ 8 MiB |
| 429 | 触发限速或并发上限 | 稍后重试；插件已自动重试两次 |
| 报「没有可用的 DeepSeek API Key」 | 三处凭据都没配上 | 填设置里的 `DEEPSEEK_API_KEY`、设同名环境变量，或写 `config.apiKey` |
| OCR 结果为空文本 | 该页确实没文字，或服务偶发空白页 | 插件会自动重试一次；仍为空时结果里会说明，重试或换更清晰的文件 |
| ASR 报格式不支持 | 传了 mp3 / m4a 等 | 先转成 16 位 PCM WAV 或 Ogg Opus |
| 工具列表里看不到 `deepseek_*` | 安装未生效 | 看 `install_bundle` 返回的 `application` / `warnings`，必要时重启 DSH |

## 已知限制

- TTS 只做整段合成，没有接 `wss://api.deepseek.com/v1/tools/tts` 的流式合成，也不做断点续传。
- ASR 不自动转码，非 WAV / Ogg Opus 文件会直接报错。
- OCR / ASR 直接读传入的本地路径，不额外限制目录——注意不要把不该上传给第三方 API 的文件传进来。
- 不会替换 DSH 内置的 `web_search` / `web_fetch`，两者可以并存。
- 没有图形界面，全部能力以工具形式暴露给模型。

## 目录结构

```
dsh-deepseek-tools/
├── index.js              # 插件入口：apply(ctx, config) 注册五个工具
├── lib/
│   ├── config.js         # 配置解析与校验
│   ├── client.js         # 鉴权、超时、重试、错误翻译
│   └── tools.js          # 五个工具的 schema、校验与渲染
├── locale/
│   ├── zh.json           # Plugin Manager 里的标题与描述
│   └── en.json
├── icon.svg              # 插件图标
├── scripts/
│   └── self-check.mjs    # 离线自检
├── cordis.patch.yml      # 组合包补丁：插入 id 为 deepseek-tools 的行
├── package.json
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## 许可

MIT，见 [LICENSE](./LICENSE)。

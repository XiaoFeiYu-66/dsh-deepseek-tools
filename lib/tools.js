/**
 * 五个面向模型的工具：deepseek_search / deepseek_fetch / deepseek_ocr / deepseek_tts / deepseek_asr。
 *
 * 均按官方文档的请求与响应结构调用，直接注册编译好的 JSON Schema 与规范化输出。
 *
 * @module dsh-deepseek-tools/tools
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

const MIME_BY_EXT = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
};

const OCR_MAX_BYTES = 100 * 1024 * 1024;
const ASR_MAX_BYTES = 8 * 1024 * 1024;

/** 把值当对象读取（拒绝 null 与数组）。 */
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/** 读取非空字符串参数。 */
function optionalString(args, key) {
    const value = args[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 读取必填非空字符串参数。 */
function requiredString(args, key, label) {
    const value = optionalString(args, key);
    if (value === undefined)
        throw new Error(label + '（参数 ' + key + '）为必填，请提供非空字符串。');
    return value;
}

/** 读取布尔参数。 */
function optionalBoolean(args, key) {
    const value = args[key];
    return typeof value === 'boolean' ? value : undefined;
}

/** 读取区间内的整数参数。 */
function optionalInteger(args, key, min, max) {
    const value = args[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error('参数 ' + key + ' 必须是 ' + min + '–' + max + ' 的整数。');
    }
    return value;
}

/** 会话工作目录：模型眼里的相对路径基准。 */
function executionCwd(exec) {
    return exec?.agent?.session?.header?.cwd || process.cwd();
}

/** 把 shell 风格分隔符统一成当前平台形式。 */
function normalizeSlashes(path) {
    return process.platform === 'win32' ? path.replace(/\//g, '\\') : path;
}

/** 解析本地文件路径并校验存在性、类型与大小上限。 */
async function resolveInputFile(input, cwd, maxBytes, label) {
    const absolute = resolve(cwd, normalizeSlashes(input));
    let info;
    try {
        info = await stat(absolute);
    }
    catch {
        throw new Error(label + '不存在或无法访问：' + input);
    }
    if (!info.isFile())
        throw new Error(label + '不是普通文件：' + input);
    if (info.size === 0)
        throw new Error(label + '是空文件：' + input);
    if (info.size > maxBytes) {
        throw new Error(label + '超过 ' + Math.round(maxBytes / 1024 / 1024) + ' MiB 上限（当前 ' + (info.size / 1024 / 1024).toFixed(1) + ' MiB）：' + input);
    }
    return { path: absolute, bytes: info.size, name: basename(absolute) };
}

/** 生成不覆盖已有文件的输出路径。 */
async function uniqueOutputPath(directory, stem, extension) {
    for (let index = 0; index < 1000; index += 1) {
        const suffix = index === 0 ? '' : '-' + index;
        const candidate = join(directory, stem + suffix + extension);
        try {
            await stat(candidate);
        }
        catch {
            return candidate;
        }
    }
    throw new Error('无法在 ' + directory + ' 里生成不重复的文件名。');
}

/** 时间戳后缀，例如 20261113-235843。 */
function timestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
}

/** 截断单段文本，并保留可读的省略说明。 */
function clip(text, max) {
    const value = typeof text === 'string' ? text : '';
    if (max <= 0 || value.length <= max)
        return value;
    return value.slice(0, max) + '…（此段已截断，原文 ' + value.length + ' 字符）';
}

/** 生成一个 text 内容块。 */
function textBlock(text) {
    return [{ type: 'text', text }];
}

/** 统计 TTS 计费字符：汉字算 2，其他算 1。 */
function billingChars(text) {
    let total = 0;
    for (const char of text) {
        total += /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char) ? 2 : 1;
    }
    return total;
}

/** 从 WAV 头解析音频时长（秒）；解析失败返回 undefined。 */
function wavDurationSeconds(bytes) {
    try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.byteLength < 44)
            return undefined;
        let offset = 12;
        let byteRate = 0;
        let dataOffset = 0;
        let declaredSize = 0;
        while (offset + 8 <= view.byteLength) {
            const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
            const size = view.getUint32(offset + 4, true);
            if (id === 'fmt ' && offset + 20 <= view.byteLength) {
                byteRate = view.getUint32(offset + 16, true);
            }
            else if (id === 'data') {
                dataOffset = offset + 8;
                declaredSize = size;
                break;
            }
            offset += 8 + size + (size % 2);
        }
        if (byteRate <= 0 || dataOffset <= 0)
            return undefined;
        const available = view.byteLength - dataOffset;
        // 流式合成时服务端把 RIFF/data 长度写成 0xFFFFFFFF 占位，按实际剩余字节计算。
        const usable = declaredSize === 0 || declaredSize === 0xFFFFFFFF || declaredSize > available ? available : declaredSize;
        if (usable <= 0)
            return undefined;
        const duration = usable / byteRate;
        if (!Number.isFinite(duration) || duration <= 0 || duration > 1800)
            return undefined;
        return duration;
    }
    catch {
        // 头部异常时不给时长。
    }
    return undefined;
}

/** 人类可读的秒数。 */
function seconds(value) {
    return (Math.round(value * 10) / 10).toString() + ' 秒';
}

// ---------- 输出 JSON Schema ----------
const searchItemSchema = {
    type: 'object',
    properties: {
        rank: { type: 'integer' },
        title: { type: 'string' },
        url: { type: 'string' },
        snippet: { type: 'string' },
        summary: { type: 'string' },
        content: { type: 'string' },
        siteName: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        date: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        authority: { type: 'integer' },
        score: { type: 'number' },
    },
    additionalProperties: true,
};
const searchSchema = {
    type: 'object',
    properties: {
        query: { type: 'string' },
        count: { type: 'integer' },
        results: { type: 'array', items: searchItemSchema },
    },
    additionalProperties: true,
};
const fetchSchema = {
    type: 'object',
    properties: {
        url: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        contentChars: { type: 'integer' },
        truncated: { type: 'boolean' },
    },
    additionalProperties: true,
};
const ocrPageSchema = {
    type: 'object',
    properties: {
        index: { type: 'integer' },
        finishReason: { type: 'string' },
        chars: { type: 'integer' },
    },
    additionalProperties: true,
};
const ocrSchema = {
    type: 'object',
    properties: {
        file: { type: 'string' },
        purpose: { type: 'string' },
        pageCount: { type: 'integer' },
        pages: { type: 'array', items: ocrPageSchema },
        textChars: { type: 'integer' },
        truncated: { type: 'boolean' },
        emptyResult: { type: 'boolean' },
        output: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        usage: { oneOf: [{ type: 'object' }, { type: 'null' }] },
    },
    additionalProperties: true,
};
const ttsSchema = {
    type: 'object',
    properties: {
        path: { type: 'string' },
        format: { type: 'string' },
        voiceId: { type: 'string' },
        chars: { type: 'integer' },
        bytes: { type: 'integer' },
        durationSeconds: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    },
    additionalProperties: true,
};
const asrSchema = {
    type: 'object',
    properties: {
        text: { type: 'string' },
        durationMs: { type: 'integer' },
        requestId: { type: 'string' },
        bytes: { type: 'integer' },
    },
    additionalProperties: true,
};

// ---------- 工具构建 ----------
/**
 * 构建五个工具定义。
 * @param cfg - 已解析配置。
 * @param api - API 客户端（createApiClient 的返回值）。
 */
export function buildTools(cfg, api) {
    const renderLimit = cfg.maxRenderChars;
    const search = {
        name: 'deepseek_search',
        description: '用 DeepSeek 自研搜索引擎检索实时网页，按相关度返回标题、链接、摘要与分数。query 支持 site:、-site:、-词、-"短语"、"精确短语"、lang:zh,en、after:2025-01-01、before:2026 等搜索语法。要读某个结果页的完整正文，用 deepseek_fetch。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索词，1–128 个字符；可组合搜索语法，例如 DeepSeek 模型 site:github.com lang:zh after:2025。' },
                count: { type: 'integer', description: '返回条数 1–50，默认 10。' },
                ori_question: { type: 'string', description: '触发这次搜索的用户原始问题（1–128 字符），帮助搜索引擎理解意图。' },
                need_content: { type: 'boolean', description: '是否同时返回每条结果的网页正文，默认 false。' },
            },
            required: ['query'],
        },
        output: { schema: searchSchema, render: (_args, value) => renderSearch(asRecord(value), renderLimit) },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            const query = requiredString(args, 'query', '搜索词');
            if ([...query].length > 128)
                throw new Error('query 最多 128 个字符（当前 ' + [...query].length + ' 个）。');
            const payload = { query };
            const count = optionalInteger(args, 'count', 1, 50);
            if (count !== undefined)
                payload.count = count;
            const oriQuestion = optionalString(args, 'ori_question');
            if (oriQuestion !== undefined)
                payload.ori_question = oriQuestion;
            const needContent = optionalBoolean(args, 'need_content');
            if (needContent === true)
                payload.need_content = true;
            const body = await api.postJson('/v1/tools/search', '网页搜索', payload, exec?.signal, cfg.timeoutMs);
            const results = Array.isArray(body?.results) ? body.results : [];
            return {
                query,
                count: results.length,
                results: results.map((item, index) => {
                    const record = asRecord(item);
                    return {
                        rank: index + 1,
                        title: typeof record.title === 'string' ? record.title : '',
                        url: typeof record.url === 'string' ? record.url : '',
                        snippet: typeof record.snippet === 'string' ? record.snippet : '',
                        summary: typeof record.summary === 'string' ? record.summary : '',
                        content: typeof record.content === 'string' ? record.content : '',
                        siteName: typeof record.site_name === 'string' ? record.site_name : null,
                        date: typeof record.date === 'string' ? record.date : null,
                        authority: Number.isInteger(record.authority) ? record.authority : -1,
                        score: typeof record.rerank_score === 'number' ? record.rerank_score : 0,
                    };
                }),
            };
        },
        timeoutMs: Math.min(cfg.timeoutMs, 60000),
        isConcurrencySafe: () => true,
    };
    const fetchPage = {
        name: 'deepseek_fetch',
        description: '抓取单个网页，以 Markdown 返回页面标题与正文。适合读取 deepseek_search 结果里的具体链接；结果受目标站点可用性与访问策略影响。',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '要抓取的网页地址：必须含 host 的 http/https URL，不能带用户名或密码，长度不超过 8192。' },
            },
            required: ['url'],
        },
        output: { schema: fetchSchema, render: (_args, value) => renderFetch(asRecord(value), renderLimit) },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            const url = requiredString(args, 'url', '网页地址');
            if (url.length > 8192)
                throw new Error('url 长度不能超过 8192 个字符。');
            let parsed;
            try {
                parsed = new URL(url);
            }
            catch {
                throw new Error('url 不是合法地址：' + url);
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
                throw new Error('url 必须是 http 或 https 地址。');
            if (parsed.username !== '' || parsed.password !== '')
                throw new Error('url 不能携带用户名或密码。');
            const body = await api.postJson('/v1/tools/fetch', '网页抓取', { url }, exec?.signal, cfg.timeoutMs);
            const content = typeof body?.content === 'string' ? body.content : '';
            return {
                url,
                title: typeof body?.title === 'string' ? body.title : '',
                content,
                contentChars: content.length,
                truncated: content.length > renderLimit,
            };
        },
        timeoutMs: Math.min(cfg.timeoutMs, 120000),
        isConcurrencySafe: () => true,
    };
    const ocr = {
        name: 'deepseek_ocr',
        description: '识别 PDF、Word、PowerPoint 或图片中的文字，按页返回。文件只用于识别，不会存入 Files API，也不会交给对话模型。逐页识别的文本会保留 <｜ref｜>/<｜box｜> 等版面标记与 0–1000 归一化坐标。',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string', description: '本地文件路径（绝对路径，或以会话工作目录为基准）：PDF、DOC/DOCX、PPT/PPTX、PNG/JPEG/WebP/GIF/BMP/TIFF；不超过 100 MiB、1000 页。' },
                purpose: {
                    type: 'string',
                    enum: ['text_recognition', 'rich_layout_recognition'],
                    description: 'text_recognition（默认）：不含图片的 Word/PPT 直接提取文字，其他文件逐页识别；rich_layout_recognition：所有文件都逐页识别。',
                },
                output: { type: 'string', description: '可选：把逐页文本按页写成 Markdown 文件，便于之后分段读取长文档。' },
                maxChars: { type: 'integer', description: '返回给模型的总字符上限，默认取配置的 maxRenderChars（30000）。' },
            },
            required: ['file'],
        },
        output: { schema: ocrSchema, render: (_args, value) => renderOcr(asRecord(value), renderLimit) },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            const cwd = executionCwd(exec);
            const purpose = optionalString(args, 'purpose') ?? 'text_recognition';
            if (purpose !== 'text_recognition' && purpose !== 'rich_layout_recognition') {
                throw new Error('purpose 只能是 text_recognition 或 rich_layout_recognition。');
            }
            const file = await resolveInputFile(requiredString(args, 'file', '待识别文件'), cwd, OCR_MAX_BYTES, '待识别文件');
            const bytes = await readFile(file.path);
            /** 发一次识别请求；200 里带 error 对象时按失败处理。 */
            const send = async () => {
                const form = new FormData();
                form.append('purpose', purpose);
                form.append('file', new Blob([bytes], { type: MIME_BY_EXT[extname(file.path).toLowerCase()] ?? 'application/octet-stream' }), file.name);
                const body = await api.postForm('/v1/tools/ocr', 'OCR 识别', form, exec?.signal, Math.max(cfg.timeoutMs, 180000));
                if (typeof body?.error === 'object' && body.error !== null) {
                    throw new Error('OCR 识别失败：' + (typeof body.error.message === 'string' ? body.error.message : '服务返回了错误对象'));
                }
                return body;
            };
            const toPages = (body) => (Array.isArray(body?.pages) ? body.pages : []).map((item, index) => {
                const record = asRecord(item);
                return {
                    index: Number.isInteger(record.index) ? record.index : index,
                    text: typeof record.text === 'string' ? record.text : '',
                    finishReason: typeof record.finish_reason === 'string' ? record.finish_reason : 'stop',
                };
            });
            const isBlank = (pages) => pages.length > 0 && pages.every(page => page.text.trim() === '');
            let body = await send();
            let pages = toPages(body);
            // 实测该接口偶发在 200 响应里返回全空白页，重试一次通常即可拿到文本。
            if (isBlank(pages)) {
                body = await send();
                pages = toPages(body);
            }
            const emptyResult = isBlank(pages);
            const maxChars = optionalInteger(args, 'maxChars', 500, 200000) ?? renderLimit;
            const sections = [];
            let used = 0;
            let truncated = false;
            for (const page of pages) {
                const heading = '## 第 ' + (page.index + 1) + ' 页' + (page.finishReason === 'length' ? '（输出达到上限，本页不完整）' : '');
                const room = maxChars - used - heading.length - 2;
                if (room <= 0) {
                    truncated = true;
                    break;
                }
                const piece = page.text.length > room ? page.text.slice(0, room) : page.text;
                if (piece.length < page.text.length)
                    truncated = true;
                sections.push(heading + '\n\n' + piece);
                used += heading.length + piece.length + 2;
            }
            const text = sections.join('\n\n');
            let outputPath = null;
            const requestedOutput = optionalString(args, 'output');
            if (requestedOutput !== undefined) {
                outputPath = resolve(cwd, normalizeSlashes(requestedOutput));
                const fullText = pages.map(page => '## 第 ' + (page.index + 1) + ' 页\n\n' + page.text).join('\n\n');
                await mkdir(dirname(outputPath), { recursive: true });
                await writeFile(outputPath, fullText + '\n', 'utf8');
            }
            return {
                file: file.path,
                purpose,
                pageCount: Number.isInteger(body?.page_count) ? body.page_count : pages.length,
                pages: pages.map(page => ({ index: page.index, finishReason: page.finishReason, chars: page.text.length })),
                text,
                textChars: pages.reduce((total, page) => total + page.text.length, 0),
                truncated,
                emptyResult,
                output: outputPath,
                usage: typeof body?.usage === 'object' ? body.usage : null,
            };
        },
        timeoutMs: Math.max(cfg.timeoutMs, 240000),
        isConcurrencySafe: () => true,
    };
    const tts = {
        name: 'deepseek_tts',
        description: '把文字合成为语音并保存为音频文件，返回文件路径与时长。整段合成（不是流式），语种按文本自动识别，不支持调节语速。',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '要朗读的文本，不能为空，最多 10,000 个计费字符（汉字算 2，其他算 1）。' },
                voice_id: {
                    type: 'string',
                    enum: ['stella', 'tide'],
                    description: '音色：stella（海星，女声，默认）或 tide（暗潮，男声）。',
                },
                format: {
                    type: 'string',
                    enum: ['wav', 'pcm'],
                    description: 'wav（默认，audio/wav）或 pcm（24 kHz、16 位、单声道裸 PCM）。',
                },
                filter_markdown: { type: 'boolean', description: '朗读前是否去掉 Markdown 标记，默认 true。' },
                output: { type: 'string', description: '输出文件路径；默认放到配置的 outputDir 或会话工作目录，文件名 deepseek-tts-<时间>.<格式>。' },
            },
            required: ['text'],
        },
        output: { schema: ttsSchema, render: (_args, value) => renderTts(asRecord(value)) },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            const text = requiredString(args, 'text', '要朗读的文本');
            const chars = billingChars(text);
            if (chars > 10000)
                throw new Error('文本超过 10,000 个计费字符上限（当前 ' + chars + ' 个）。');
            const voiceId = optionalString(args, 'voice_id') ?? 'stella';
            if (voiceId !== 'stella' && voiceId !== 'tide')
                throw new Error('voice_id 只能是 stella 或 tide。');
            const format = optionalString(args, 'format') ?? 'wav';
            if (format !== 'wav' && format !== 'pcm')
                throw new Error('format 只能是 wav 或 pcm。');
            const payload = { text, voice_id: voiceId, format };
            const filterMarkdown = optionalBoolean(args, 'filter_markdown');
            if (filterMarkdown !== undefined)
                payload.filter_markdown = filterMarkdown;
            const { bytes } = await api.postAudio('/v1/tools/tts', '语音合成', payload, exec?.signal, Math.max(cfg.timeoutMs, 300000));
            const cwd = executionCwd(exec);
            const requested = optionalString(args, 'output');
            let path;
            if (requested !== undefined) {
                path = resolve(cwd, normalizeSlashes(requested));
            }
            else {
                const directory = cfg.outputDir === '' ? cwd : resolve(cfg.outputDir);
                await mkdir(directory, { recursive: true });
                path = await uniqueOutputPath(directory, 'deepseek-tts-' + timestamp(), '.' + format);
            }
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, bytes);
            const duration = format === 'wav'
                ? wavDurationSeconds(bytes)
                : bytes.byteLength / (24000 * 2);
            return {
                path,
                format,
                voiceId,
                chars,
                bytes: bytes.byteLength,
                durationSeconds: duration === undefined ? null : Math.round(duration * 10) / 10,
            };
        },
        timeoutMs: Math.max(cfg.timeoutMs, 300000),
        isConcurrencySafe: () => true,
    };
    const asr = {
        name: 'deepseek_asr',
        description: '把一段音频转写为文字。一次发送完整音频（不支持流式），语种按音频自动识别。',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string', description: '本地音频路径（绝对路径，或以会话工作目录为基准）：16 位 PCM WAV（8000/16000/22050/24000/32000/44100/48000 Hz）或 Ogg Opus；双声道只识别左声道；最长 120 秒、不超过 8 MiB。' },
            },
            required: ['file'],
        },
        output: { schema: asrSchema, render: (_args, value) => renderAsr(asRecord(value)) },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs);
            const cwd = executionCwd(exec);
            const file = await resolveInputFile(requiredString(args, 'file', '音频文件'), cwd, ASR_MAX_BYTES, '音频文件');
            const extension = extname(file.path).toLowerCase();
            if (extension !== '.wav' && extension !== '.ogg' && extension !== '.opus') {
                throw new Error('语音识别只接受 16 位 PCM WAV 或 Ogg Opus，当前文件是 ' + (extension || '无扩展名') + '：请先转成 16 kHz 单声道 WAV（ffmpeg、转码工具或 ffmpeg_encode / ffmpeg_adjust 之类的现成工具）再调用。');
            }
            const bytes = await readFile(file.path);
            const form = new FormData();
            form.append('file', new Blob([bytes], { type: MIME_BY_EXT[extension] ?? 'application/octet-stream' }), file.name);
            const body = await api.postForm('/v1/tools/asr', '语音识别', form, exec?.signal, Math.max(cfg.timeoutMs, 180000));
            return {
                text: typeof body?.text === 'string' ? body.text : '',
                durationMs: Number.isFinite(body?.duration_ms) ? Math.round(body.duration_ms) : 0,
                requestId: typeof body?.request_id === 'string' ? body.request_id : '',
                bytes: bytes.byteLength,
            };
        },
        timeoutMs: Math.max(cfg.timeoutMs, 180000),
        isConcurrencySafe: () => true,
    };
    return [search, fetchPage, ocr, tts, asr];
}

// ---------- 结果渲染 ----------
/** 搜索结果的模型可读文本。 */
function renderSearch(record, limit) {
    const results = Array.isArray(record.results) ? record.results : [];
    const query = typeof record.query === 'string' ? record.query : '';
    if (results.length === 0) {
        return textBlock('没有找到与「' + query + '」匹配的网页。可以换关键词，或用 site:/lang:/after: 等语法缩小范围。');
    }
    const lines = ['搜索「' + query + '」返回 ' + results.length + ' 条结果：'];
    for (const item of results) {
        const result = asRecord(item);
        lines.push('');
        lines.push(String(result.rank) + '. ' + (result.title || '(无标题)'));
        lines.push('   ' + result.url);
        const meta = [];
        if (typeof result.siteName === 'string' && result.siteName !== '')
            meta.push(result.siteName);
        if (typeof result.date === 'string' && result.date !== '')
            meta.push(result.date.slice(0, 10));
        if (typeof result.authority === 'number' && result.authority >= 0)
            meta.push('权威 ' + result.authority + '/4');
        if (typeof result.score === 'number' && result.score > 0)
            meta.push('分数 ' + Math.round(result.score * 10) / 10);
        if (meta.length > 0)
            lines.push('   ' + meta.join('｜'));
        const summary = typeof result.summary === 'string' && result.summary !== '' ? result.summary : result.snippet;
        if (typeof summary === 'string' && summary !== '')
            lines.push('   要点：' + clip(summary, 600));
        if (typeof result.content === 'string' && result.content !== '')
            lines.push('   正文：' + clip(result.content, 2500));
    }
    const text = lines.join('\n');
    if (text.length > limit) {
        return textBlock(text.slice(0, limit) + '\n…（结果较多已截断；可减小 count 或对具体链接用 deepseek_fetch）');
    }
    return textBlock(text);
}

/** 抓取结果的模型可读文本。 */
function renderFetch(record, limit) {
    const title = typeof record.title === 'string' && record.title !== '' ? record.title : '(无标题)';
    const url = typeof record.url === 'string' ? record.url : '';
    const content = typeof record.content === 'string' ? record.content : '';
    if (content === '')
        return textBlock('抓取 ' + url + ' 成功，但页面没有可提取的 Markdown 正文。');
    const header = title + '\n' + url + '\n\n';
    const room = Math.max(limit - header.length, 0);
    return textBlock(header + clip(content, room));
}

/** OCR 结果的模型可读文本。 */
function renderOcr(record, limit) {
    const pages = Array.isArray(record.pages) ? record.pages : [];
    if (record.emptyResult === true) {
        return textBlock('OCR 完成：' + String(record.pageCount ?? pages.length) + ' 页，但服务端返回的是空白文本（自动重试一次后仍为空）。可能该页本身没有文字，也可能是识别服务偶发问题——稍后重试一次；若持续为空，请确认文件不是纯空白页或图片过于模糊。');
    }
    const header = 'OCR 完成：' + String(record.pageCount ?? pages.length) + ' 页，共 ' + String(record.textChars ?? 0) + ' 字符' + (record.output ? '；完整文本已写入 ' + record.output : '');
    const text = typeof record.text === 'string' ? record.text : '';
    const body = text.length > 0 ? '\n\n' + text : '\n\n（没有识别出文字。）';
    const combined = header + body;
    if (combined.length > limit) {
        return textBlock(combined.slice(0, limit) + '\n…（已截断；请用 output 参数保存完整文本，或分段读取）');
    }
    return textBlock(combined);
}

/** TTS 结果的模型可读文本。 */
function renderTts(record) {
    const voice = record.voiceId === 'tide' ? '暗潮（男声）' : '海星（女声）';
    const duration = typeof record.durationSeconds === 'number' ? '，约 ' + seconds(record.durationSeconds) : '';
    const size = typeof record.bytes === 'number' ? '，' + (record.bytes >= 1048576 ? (record.bytes / 1048576).toFixed(1) + ' MB' : Math.round(record.bytes / 1024) + ' KB') : '';
    return textBlock('语音已生成：' + record.path + '（' + record.format + '，' + voice + duration + size + '，' + record.chars + ' 计费字符）');
}

/** ASR 结果的模型可读文本。 */
function renderAsr(record) {
    const duration = typeof record.durationMs === 'number' && record.durationMs > 0 ? '（音频 ' + seconds(record.durationMs / 1000) + '）' : '';
    const text = typeof record.text === 'string' && record.text !== '' ? record.text : '（没有识别出文字。）';
    return textBlock('转写结果' + duration + '：\n' + text);
}

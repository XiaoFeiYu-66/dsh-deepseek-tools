/**
 * 离线自检：不联网、不花钱，验证注册、配置解析、参数校验、渲染与本地文件读写。
 *
 *   node scripts/self-check.mjs
 *
 * 全部通过时退出码为 0，最后一行输出「全部离线自检通过。」
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';
import { resolveConfig } from '../lib/config.js';
import { buildTools } from '../lib/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const signal = new AbortController().signal;
const exec = { signal, agent: { session: { header: { cwd: here } } } };
let checks = 0;

function assert(condition, message) {
    checks += 1;
    if (!condition)
        throw new Error('断言失败：' + message);
}

function section(title) {
    console.log('\n' + title);
}

// ---------- 1. 注册 ----------
section('1. 注册五个工具');
const registered = [];
apply({
    tools: { register(definition) { registered.push(definition); return () => {}; } },
    get() { return undefined; },
}, {});
const names = registered.map(definition => definition.name).sort();
assert(registered.length === 5, '应注册 5 个工具，实际 ' + registered.length);
assert(names.join(',') === 'deepseek_asr,deepseek_fetch,deepseek_ocr,deepseek_search,deepseek_tts', '工具名不符：' + names.join(','));
for (const definition of registered) {
    assert(typeof definition.description === 'string' && definition.description.length > 10, definition.name + ' 缺少描述');
    assert(definition.parameters.type === 'object', definition.name + ' 的 parameters 不是对象 schema');
    assert(typeof definition.output.render === 'function', definition.name + ' 缺少 output.render');
    assert(typeof definition.output.schema === 'object', definition.name + ' 缺少 output.schema');
}
console.log('   ' + names.join(', '));

// ---------- 2. 配置 ----------
section('2. 配置解析');
const cfg = resolveConfig({ apiKey: '  sk-test  ', maxRenderChars: 5000 });
assert(cfg.apiKey === 'sk-test', 'apiKey 应去掉首尾空白');
assert(cfg.baseUrl === 'https://api.deepseek.com', '默认 baseUrl 不对：' + cfg.baseUrl);
assert(cfg.maxRenderChars === 5000, 'maxRenderChars 未生效');
assert(cfg.timeoutMs === 300000, '默认 timeoutMs 不对');
for (const bad of [{ timeoutMs: 5 }, { maxRenderChars: 1 }, { baseUrl: 'ftp://x' }, { apiKey: 1 }]) {
    let threw = false;
    try { resolveConfig(bad); } catch { threw = true; }
    assert(threw, '非法配置应报错：' + JSON.stringify(bad));
}
console.log('   默认值与非法值校验通过');

// ---------- 3. 假客户端跑通 execute / render ----------
section('3. 工具逻辑（假客户端）');
const fake = {
    async postJson(path) {
        if (path.endsWith('/search')) {
            return { results: [{
                rerank_score: 2.4,
                title: '示例标题',
                url: 'https://example.com/a',
                snippet: '短摘要',
                summary: '长摘要'.repeat(5),
                content: '正文'.repeat(20),
                site_name: '示例站点',
                site_icon: null,
                date: '2026-06-01T00:00:00+00:00',
                authority: 3,
            }] };
        }
        return { title: '示例页面', content: '# 示例\n\n正文内容' };
    },
    async postForm(path) {
        if (path.endsWith('/ocr')) {
            return {
                page_count: 2,
                pages: [
                    { index: 0, text: '第一页文字', finish_reason: 'stop' },
                    { index: 1, text: '第二页'.repeat(30), finish_reason: 'length' },
                ],
                usage: { total_tokens: 100 },
            };
        }
        return { request_id: 'r1', text: '上海今天天气怎么样？', duration_ms: 3200 };
    },
    async postAudio() {
        // 1 秒 24 kHz / 16 bit / 单声道 WAV
        const dataSize = 48000;
        const buffer = Buffer.alloc(44 + dataSize);
        buffer.write('RIFF', 0, 'ascii');
        buffer.writeUInt32LE(36 + dataSize, 4);
        buffer.write('WAVE', 8, 'ascii');
        buffer.write('fmt ', 12, 'ascii');
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20);
        buffer.writeUInt16LE(1, 22);
        buffer.writeUInt32LE(24000, 24);
        buffer.writeUInt32LE(48000, 28);
        buffer.writeUInt16LE(2, 32);
        buffer.writeUInt16LE(16, 34);
        buffer.write('data', 36, 'ascii');
        buffer.writeUInt32LE(dataSize, 40);
        return { bytes: new Uint8Array(buffer), contentType: 'audio/wav' };
    },
};

const tools = Object.fromEntries(buildTools(cfg, fake).map(definition => [definition.name, definition]));

async function run(name, args) {
    const definition = tools[name];
    const value = await definition.execute(args, exec);
    const text = definition.output.render(args, value).map(block => block.text ?? '').join('\n');
    assert(text.trim() !== '', name + ' 的渲染结果为空');
    return { value, text };
}

const search = await run('deepseek_search', { query: '示例查询', need_content: true });
assert(search.value.results[0].siteName === '示例站点', 'site_name 未映射为 siteName');
assert(search.value.results[0].authority === 3, 'authority 未映射');
assert(search.text.includes('https://example.com/a'), '渲染里缺少链接');

const fetched = await run('deepseek_fetch', { url: 'https://example.com/a' });
assert(fetched.value.contentChars === fetched.value.content.length, 'contentChars 与实际长度不一致');
console.log('   搜索与抓取的 execute / render 通过');

// ---------- 4. 本地文件读写 ----------
section('4. 本地文件');
const directory = await mkdtemp(join(tmpdir(), 'dsh-deepseek-tools-'));
try {
    const pdf = join(directory, 'doc.pdf');
    await writeFile(pdf, Buffer.from('%PDF-1.4 test'));
    const ocrResult = await run('deepseek_ocr', { file: pdf, output: join(directory, 'out.md') });
    assert(ocrResult.value.output.endsWith('out.md'), 'output 路径未返回');
    assert(ocrResult.value.pageCount === 2, 'OCR 页数未映射');
    assert(ocrResult.value.truncated === false, 'OCR 不应截断');
    assert(ocrResult.text.includes('第 1 页'), '渲染里缺少页码');

    const wav = join(directory, 'a.wav');
    await writeFile(wav, Buffer.alloc(1600));
    await run('deepseek_asr', { file: wav });

    const tts = await run('deepseek_tts', { text: '你好，我是 DeepSeek。', output: join(directory, 'out.wav') });
    assert(tts.value.durationSeconds === 1, 'WAV 时长应为 1 秒，实际 ' + tts.value.durationSeconds);
    assert(tts.value.chars > 10, '汉字应按 2 个计费字符计算');
    assert(tts.value.bytes === 48044, '输出字节数不对：' + tts.value.bytes);
    console.log('   OCR 落盘、ASR 读文件、TTS 写文件与时长解析通过');

    section('5. 非法输入应被拒绝');
    const pdfAsAudio = join(directory, 'a.mp3');
    await writeFile(pdfAsAudio, Buffer.alloc(10));
    const cases = [
        ['空 query', () => tools.deepseek_search.execute({}, exec)],
        ['超长 query', () => tools.deepseek_search.execute({ query: 'x'.repeat(129) }, exec)],
        ['非 http URL', () => tools.deepseek_fetch.execute({ url: 'ftp://example.com/a' }, exec)],
        ['带账号密码的 URL', () => tools.deepseek_fetch.execute({ url: 'https://u:p@example.com/a' }, exec)],
        ['不存在的文件', () => tools.deepseek_asr.execute({ file: join(directory, 'none.wav') }, exec)],
        ['ASR 收到 mp3', () => tools.deepseek_asr.execute({ file: pdfAsAudio }, exec)],
        ['OCR 非法 purpose', () => tools.deepseek_ocr.execute({ file: pdf, purpose: 'x' }, exec)],
        ['TTS 超长文本', () => tools.deepseek_tts.execute({ text: '汉'.repeat(5001) }, exec)],
        ['TTS 非法音色', () => tools.deepseek_tts.execute({ text: '你好', voice_id: 'x' }, exec)],
    ];
    for (const [label, run] of cases) {
        let threw = false;
        try { await run(); } catch { threw = true; }
        assert(threw, label + ' 应报错');
    }
    console.log('   9 类非法输入全部按要求报错');
}
finally {
    await rm(directory, { recursive: true, force: true });
}

console.log('\n共 ' + checks + ' 项断言，全部离线自检通过。');

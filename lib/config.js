/**
 * dsh-deepseek-tools 配置解析：API Key、根地址、超时、输出预算、TTS 目录。
 * 缺失字段给默认值；非法字段抛中文错误（与 dsh-ffmpeg 的做法一致）。
 *
 * @module dsh-deepseek-tools/config
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_RENDER_CHARS = 30000;

/** 判断是否普通对象（排除 null、数组）。 */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取非空字符串配置，未提供返回 undefined。 */
function optionalText(cfg, key) {
    const value = cfg[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        throw new Error('配置项 ' + key + ' 必须是字符串。');
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

/** 读取区间内的整数配置，未提供返回 defaultValue。 */
function optionalInteger(cfg, key, defaultValue, min, max) {
    const value = cfg[key];
    if (value === undefined || value === null)
        return defaultValue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error('配置项 ' + key + ' 必须是 ' + min + '–' + max + ' 的整数。');
    }
    return value;
}

/**
 * 解析并校验插件配置。
 * @param config - 插件行配置（可能为 undefined/null）。
 * @param env - 环境变量来源，便于测试注入。
 */
export function resolveConfig(config, env = process.env) {
    if (config !== undefined && config !== null && !isRecord(config)) {
        throw new Error('dsh-deepseek-tools 配置必须是对象。');
    }
    const cfg = config ?? {};
    const baseUrl = (optionalText(cfg, 'baseUrl') ?? env.DEEPSEEK_API_BASE_URL?.trim() ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error('配置项 baseUrl 必须是 http(s) 地址。');
    }
    return {
        baseUrl,
        apiKey: optionalText(cfg, 'apiKey') ?? env.DEEPSEEK_API_KEY?.trim() ?? '',
        timeoutMs: optionalInteger(cfg, 'timeoutMs', DEFAULT_TIMEOUT_MS, 5000, 3600000),
        maxRenderChars: optionalInteger(cfg, 'maxRenderChars', DEFAULT_MAX_RENDER_CHARS, 1000, 200000),
        outputDir: optionalText(cfg, 'outputDir') ?? '',
    };
}

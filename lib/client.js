/**
 * DeepSeek 工具 API 的 HTTP 客户端：Bearer 鉴权、超时、可重试错误与中文错误翻译。
 *
 * 端点（Base URL 见配置，默认 https://api.deepseek.com）：
 *   POST /v1/tools/search   网页搜索
 *   POST /v1/tools/fetch    网页抓取
 *   POST /v1/tools/ocr      OCR（multipart）
 *   POST /v1/tools/tts      语音合成（返回音频字节）
 *   POST /v1/tools/asr      语音识别（multipart）
 *
 * @module dsh-deepseek-tools/client
 */

/** 官方建议重试的状态码：408、429、5xx。 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** 凭据引用名：与 DSH 的 API Key 设置项同名，用户在设置里填一次即可。 */
const KEY_REF = 'DEEPSEEK_API_KEY';

/** 各状态码的中文处置提示（来自官方错误表）。 */
const STATUS_HINT = {
    400: '请求头或请求体不合法',
    401: 'API Key 缺失或无效',
    402: '账号余额不足，请先充值后重试',
    403: '请求被安全策略拒绝',
    404: '没有可用的网页内容（URL 不可用、被站点策略拦截，或页面没有可提取的正文）',
    408: '请求超时，可稍后重试',
    413: '请求体超过大小限制',
    429: '触发限速，请稍后重试',
    500: '服务端内部错误，可稍后重试',
    503: '服务繁忙，请稍后重试',
    504: '上游请求超时，可稍后重试',
};

/** 工具 API 调用失败。status 为 0 表示请求没有拿到 HTTP 响应（网络、超时、缺 Key）。 */
export class DeepSeekApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'DeepSeekApiError';
        this.status = status;
        this.code = code;
    }
}

/** 可取消的等待。 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(signal.reason ?? new Error('已取消'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve(undefined);
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error('已取消'));
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

/** 把调用方取消信号与单次请求超时合并成一个信号。 */
function combineSignals(callerSignal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (callerSignal === undefined)
        return timeout;
    if (typeof AbortSignal.any === 'function')
        return AbortSignal.any([callerSignal, timeout]);
    const controller = new AbortController();
    const abort = (source) => () => controller.abort(source.reason);
    callerSignal.addEventListener('abort', abort(callerSignal), { once: true });
    timeout.addEventListener('abort', abort(timeout), { once: true });
    return controller.signal;
}

/** 重试等待：优先尊重 Retry-After（秒），否则 1s、3s 递增。 */
function retryDelay(attempt, retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0)
        return Math.min(seconds * 1000, 30000);
    return attempt === 1 ? 1000 : 3000;
}

/** 提取响应体里的 OpenAI 兼容错误信息。 */
async function readErrorDetail(response) {
    let text = '';
    try {
        text = await response.text();
    }
    catch {
        return { message: '', code: 'http_' + response.status };
    }
    try {
        const body = JSON.parse(text);
        const error = typeof body === 'object' && body !== null ? body.error : undefined;
        if (typeof error === 'object' && error !== null) {
            const message = typeof error.message === 'string' ? error.message : '';
            const code = typeof error.code === 'string' ? error.code : (typeof error.type === 'string' ? error.type : 'error');
            return { message, code };
        }
    }
    catch {
        // 非 JSON 响应：保留一段原始文本。
    }
    return { message: text.slice(0, 300), code: 'http_' + response.status };
}

/** 组装一行中文错误信息。 */
function formatFailure(label, status, detail, options) {
    const hint = STATUS_HINT[status];
    const parts = [label + '失败（HTTP ' + status + (detail.code ? '，' + detail.code : '') + '）'];
    if (detail.message !== '')
        parts.push(detail.message);
    if (hint !== undefined)
        parts.push(hint);
    if (status === 401 && options.accountCredential) {
        parts.push('当前用的是 DeepSeek 账号的登录凭据，它只用于模型推理，不能调用工具 API；请在 config.apiKey 或环境变量 DEEPSEEK_API_KEY 里填平台 API Key（https://platform.deepseek.com/api_keys）');
    }
    else if (status === 401) {
        parts.push('请检查 config.apiKey 或环境变量 DEEPSEEK_API_KEY 是否正确');
    }
    return parts.join('：');
}

/**
 * 创建 API 客户端。
 * @param ctx - 宿主上下文（用于读取 credentials 与 deepseekAccount 凭据）。
 * @param cfg - 已解析配置。
 */
export function createApiClient(ctx, cfg) {
    /**
     * 解析 API Key：每次调用都重新解析，用户在任何设置里换了 Key 都立刻生效。
     * 顺序：config.apiKey > credentials 的 DEEPSEEK_API_KEY（含环境变量回退）>
     *       进程环境变量 > 已登录的 DeepSeek 账号凭据（只对推理端点有效，工具 API 会 401）。
     * @returns {{ key: string, source: string }}
     */
    async function resolveKey() {
        if (cfg.apiKey !== '')
            return { key: cfg.apiKey, source: 'config' };
        const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
        if (credentials !== undefined && typeof credentials.resolve === 'function') {
            let resolved;
            try {
                resolved = await credentials.resolve(KEY_REF);
            }
            catch {
                resolved = undefined;
            }
            if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.trim() !== '') {
                return { key: resolved.value.trim(), source: resolved.source ?? 'credential' };
            }
        }
        const fromEnv = (process.env.DEEPSEEK_API_KEY ?? '').trim();
        if (fromEnv !== '')
            return { key: fromEnv, source: 'env' };
        const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined;
        if (account !== undefined && typeof account.resolveToken === 'function') {
            let token;
            try {
                token = await account.resolveToken(cfg.baseUrl);
            }
            catch {
                token = undefined;
            }
            if (typeof token === 'string' && token.trim() !== '')
                return { key: token.trim(), source: 'account' };
        }
        throw new DeepSeekApiError(0, 'missing_api_key', '没有可用的 DeepSeek API Key：请在设置里填 DEEPSEEK_API_KEY、设置环境变量 DEEPSEEK_API_KEY，或在 profile 的 cordis.patch.yml 里给 deepseek-tools 行设置 config.apiKey。');
    }

    /**
     * 发送一次经过重试的 POST 请求，返回成功的 Response。
     * @param pathname - 例如 /v1/tools/search
     * @param label - 中文动作名，用于错误信息
     * @param options - { timeoutMs, retries, prepare(signal) => fetch init }
     */
    async function post(pathname, label, options, callerSignal) {
        const url = cfg.baseUrl + pathname;
        const maxAttempts = 1 + (options.retries ?? 2);
        const timeoutMs = options.timeoutMs;
        let lastFailure;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const credential = await resolveKey();
            const signal = combineSignals(callerSignal, timeoutMs);
            let response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: 'Bearer ' + credential.key,
                        Accept: 'application/json',
                        ...(options.headers ?? {}),
                    },
                    body: options.body,
                    signal,
                });
            }
            catch (error) {
                if (callerSignal?.aborted === true) {
                    throw callerSignal.reason ?? new Error('已取消');
                }
                const reason = error instanceof Error ? error.message : String(error);
                const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
                lastFailure = new DeepSeekApiError(0, timedOut ? 'timeout' : 'network_error', timedOut
                    ? label + '超时（' + Math.round(timeoutMs / 1000) + ' 秒）：' + url
                    : label + '请求失败（网络错误）：' + reason);
                if (attempt < maxAttempts) {
                    await sleep(retryDelay(attempt, undefined), callerSignal);
                    continue;
                }
                throw lastFailure;
            }
            if (response.ok)
                return response;
            const detail = await readErrorDetail(response);
            const fromAccount = response.status === 401 && credential.source === 'account';
            lastFailure = new DeepSeekApiError(response.status, detail.code, formatFailure(label, response.status, detail, { accountCredential: fromAccount }));
            if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) {
                throw lastFailure;
            }
            await sleep(retryDelay(attempt, response.headers.get('retry-after')), callerSignal);
        }
        throw lastFailure ?? new DeepSeekApiError(0, 'unknown', label + '失败：未知错误');
    }

    /** POST JSON 并解析 JSON 响应。 */
    async function postJson(pathname, label, payload, signal, timeoutMs) {
        const response = await post(pathname, label, {
            timeoutMs,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }, signal);
        try {
            return await response.json();
        }
        catch {
            throw new DeepSeekApiError(response.status, 'bad_response', label + '返回的不是合法 JSON。');
        }
    }

    /** POST multipart/form-data 并解析 JSON 响应（OCR 的响应带前导换行，JSON.parse 可接受）。 */
    async function postForm(pathname, label, form, signal, timeoutMs) {
        const response = await post(pathname, label, { timeoutMs, body: form }, signal);
        const text = await response.text();
        try {
            return JSON.parse(text);
        }
        catch {
            throw new DeepSeekApiError(response.status, 'bad_response', label + '返回的不是合法 JSON：' + text.slice(0, 200));
        }
    }

    /** POST JSON 并读取二进制响应（音频）。响应是 JSON 时按错误处理。 */
    async function postAudio(pathname, label, payload, signal, timeoutMs) {
        const response = await post(pathname, label, {
            timeoutMs,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }, signal);
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
            const text = await response.text();
            let message = text.slice(0, 300);
            try {
                const body = JSON.parse(text);
                if (typeof body?.error?.message === 'string')
                    message = body.error.message;
            }
            catch {
                // 保留原始文本
            }
            throw new DeepSeekApiError(response.status, 'invalid_input', label + '没有返回音频：' + message);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0) {
            throw new DeepSeekApiError(response.status, 'empty_audio', label + '返回了空音频，请把这次请求视为失败。');
        }
        return { bytes, contentType };
    }

    return { postJson, postForm, postAudio, resolveKey };
}

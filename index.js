/**
 * dsh-deepseek-tools —— DeepSeek 工具 API 调用插件（Host 半身，配置走 cordis.patch.yml）。
 *
 * 插件导出 apply(ctx, config)：把五个面向模型的工具注册进宿主工具表——
 *   deepseek_search（/v1/tools/search）  网页搜索
 *   deepseek_fetch （/v1/tools/fetch）   网页抓取
 *   deepseek_ocr   （/v1/tools/ocr）     OCR
 *   deepseek_tts   （/v1/tools/tts）     语音合成
 *   deepseek_asr   （/v1/tools/asr）     语音识别
 *
 * 只依赖 Node 内置能力（fetch / FormData / Blob），零运行时依赖。
 * API Key 缺失时插件照常加载，工具在 execute 时才抛出带中文指引的错误。
 *
 * @module dsh-deepseek-tools
 */
import { resolveConfig } from './lib/config.js';
import { createApiClient } from './lib/client.js';
import { buildTools } from './lib/tools.js';

/** cordis 服务注入：apply 里要用 ctx.tools，必须显式声明。 */
export const inject = ['tools'];

/**
 * 插件入口：解析配置、创建 API 客户端并注册五个工具。
 * @param ctx - 宿主上下文（至少含 tools.register）。
 * @param config - 插件行配置（可缺省）。
 */
export function apply(ctx, config) {
    const cfg = resolveConfig(config);
    const api = createApiClient(ctx, cfg);
    const definitions = buildTools(cfg, api);

    if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
            const disposers = definitions.map(definition => ctx.tools.register(definition));
            return () => {
                for (const dispose of disposers)
                    dispose();
            };
        });
        return;
    }

    const disposers = definitions.map(definition => ctx.tools.register(definition));
    if (typeof ctx.on === 'function') {
        ctx.on('dispose', () => {
            for (const dispose of disposers)
                dispose();
        });
    }
}

export * from './lib/config.js';
export * from './lib/client.js';
export * from './lib/tools.js';

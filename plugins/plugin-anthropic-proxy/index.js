/**
 * Plugin definition and `init()` for routing Anthropic API traffic through a
 * Claude Max/Pro subscription via Claude Code OAuth tokens. Registers the
 * proxy service, the `PROXY_STATUS` action, and the status route, re-exports
 * the transform primitives for downstream consumers, and self-declares
 * `autoEnable`. On start the service self-injects `ANTHROPIC_BASE_URL` so
 * plugin-anthropic routes transparently through the proxy.
 *
 * Modes (env CLAUDE_MAX_PROXY_MODE):
 *   inline (default): start an in-process proxy on this agent
 *   shared:           connect to an existing upstream proxy URL
 *   off:              load the plugin but don't start anything
 */
import { logger } from "@elizaos/core";
import { proxyStatusAction } from "./src/actions/proxy-status.action.js";
import { anthropicProxyRoutes } from "./src/routes/status-route.js";
import { AnthropicProxyService, resolveConfig } from "./src/services/proxy-service.js";
export { computeBillingFingerprint } from "./src/proxy/billing-fingerprint.js";
export { DEFAULT_REVERSE_MAP, DEFAULT_TOOL_RENAMES, } from "./src/proxy/constants.js";
export { processBody, } from "./src/proxy/process-body.js";
export { reverseMap } from "./src/proxy/reverse-map.js";
export { ProxyServer } from "./src/proxy/server.js";
export { getStainlessHeaders } from "./src/proxy/stainless-headers.js";
export { ANTHROPIC_PROXY_SERVICE_NAME, AnthropicProxyService, } from "./src/services/proxy-service.js";
export { loadCredentials } from "./src/utils/credentials-loader.js";
const anthropicProxyPlugin = {
    name: "anthropic-proxy",
    description: "In-process or shared proxy that routes Anthropic API traffic through a Claude Max/Pro subscription via Claude Code OAuth tokens",
    services: [AnthropicProxyService],
    actions: [proxyStatusAction],
    providers: [],
    routes: anthropicProxyRoutes,
    tests: [],
    /**
     * Mirror of `auto-enable.ts` for runtimes that consume the Plugin-object
     * `autoEnable` field instead of the per-plugin manifest module. Keep both
     * in sync. The per-plugin manifest engine reads `auto-enable.ts` while
     * legacy / cloud runtimes (eliza-cloud's `applyPluginSelfDeclaredAutoEnable`)
     * read this field. The opt-in is identical: CLAUDE_MAX_PROXY_MODE in
     * {inline, shared} enables; off / unset does not.
     */
    autoEnable: {
        shouldEnable: (env) => {
            const raw = env.CLAUDE_MAX_PROXY_MODE;
            if (!raw)
                return false;
            const mode = raw.trim().toLowerCase();
            if (mode === "" || mode === "off")
                return false;
            return mode === "inline" || mode === "shared";
        },
    },
    init: async (_config, _runtime) => {
        const cfg = resolveConfig();
        if (cfg.mode === "off") {
            logger.info("[anthropic-proxy] init — mode=off (ANTHROPIC_BASE_URL unchanged)");
            return;
        }
        logger.info(`[anthropic-proxy] init — mode=${cfg.mode}; service start will set ANTHROPIC_BASE_URL after validation`);
    },
};
export default anthropicProxyPlugin;
export { anthropicProxyPlugin };
//# sourceMappingURL=index.js.map
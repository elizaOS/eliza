/**
 * @elizaos/plugin-anthropic-proxy
 *
 * Routes Anthropic API traffic through a Claude Max/Pro subscription via
 * Claude Code OAuth tokens. Ports Shadow's existing standalone proxy
 * (ocplatform-routing-layer/proxy.js v2.2.3) into the eliza plugin shape.
 *
 * Modes (env CLAUDE_MAX_PROXY_MODE):
 *   inline (default): start an in-process proxy on this agent
 *   shared:           connect to an existing upstream proxy URL
 *   off:              load the plugin but don't start anything
 */
import { type Plugin } from "@elizaos/core";
export { computeBillingFingerprint } from "./src/proxy/billing-fingerprint.js";
export { DEFAULT_REVERSE_MAP, DEFAULT_TOOL_RENAMES, } from "./src/proxy/constants.js";
export { type ProcessBodyConfig, processBody, } from "./src/proxy/process-body.js";
export { reverseMap } from "./src/proxy/reverse-map.js";
export type { ProxyServerOptions, ProxyStats } from "./src/proxy/server.js";
export { ProxyServer } from "./src/proxy/server.js";
export { getStainlessHeaders } from "./src/proxy/stainless-headers.js";
export { ANTHROPIC_PROXY_SERVICE_NAME, AnthropicProxyService, type ProxyMode, type ProxyServiceConfig, } from "./src/services/proxy-service.js";
export { loadCredentials } from "./src/utils/credentials-loader.js";
declare const anthropicProxyPlugin: Plugin;
export default anthropicProxyPlugin;
export { anthropicProxyPlugin };
//# sourceMappingURL=index.d.ts.map
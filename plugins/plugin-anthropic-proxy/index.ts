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

import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { proxyStatusAction } from "./src/actions/proxy-status.action.js";
import { anthropicProxyRoutes } from "./src/routes/status-route.js";
import {
	ANTHROPIC_PROXY_SERVICE_NAME,
	AnthropicProxyService,
	resolveConfig,
} from "./src/services/proxy-service.js";

export {
	ANTHROPIC_PROXY_SERVICE_NAME,
	AnthropicProxyService,
	type ProxyMode,
	type ProxyServiceConfig,
} from "./src/services/proxy-service.js";

export { ProxyServer } from "./src/proxy/server.js";
export type { ProxyServerOptions, ProxyStats } from "./src/proxy/server.js";
export { processBody, type ProcessBodyConfig } from "./src/proxy/process-body.js";
export { reverseMap } from "./src/proxy/reverse-map.js";
export { computeBillingFingerprint } from "./src/proxy/billing-fingerprint.js";
export { loadCredentials } from "./src/utils/credentials-loader.js";

const anthropicProxyPlugin: Plugin = {
	name: "anthropic-proxy",
	description:
		"In-process or shared proxy that routes Anthropic API traffic through a Claude Max/Pro subscription via Claude Code OAuth tokens",

	services: [AnthropicProxyService],
	actions: [proxyStatusAction],
	providers: [],
	routes: anthropicProxyRoutes,
	tests: [],

	/**
	 * Mirror of `auto-enable.ts` for runtimes that consume the Plugin-object
	 * `autoEnable` field instead of the per-plugin manifest module. Keep both
	 * in sync. The per-plugin manifest engine reads `auto-enable.ts` while
	 * legacy / cloud runtimes (milady-cloud's `applyPluginSelfDeclaredAutoEnable`)
	 * read this field. The opt-in is identical: CLAUDE_MAX_PROXY_MODE in
	 * {inline, shared} enables; off / unset does not.
	 */
	autoEnable: {
		shouldEnable: (env): boolean => {
			const raw = env.CLAUDE_MAX_PROXY_MODE;
			if (!raw) return false;
			const mode = raw.trim().toLowerCase();
			if (mode === "" || mode === "off") return false;
			return mode === "inline" || mode === "shared";
		},
	},

	init: async (
		_config: Record<string, string>,
		_runtime: IAgentRuntime,
	): Promise<void> => {
		const cfg = resolveConfig();
		if (cfg.mode === "off") {
			logger.info(
				"[anthropic-proxy] init — mode=off (ANTHROPIC_BASE_URL unchanged)",
			);
			return;
		}

		logger.info(
			`[anthropic-proxy] init — mode=${cfg.mode}; service start will set ANTHROPIC_BASE_URL after validation`,
		);
	},
};

export default anthropicProxyPlugin;
export { anthropicProxyPlugin };

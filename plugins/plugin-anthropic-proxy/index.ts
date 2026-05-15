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

const SENTINEL = "auto";

/**
 * Decide whether ANTHROPIC_BASE_URL should be set by us.
 * - unset: yes
 * - explicit value: leave alone
 * - "auto": yes (sentinel meaning "let the plugin pick")
 */
function shouldSetBaseUrl(current: string | undefined): boolean {
	if (current === undefined || current === "") return true;
	if (current.toLowerCase() === SENTINEL) return true;
	return false;
}

const anthropicProxyPlugin: Plugin = {
	name: "anthropic-proxy",
	description:
		"In-process or shared proxy that routes Anthropic API traffic through a Claude Max/Pro subscription via Claude Code OAuth tokens",

	services: [AnthropicProxyService],
	actions: [proxyStatusAction],
	providers: [],
	routes: anthropicProxyRoutes,
	tests: [],

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

		// We can't query the running service here (start happens after init in
		// most setups). Build the URL deterministically from config.
		let target: string | null = null;
		if (cfg.mode === "shared") {
			target = cfg.upstream?.replace(/\/$/, "") ?? null;
		} else if (cfg.mode === "inline") {
			target = `http://${cfg.bindHost}:${cfg.port}`;
		}
		if (!target) {
			logger.warn(
				`[anthropic-proxy] init — mode=${cfg.mode} but no target URL resolvable; ANTHROPIC_BASE_URL unchanged`,
			);
			return;
		}

		const current = process.env.ANTHROPIC_BASE_URL;
		if (shouldSetBaseUrl(current)) {
			process.env.ANTHROPIC_BASE_URL = target;
			logger.info(
				`[anthropic-proxy] init — set ANTHROPIC_BASE_URL=${target} (mode=${cfg.mode})`,
			);
		} else {
			logger.info(
				`[anthropic-proxy] init — ANTHROPIC_BASE_URL already set (${current}); leaving as-is`,
			);
		}
	},
};

export default anthropicProxyPlugin;
export { anthropicProxyPlugin };

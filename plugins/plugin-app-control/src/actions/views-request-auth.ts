/**
 * Authenticates app-control's loopback view requests with the same API token
 * the local HTTP boundary validates. The canonical alias-aware token wins;
 * the plugin's older auth-token variable remains a compatibility fallback.
 */

import { createSelfApiRequestHeaders } from "@elizaos/shared/runtime-env";

type RuntimeEnv = Record<string, string | undefined>;

export function createViewsRequestHeaders(
	env: RuntimeEnv = process.env,
): Record<string, string> {
	return {
		"Content-Type": "application/json",
		...createSelfApiRequestHeaders(env),
	};
}

/**
 * Authenticates app-control's loopback view requests with the same API token
 * the local HTTP boundary validates. The canonical alias-aware token wins;
 * the plugin's older auth-token variable remains a compatibility fallback.
 */

import { firstWinningEnvString } from "@elizaos/shared/runtime-env";

type RuntimeEnv = Record<string, string | undefined>;

export function createViewsRequestHeaders(
	env: RuntimeEnv = process.env,
): Record<string, string> {
	const canonicalToken = firstWinningEnvString(env, ["ELIZA_API_TOKEN"])?.value;
	const legacyToken = env.ELIZA_API_AUTH_TOKEN?.trim();
	const token = canonicalToken ?? (legacyToken || undefined);
	return {
		"Content-Type": "application/json",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

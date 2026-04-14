import type { IAgentRuntime } from "@elizaos/core";
import type { AgentCredentials } from "coding-agent-adapters";
import { readConfigCloudKey, readConfigEnvKey } from "./config-env.ts";

const ELIZA_CLOUD_ANTHROPIC_BASE = "https://www.elizacloud.ai/api";
const ELIZA_CLOUD_OPENAI_BASE = "https://www.elizacloud.ai/api/v1";

/**
 * Codex per-spawn config.toml snippet that forces a custom OpenAI provider
 * with `supports_websockets = false`.
 *
 * Why this is needed: Codex 0.118+ tries to upgrade `/v1/responses` to a
 * WebSocket before falling back to POST streaming. Eliza Cloud's Next.js
 * route and Vercel AI Gateway both 405 the upgrade, causing ~7 seconds of
 * "Reconnecting…" + a URL-error banner before the fallback kicks in.
 *
 * Why a custom provider (not [features]): The TOML `[features]` flags
 * `responses_websockets` / `responses_websockets_v2` were removed from
 * Codex's `responses_websocket_enabled()` gate in newer builds. The only
 * remaining knobs are `provider.supports_websockets` and a runtime
 * AtomicBool latched after the first WS failure. We can't override the
 * built-in `openai` provider directly because Codex's config loader uses
 * `or_insert` (built-ins win), so we define a NEW provider key and
 * select it via top-level `model_provider`.
 *
 * The custom provider keeps `name = "OpenAI"` so Codex's `is_openai()`
 * checks still trigger any openai-specific code paths, and copies
 * `wire_api = "responses"` / `requires_openai_auth = true` from the
 * built-in. `base_url` is set to the cloud proxy URL so requests still
 * hit the proxy.
 */
function buildCodexCloudProviderToml(baseUrl: string): string {
	return (
		`model_provider = "elizacloud"\n` +
		`\n` +
		`[model_providers.elizacloud]\n` +
		`name = "OpenAI"\n` +
		`base_url = "${baseUrl}"\n` +
		`wire_api = "responses"\n` +
		`requires_openai_auth = true\n` +
		`supports_websockets = false\n`
	);
}

type ExtendedAgentCredentials = AgentCredentials & {
	anthropicBaseUrl?: string;
	openaiBaseUrl?: string;
	extraConfigToml?: string;
};

function compactCredentials(
	credentials: ExtendedAgentCredentials,
): ExtendedAgentCredentials {
	return Object.fromEntries(
		Object.entries(credentials).filter(([, value]) => value !== undefined),
	) as ExtendedAgentCredentials;
}

export function isAnthropicOAuthToken(
	value: string | undefined,
): value is string {
	return typeof value === "string" && value.startsWith("sk-ant-oat");
}

export function sanitizeCustomCredentials(
	customCredentials: Record<string, string> | undefined,
	blockedValues: string[] = [],
): Record<string, string> | undefined {
	if (!customCredentials) {
		return undefined;
	}

	const blocked = new Set(blockedValues.filter(Boolean));
	const filtered = Object.entries(customCredentials).filter(
		([, value]) => !blocked.has(value),
	);
	return filtered.length > 0 ? Object.fromEntries(filtered) : undefined;
}

export function buildAgentCredentials(
	runtime: IAgentRuntime,
): AgentCredentials {
	const llmProvider =
		readConfigEnvKey("PARALLAX_LLM_PROVIDER") || "subscription";

	if (llmProvider === "cloud") {
		const cloudKey = readConfigCloudKey("apiKey");
		if (!cloudKey) {
			throw new Error(
				"Eliza Cloud is selected as the LLM provider but no cloud.apiKey is paired. Pair your account in the Cloud settings section first.",
			);
		}
		const cloudCredentials = compactCredentials({
			anthropicKey: cloudKey,
			openaiKey: cloudKey,
			googleKey: undefined,
			anthropicBaseUrl: ELIZA_CLOUD_ANTHROPIC_BASE,
			openaiBaseUrl: ELIZA_CLOUD_OPENAI_BASE,
			githubToken: runtime.getSetting("GITHUB_TOKEN") as string | undefined,
			// Disable Codex's Responses-API WebSocket transport when proxying
			// through cloud — see buildCodexCloudProviderToml doc for why this
			// requires a custom provider definition rather than [features].
			extraConfigToml: buildCodexCloudProviderToml(ELIZA_CLOUD_OPENAI_BASE),
		});
		return cloudCredentials;
	}

	const subscriptionMode = llmProvider === "subscription";
	const rawAnthropicKey = runtime.getSetting("ANTHROPIC_API_KEY") as
		| string
		| undefined;
	const anthropicKey = isAnthropicOAuthToken(rawAnthropicKey)
		? undefined
		: rawAnthropicKey;
	const directCredentials = compactCredentials({
		anthropicKey: subscriptionMode ? undefined : anthropicKey,
		openaiKey: runtime.getSetting("OPENAI_API_KEY") as string | undefined,
		googleKey: runtime.getSetting("GOOGLE_GENERATIVE_AI_API_KEY") as
			| string
			| undefined,
		githubToken: runtime.getSetting("GITHUB_TOKEN") as string | undefined,
		anthropicBaseUrl: subscriptionMode
			? undefined
			: anthropicKey
				? (runtime.getSetting("ANTHROPIC_BASE_URL") as string | undefined)
				: undefined,
		openaiBaseUrl: runtime.getSetting("OPENAI_BASE_URL") as string | undefined,
	});
	return directCredentials;
}

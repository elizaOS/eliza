/**
 * Shared live LLM provider selection for real integration tests.
 *
 * Extracts and generalizes the provider detection pattern used across
 * the codebase (lifeops-live-harness.ts, lifeops-llm-extraction.live.test.ts)
 * into a single reusable module.
 *
 * Usage:
 *   import { selectLiveProvider, requireLiveProvider } from "../../test/helpers/live-provider";
 *
 *   const provider = selectLiveProvider();            // null if none available
 *   const provider = requireLiveProvider();           // skips test if none
 *   const provider = requireLiveProvider("openai");   // skips if openai key missing
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAliasedEnvValue } from "../boot-env";
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "../contracts/service-routing";

const ELIZA_CLOUD_OPENAI_BASE_URL = "https://elizacloud.ai/api/v1";
const CEREBRAS_OPENAI_BASE_URL = "https://api.cerebras.ai/v1";

function loadConfiguredCloudApiKey(): string {
	const namespace =
		resolveAliasedEnvValue("ELIZA_NAMESPACE")?.trim() || "eliza";
	const configuredPath =
		resolveAliasedEnvValue("ELIZA_CONFIG_PATH")?.trim() ||
		path.join(os.homedir(), `.${namespace}`, `${namespace}.json`);

	try {
		const raw = fs.readFileSync(configuredPath, "utf8");
		const parsed = JSON.parse(raw) as {
			cloud?: {
				apiKey?: unknown;
			};
		};
		return typeof parsed.cloud?.apiKey === "string"
			? parsed.cloud.apiKey.trim()
			: "";
	} catch {
		return "";
	}
}

// Module-level cache of the on-disk cloud API key. Read on first use rather
// than at module-init so tests that change env vars between test files
// observe the latest value, and so this module's import graph stays
// TLA-free (Bun.build mobile bundler refuses to require any module
// transitively reachable from a TLA).
let cachedConfiguredCloudApiKey: string | null = null;
function getConfiguredCloudApiKey(): string {
	if (cachedConfiguredCloudApiKey === null) {
		cachedConfiguredCloudApiKey = loadConfiguredCloudApiKey();
	}
	return cachedConfiguredCloudApiKey;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LiveProviderName =
	| "groq"
	| "openai"
	| "anthropic"
	| "google"
	| "openrouter"
	| "cli";

export type LiveProviderConfig = {
	name: LiveProviderName;
	apiKey: string;
	baseUrl: string;
	smallModel: string;
	largeModel: string;
	/** The @elizaos/plugin-* package name to register with the runtime. */
	pluginPackage: string;
	/** Env vars to set for the runtime process. */
	env: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

const PROVIDERS: Array<{
	name: LiveProviderName;
	plugin: string;
	keyEnvVars: string[];
	baseUrlEnvVar?: string;
	defaultBaseUrl: string;
	smallModelEnvVar: string;
	largeModelEnvVar: string;
	defaultSmallModel: string;
	defaultLargeModel: string;
}> = [
	{
		name: "groq",
		plugin: "@elizaos/plugin-groq",
		keyEnvVars: ["GROQ_API_KEY"],
		defaultBaseUrl: "https://api.groq.com/openai/v1",
		smallModelEnvVar: "GROQ_SMALL_MODEL",
		largeModelEnvVar: "GROQ_LARGE_MODEL",
		defaultSmallModel: "openai/gpt-oss-120b",
		defaultLargeModel: "openai/gpt-oss-120b",
	},
	{
		name: "openai",
		plugin: "@elizaos/plugin-openai",
		keyEnvVars: ["OPENAI_API_KEY", "CEREBRAS_API_KEY"],
		baseUrlEnvVar: "OPENAI_BASE_URL",
		defaultBaseUrl: "https://api.openai.com/v1",
		smallModelEnvVar: "OPENAI_SMALL_MODEL",
		largeModelEnvVar: "OPENAI_LARGE_MODEL",
		defaultSmallModel: "gpt-5-mini",
		defaultLargeModel: "gpt-5-mini",
	},
	{
		name: "anthropic",
		plugin: "@elizaos/plugin-anthropic",
		keyEnvVars: ["ANTHROPIC_API_KEY"],
		defaultBaseUrl: "https://api.anthropic.com",
		smallModelEnvVar: "ANTHROPIC_SMALL_MODEL",
		largeModelEnvVar: "ANTHROPIC_LARGE_MODEL",
		defaultSmallModel: "claude-haiku-4-5-20251001",
		defaultLargeModel: "claude-haiku-4-5-20251001",
	},
	{
		name: "google",
		plugin: "@elizaos/plugin-google-genai",
		keyEnvVars: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
		defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
		smallModelEnvVar: "GOOGLE_SMALL_MODEL",
		largeModelEnvVar: "GOOGLE_LARGE_MODEL",
		defaultSmallModel: "gemini-2.0-flash-001",
		defaultLargeModel: "gemini-2.0-flash-001",
	},
	{
		name: "openrouter",
		plugin: "@elizaos/plugin-openrouter",
		keyEnvVars: ["OPENROUTER_API_KEY"],
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		smallModelEnvVar: "OPENROUTER_SMALL_MODEL",
		largeModelEnvVar: "OPENROUTER_LARGE_MODEL",
		defaultSmallModel: "google/gemini-2.5-flash-lite",
		defaultLargeModel: "google/gemini-2.5-flash-lite",
	},
];

// ---------------------------------------------------------------------------
// CLI-subscription provider (@elizaos/plugin-cli-inference)
//
// A subscription-only host (Claude Max / ChatGPT-Codex, no API key) can serve
// live inference through the sanctioned local CLI: ELIZA_CHAT_VIA_CLI selects
// the backend and the CLI reads its own on-disk credentials — eliza never sees
// the token, so there is no real apiKey. Kept LAST in preference order so any
// real API key (or an Eliza Cloud key) always wins.
// ---------------------------------------------------------------------------

const CLI_BACKENDS = ["claude", "claude-sdk", "codex", "codex-sdk"] as const;
type CliBackend = (typeof CLI_BACKENDS)[number];

/**
 * Sentinel used as `apiKey` for the CLI-subscription provider. The CLI backend
 * loads its own credentials from disk (~/.claude/.credentials.json or
 * ~/.codex/auth.json); no API key ever passes through eliza.
 */
export const CLI_SUBSCRIPTION_SENTINEL_API_KEY =
	"cli-subscription:no-api-key-cli-reads-own-credentials";

/** Env vars forwarded to the runtime when the cli provider is selected. */
const CLI_PASSTHROUGH_ENV_VARS = [
	"ELIZA_PLANNER_NATIVE_TOOLS",
	"ELIZA_CLI_CLAUDE_MODEL",
	"ELIZA_CLI_CLAUDE_PLANNER_MODEL",
	"ELIZA_CLI_CLAUDE_BIN",
	"ELIZA_CLI_SDK_RESTART_AFTER_TURNS",
	"ELIZA_CLI_CODEX_MODEL",
	"ELIZA_CLI_CODEX_PLANNER_MODEL",
	"ELIZA_CLI_CODEX_REASONING_EFFORT",
	"ELIZA_CLI_CODEX_BIN",
	"ELIZA_CLI_TIMEOUT_MS",
] as const;

function resolveConfiguredCliBackend(): CliBackend | null {
	const raw = process.env.ELIZA_CHAT_VIA_CLI?.trim().toLowerCase();
	return (CLI_BACKENDS as readonly string[]).includes(raw ?? "")
		? (raw as CliBackend)
		: null;
}

/**
 * The on-disk credentials file the CLI backend reads for itself. Resolved via
 * os.homedir() (which honors $HOME on POSIX) so unit tests can point it at a
 * temp directory instead of the real user profile.
 */
export function cliBackendCredentialsPath(backend: CliBackend): string {
	return backend.startsWith("codex")
		? path.join(os.homedir(), ".codex", "auth.json")
		: path.join(os.homedir(), ".claude", ".credentials.json");
}

function selectCliProvider(): LiveProviderConfig | null {
	const backend = resolveConfiguredCliBackend();
	if (!backend) return null;
	if (!fs.existsSync(cliBackendCredentialsPath(backend))) return null;

	const isCodex = backend.startsWith("codex");
	const model = isCodex
		? process.env.ELIZA_CLI_CODEX_MODEL?.trim() || "gpt-5.5"
		: process.env.ELIZA_CLI_CLAUDE_MODEL?.trim() || "claude-opus-4-7";

	const env: Record<string, string> = { ELIZA_CHAT_VIA_CLI: backend };
	for (const envVar of CLI_PASSTHROUGH_ENV_VARS) {
		const val = process.env[envVar]?.trim();
		if (val !== undefined && val !== "") env[envVar] = val;
	}

	return {
		name: "cli",
		apiKey: CLI_SUBSCRIPTION_SENTINEL_API_KEY,
		baseUrl: `cli://${backend}`,
		// plugin-cli-inference registers large-tier handlers only; both tiers
		// map to the same subscription-served model.
		smallModel: model,
		largeModel: model,
		pluginPackage: "@elizaos/plugin-cli-inference",
		env,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select the first available LLM provider based on environment variables.
 * Returns null if no provider API keys are found.
 *
 * Preference order: groq (cheapest/fastest) -> openai -> anthropic -> google
 * -> openrouter -> Eliza Cloud key -> cli subscription backend (last: real
 * keys always win over the slow CLI-spawn route).
 */
export function selectLiveProvider(
	preferredProvider?: LiveProviderName,
): LiveProviderConfig | null {
	const candidates = preferredProvider
		? PROVIDERS.filter((p) => p.name === preferredProvider)
		: PROVIDERS;

	for (const def of candidates) {
		let apiKey = "";
		let apiKeyEnvVar = "";
		for (const envVar of def.keyEnvVars) {
			const val = process.env[envVar]?.trim();
			if (val) {
				apiKey = val;
				apiKeyEnvVar = envVar;
				break;
			}
		}
		if (!apiKey) continue;

		const isCerebrasOpenAi =
			def.name === "openai" && apiKeyEnvVar === "CEREBRAS_API_KEY";
		const baseUrl = def.baseUrlEnvVar
			? process.env[def.baseUrlEnvVar]?.trim() ||
				(isCerebrasOpenAi ? CEREBRAS_OPENAI_BASE_URL : def.defaultBaseUrl)
			: def.defaultBaseUrl;

		const defaultSmallModel = isCerebrasOpenAi
			? DEFAULT_CEREBRAS_TEXT_MODEL
			: def.defaultSmallModel;
		const defaultLargeModel = isCerebrasOpenAi
			? DEFAULT_CEREBRAS_TEXT_MODEL
			: def.defaultLargeModel;
		const smallModel =
			process.env[def.smallModelEnvVar]?.trim() || defaultSmallModel;
		const largeModel =
			process.env[def.largeModelEnvVar]?.trim() || defaultLargeModel;

		const env: Record<string, string> = {};
		for (const envVar of def.keyEnvVars) {
			const val = process.env[envVar]?.trim();
			if (val) env[envVar] = val;
		}
		if (def.baseUrlEnvVar) {
			const baseUrlVal = process.env[def.baseUrlEnvVar]?.trim();
			if (baseUrlVal) env[def.baseUrlEnvVar] = baseUrlVal;
			else if (isCerebrasOpenAi) env[def.baseUrlEnvVar] = baseUrl;
		}
		if (isCerebrasOpenAi) {
			env.ELIZA_PROVIDER = process.env.ELIZA_PROVIDER?.trim() || "cerebras";
		}
		env[def.smallModelEnvVar] = smallModel;
		env[def.largeModelEnvVar] = largeModel;
		env.SMALL_MODEL = process.env.SMALL_MODEL?.trim() || smallModel;
		env.LARGE_MODEL = process.env.LARGE_MODEL?.trim() || largeModel;

		return {
			name: def.name,
			apiKey,
			baseUrl,
			smallModel,
			largeModel,
			pluginPackage: def.plugin,
			env,
		};
	}

	const cloudApiKey =
		process.env.ELIZAOS_CLOUD_API_KEY?.trim() ||
		process.env.ELIZA_CLOUD_API_KEY?.trim() ||
		getConfiguredCloudApiKey();
	if (cloudApiKey && (!preferredProvider || preferredProvider === "openai")) {
		const smallModel = process.env.OPENAI_SMALL_MODEL?.trim() || "gpt-5.4-mini";
		const largeModel =
			process.env.OPENAI_LARGE_MODEL?.trim() ||
			process.env.OPENAI_SMALL_MODEL?.trim() ||
			"gpt-5.4-mini";

		return {
			name: "openai",
			apiKey: cloudApiKey,
			baseUrl: ELIZA_CLOUD_OPENAI_BASE_URL,
			smallModel,
			largeModel,
			pluginPackage: "@elizaos/plugin-openai",
			env: {
				OPENAI_API_KEY: cloudApiKey,
				OPENAI_BASE_URL: ELIZA_CLOUD_OPENAI_BASE_URL,
				OPENAI_SMALL_MODEL: smallModel,
				OPENAI_LARGE_MODEL: largeModel,
				SMALL_MODEL: process.env.SMALL_MODEL?.trim() || smallModel,
				LARGE_MODEL: process.env.LARGE_MODEL?.trim() || largeModel,
			},
		};
	}

	if (!preferredProvider || preferredProvider === "cli") {
		return selectCliProvider();
	}

	return null;
}

/**
 * Select a live provider, or skip the current test if none is available.
 * Useful as a top-level call in describe/it blocks.
 */
export function requireLiveProvider(
	preferredProvider?: LiveProviderName,
): LiveProviderConfig {
	const provider = selectLiveProvider(preferredProvider);
	if (!provider) {
		const { test } = require("vitest");
		test.skip("No LLM provider API key available");
		throw new Error("No LLM provider API key available");
	}
	return provider;
}

/**
 * Check if live testing is enabled via ELIZA_LIVE_TEST or LIVE env vars.
 */
export function isLiveTestEnabled(): boolean {
	return process.env.ELIZA_LIVE_TEST === "1" || process.env.LIVE === "1";
}

/**
 * Returns a list of all LLM provider env var names that have keys set.
 */
export function availableProviderNames(): LiveProviderName[] {
	const providers = new Set<LiveProviderName>(
		PROVIDERS.filter((def) =>
			def.keyEnvVars.some((k) => process.env[k]?.trim()),
		).map((def) => def.name),
	);
	if (
		process.env.ELIZAOS_CLOUD_API_KEY?.trim() ||
		process.env.ELIZA_CLOUD_API_KEY?.trim() ||
		getConfiguredCloudApiKey()
	) {
		providers.add("openai");
	}
	if (selectCliProvider()) {
		providers.add("cli");
	}
	return [...providers];
}

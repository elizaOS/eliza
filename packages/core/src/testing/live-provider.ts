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

// Load .env from repo root if dotenv is available
const REPO_ROOT =
	process.env.ELIZA_REPO_ROOT?.trim() ||
	(typeof import.meta.dirname === "string"
		? path.resolve(import.meta.dirname, "..", "..", "..", "..")
		: process.cwd());
try {
	const { config } = await import("dotenv");
	config({ path: path.join(REPO_ROOT, ".env") });
} catch {
	// dotenv optional
}

const ELIZA_CLOUD_OPENAI_BASE_URL = "https://elizacloud.ai/api/v1";

function loadConfiguredCloudApiKey(): string {
	const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
	const configuredPath =
		process.env.ELIZA_CONFIG_PATH?.trim() ||
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

const configuredCloudApiKey = loadConfiguredCloudApiKey();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LiveProviderName =
	| "groq"
	| "openai"
	| "anthropic"
	| "google"
	| "openrouter";

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
		defaultSmallModel: "llama-3.1-8b-instant",
		defaultLargeModel: "llama-3.1-8b-instant",
	},
	{
		name: "openai",
		plugin: "@elizaos/plugin-openai",
		keyEnvVars: ["OPENAI_API_KEY"],
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
		defaultSmallModel: "google/gemini-2.0-flash-001",
		defaultLargeModel: "google/gemini-2.0-flash-001",
	},
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select the first available LLM provider based on environment variables.
 * Returns null if no provider API keys are found.
 *
 * Preference order: groq (cheapest/fastest) -> openai -> anthropic -> google -> openrouter
 */
export function selectLiveProvider(
	preferredProvider?: LiveProviderName,
): LiveProviderConfig | null {
	const candidates = preferredProvider
		? PROVIDERS.filter((p) => p.name === preferredProvider)
		: PROVIDERS;

	for (const def of candidates) {
		let apiKey = "";
		for (const envVar of def.keyEnvVars) {
			const val = process.env[envVar]?.trim();
			if (val) {
				apiKey = val;
				break;
			}
		}
		if (!apiKey) continue;

		const baseUrl = def.baseUrlEnvVar
			? process.env[def.baseUrlEnvVar]?.trim() || def.defaultBaseUrl
			: def.defaultBaseUrl;

		const smallModel =
			process.env[def.smallModelEnvVar]?.trim() || def.defaultSmallModel;
		const largeModel =
			process.env[def.largeModelEnvVar]?.trim() || def.defaultLargeModel;

		const env: Record<string, string> = {};
		for (const envVar of def.keyEnvVars) {
			const val = process.env[envVar]?.trim();
			if (val) env[envVar] = val;
		}
		if (def.baseUrlEnvVar) {
			const baseUrlVal = process.env[def.baseUrlEnvVar]?.trim();
			if (baseUrlVal) env[def.baseUrlEnvVar] = baseUrlVal;
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
		configuredCloudApiKey;
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
		configuredCloudApiKey
	) {
		providers.add("openai");
	}
	return [...providers];
}

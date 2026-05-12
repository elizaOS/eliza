/** Selects a live LLM provider for integration tests from env and local config. */

import path from "node:path";
import { test } from "vitest";

// Load `.env` from the repo root when `dotenv` is available.
const REPO_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);
try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  // dotenv optional
}

function getTrimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function providerKeyMatchesSelection(
  providerName: LiveProviderName,
  apiKey: string,
): boolean {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return false;
  }

  if (providerName === "openai" && /^gsk[-_]/i.test(trimmed)) {
    return false;
  }

  if (providerName === "openai" && /^csk[-_]/i.test(trimmed)) {
    return false;
  }

  return true;
}

function getLiveTestModelOverride(kind: "small" | "large"): string | null {
  const key =
    kind === "small"
      ? ["ELIZA_LIVE_TEST_SMALL_MODEL", "ELIZA_LIVE_TEST_SMALL_MODEL"]
      : ["ELIZA_LIVE_TEST_LARGE_MODEL", "ELIZA_LIVE_TEST_LARGE_MODEL"];

  for (const name of key) {
    const value = getTrimmedEnv(name);
    if (value) {
      return value;
    }
  }

  return null;
}

function getLiveTestBaseUrlOverride(
  providerName: LiveProviderName,
): string | null {
  const suffix = providerName.toUpperCase().replace(/-/g, "_");
  for (const name of [`ELIZA_LIVE_TEST_${suffix}_BASE_URL`]) {
    const value = getTrimmedEnv(name);
    if (value) {
      return value;
    }
  }

  return null;
}

export type LiveProviderName =
  | "cerebras"
  | "groq"
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "local-llama-cpp";

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

export const LIVE_PROVIDER_ENV_KEYS = new Set<string>([
  "MILADY_PROVIDER",
  "SMALL_MODEL",
  "MEDIUM_MODEL",
  "LARGE_MODEL",
  "ACTION_PLANNER_MODEL",
  "PLANNER_MODEL",
  "OPENAI_MEDIUM_MODEL",
  "OPENAI_ACTION_PLANNER_MODEL",
  "OPENAI_PLANNER_MODEL",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZA_CLOUD_API_KEY",
  "ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS",
]);

const PROVIDERS: Array<{
  name: LiveProviderName;
  plugin: string;
  /** Canonical env var names the plugin reads at runtime. First entry is the
   *  primary name and is always set in the propagated env when discovered. */
  keyEnvVars: string[];
  /** Additional env var names checked during discovery only (e.g. CI-scoped
   *  `ELIZA_E2E_*` aliases). When one of these holds the key, it is
   *  propagated under the canonical `keyEnvVars[0]` name so plugins find it. */
  keyEnvVarAliases?: string[];
  baseUrlEnvVar?: string;
  defaultBaseUrl: string;
  smallModelEnvVar: string;
  largeModelEnvVar: string;
  defaultSmallModel: string;
  defaultLargeModel: string;
}> = [
  {
    name: "cerebras",
    plugin: "@elizaos/plugin-openai",
    keyEnvVars: ["CEREBRAS_API_KEY"],
    keyEnvVarAliases: ["ELIZA_E2E_CEREBRAS_API_KEY"],
    baseUrlEnvVar: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    smallModelEnvVar: "OPENAI_SMALL_MODEL",
    largeModelEnvVar: "OPENAI_LARGE_MODEL",
    defaultSmallModel: "gpt-oss-120b",
    defaultLargeModel: "gpt-oss-120b",
  },
  {
    name: "groq",
    plugin: "@elizaos/plugin-groq",
    keyEnvVars: ["GROQ_API_KEY"],
    keyEnvVarAliases: ["ELIZA_E2E_GROQ_API_KEY"],
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    smallModelEnvVar: "GROQ_SMALL_MODEL",
    largeModelEnvVar: "GROQ_LARGE_MODEL",
    defaultSmallModel: "openai/gpt-oss-120b",
    defaultLargeModel: "openai/gpt-oss-120b",
  },
  {
    name: "openai",
    plugin: "@elizaos/plugin-openai",
    keyEnvVars: ["OPENAI_API_KEY"],
    keyEnvVarAliases: ["ELIZA_E2E_OPENAI_API_KEY"],
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
    keyEnvVarAliases: ["ELIZA_E2E_ANTHROPIC_API_KEY"],
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
    keyEnvVarAliases: ["ELIZA_E2E_GOOGLE_GENERATIVE_AI_API_KEY"],
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
    keyEnvVarAliases: ["ELIZA_E2E_OPENROUTER_API_KEY"],
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    smallModelEnvVar: "OPENROUTER_SMALL_MODEL",
    largeModelEnvVar: "OPENROUTER_LARGE_MODEL",
    defaultSmallModel: "google/gemini-2.0-flash-001",
    defaultLargeModel: "google/gemini-2.0-flash-001",
  },
  {
    // Local OpenAI-compatible server (dflash llama-server fork or Ollama).
    // The dflash fork at ~/.cache/eliza-dflash/eliza-llama-cpp is preferred
    // when present; otherwise PARALLAX_OPENCODE_BASE_URL points at Ollama
    // (default http://localhost:11434/v1). No real API key is required, but
    // the selector requires a non-empty key string, so callers must set
    // LOCAL_LLAMA_CPP_API_KEY=local (or rely on the explicit
    // selectLiveProvider("local-llama-cpp") path which seeds the sentinel).
    name: "local-llama-cpp",
    plugin: "@elizaos/plugin-openai",
    keyEnvVars: ["LOCAL_LLAMA_CPP_API_KEY"],
    baseUrlEnvVar: "OPENAI_BASE_URL",
    defaultBaseUrl: "http://localhost:11434/v1",
    smallModelEnvVar: "OPENAI_SMALL_MODEL",
    largeModelEnvVar: "OPENAI_LARGE_MODEL",
    defaultSmallModel: "qwen3-0.6b-q8_0",
    defaultLargeModel: "qwen3-1.7b-q4_k_m",
  },
];

for (const provider of PROVIDERS) {
  for (const key of provider.keyEnvVars) {
    LIVE_PROVIDER_ENV_KEYS.add(key);
  }
  for (const key of provider.keyEnvVarAliases ?? []) {
    LIVE_PROVIDER_ENV_KEYS.add(key);
  }
  if (provider.baseUrlEnvVar) {
    LIVE_PROVIDER_ENV_KEYS.add(provider.baseUrlEnvVar);
  }
  LIVE_PROVIDER_ENV_KEYS.add(provider.smallModelEnvVar);
  LIVE_PROVIDER_ENV_KEYS.add(provider.largeModelEnvVar);
}

/** All env var names (canonical + aliases) that may hold a key for `provider`. */
function providerKeyEnvCandidates(provider: {
  keyEnvVars: string[];
  keyEnvVarAliases?: string[];
}): string[] {
  return [...provider.keyEnvVars, ...(provider.keyEnvVarAliases ?? [])];
}

/**
 * Select the first available LLM provider based on environment variables.
 * Returns null if no provider API keys are found.
 *
 * Preference order: cerebras -> groq -> openai -> anthropic -> google -> openrouter.
 */
export function selectLiveProvider(
  preferredProvider?: LiveProviderName,
): LiveProviderConfig | null {
  const candidates = preferredProvider
    ? PROVIDERS.filter((p) => p.name === preferredProvider)
    : PROVIDERS;

  for (const def of candidates) {
    let apiKey = "";
    for (const envVar of providerKeyEnvCandidates(def)) {
      const val = getTrimmedEnv(envVar);
      if (val && providerKeyMatchesSelection(def.name, val)) {
        apiKey = val;
        break;
      }
    }
    if (!apiKey) continue;

    // Cerebras gate: CEREBRAS_API_KEY alone is for *evaluation/training*
    // (lifeops-eval-model.ts). The agent runtime should only opt into
    // Cerebras when the operator explicitly says so via MILADY_PROVIDER or
    // an explicit cerebras OPENAI_BASE_URL. Otherwise the eval key would
    // silently switch the agent provider and we'd benchmark Cerebras
    // grading itself instead of Anthropic-vs-Cerebras.
    if (def.name === "cerebras" && !preferredProvider) {
      const explicitProvider = process.env.MILADY_PROVIDER?.trim().toLowerCase();
      const explicitBaseUrl = process.env.OPENAI_BASE_URL?.trim();
      const baseUrlIsCerebras =
        !!explicitBaseUrl && /cerebras\.ai(?:\/|$)/i.test(explicitBaseUrl);
      if (explicitProvider !== "cerebras" && !baseUrlIsCerebras) {
        continue;
      }
    }

    const baseUrl = getLiveTestBaseUrlOverride(def.name) ?? def.defaultBaseUrl;

    const smallModel =
      getLiveTestModelOverride("small") ?? def.defaultSmallModel;
    const largeModel =
      getLiveTestModelOverride("large") ?? def.defaultLargeModel;

    const env: Record<string, string> = {};
    // Propagate the discovered key under every canonical name so plugin code
    // reading e.g. `GROQ_API_KEY` finds it even when the source env only had
    // the scoped alias `ELIZA_E2E_GROQ_API_KEY`.
    for (const envVar of def.keyEnvVars) {
      env[envVar] = apiKey;
    }
    if (def.baseUrlEnvVar) {
      env[def.baseUrlEnvVar] = baseUrl;
    }
    if (def.name === "cerebras") {
      env.MILADY_PROVIDER = "cerebras";
      env.OPENAI_API_KEY = apiKey;
      env.OPENAI_MEDIUM_MODEL = largeModel;
      env.OPENAI_ACTION_PLANNER_MODEL = largeModel;
      env.OPENAI_PLANNER_MODEL = largeModel;
      env.MEDIUM_MODEL = largeModel;
      env.ACTION_PLANNER_MODEL = largeModel;
      env.PLANNER_MODEL = largeModel;
    }
    env[def.smallModelEnvVar] = smallModel;
    env[def.largeModelEnvVar] = largeModel;
    env.SMALL_MODEL = smallModel;
    env.LARGE_MODEL = largeModel;

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

  return null;
}

/**
 * Select a live provider. If none is available, register a skipped test and
 * return null so callers can branch explicitly.
 */
export function requireLiveProvider(
  preferredProvider?: LiveProviderName,
): LiveProviderConfig | null {
  const provider = selectLiveProvider(preferredProvider);
  if (!provider) {
    test.skip("No LLM provider API key available");
    return null;
  }
  return provider;
}

/**
 * Check if ELIZA_LIVE_TEST is enabled.
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
      providerKeyEnvCandidates(def).some((key) => {
        const value = getTrimmedEnv(key);
        return value ? providerKeyMatchesSelection(def.name, value) : false;
      }),
    ).map((def) => def.name),
  );
  return [...providers];
}

export function buildIsolatedLiveProviderEnv(
  baseEnv: NodeJS.ProcessEnv,
  provider: Pick<LiveProviderConfig, "env"> | null | undefined,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of LIVE_PROVIDER_ENV_KEYS) {
    nextEnv[key] = "";
  }

  if (provider?.env) {
    for (const [key, value] of Object.entries(provider.env)) {
      nextEnv[key] = value;
    }
  }

  nextEnv.ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS = "1";

  return nextEnv;
}

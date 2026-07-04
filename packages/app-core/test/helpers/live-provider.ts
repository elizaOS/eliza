/** Selects a live LLM provider for integration tests from env and local config. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_CEREBRAS_TEXT_MODEL } from "@elizaos/core";
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

const VAULT_REF_PREFIX = "vault://";

function isVaultRef(value: string): boolean {
  return (
    value.startsWith(VAULT_REF_PREFIX) && value.length > VAULT_REF_PREFIX.length
  );
}

function resolveLiveProviderStateDir(): string {
  const explicit = process.env.ELIZA_LIVE_PROVIDER_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);

  const stateDir = process.env.ELIZA_STATE_DIR?.trim();
  if (stateDir) return path.resolve(stateDir);

  const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
  const xdgState = process.env.XDG_STATE_HOME?.trim();
  return xdgState
    ? path.join(xdgState, namespace)
    : path.join(homedir(), ".local", "state", namespace);
}

function resolveLiveProviderConfigPath(): string {
  const explicit = process.env.ELIZA_LIVE_PROVIDER_CONFIG_PATH?.trim();
  return explicit
    ? path.resolve(explicit)
    : path.join(resolveLiveProviderStateDir(), "eliza.json");
}

function readLocalConfigEnvValue(envVar: string): {
  value: string;
  stateDir: string;
} | null {
  const configPath = resolveLiveProviderConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      env?: Record<string, unknown> & {
        vars?: Record<string, unknown>;
      };
    };
    const value = config.env?.vars?.[envVar] ?? config.env?.[envVar];
    if (typeof value !== "string" || !value.trim()) return null;
    return {
      value: value.trim(),
      stateDir: path.dirname(configPath),
    };
  } catch {
    return null;
  }
}

async function resolveMaybeVaultRef(
  value: string,
  opts: { stateDir?: string } = {},
): Promise<string | null> {
  if (!isVaultRef(value)) return value.trim() || null;

  const vaultKey = value.slice(VAULT_REF_PREFIX.length);

  let vault: {
    get(key: string): Promise<string>;
    close?: () => Promise<void>;
  } | null = null;
  try {
    const { createVault } = await import("@elizaos/vault");
    vault = createVault(opts.stateDir ? { workDir: opts.stateDir } : {}) as {
      get(key: string): Promise<string>;
      close?: () => Promise<void>;
    };
    const resolved = await vault.get(vaultKey);
    return resolved.trim() || null;
  } catch {
    return null;
  } finally {
    if (vault?.close) {
      await vault.close().catch(() => {});
    }
  }
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
  return getTrimmedEnv(
    kind === "small"
      ? "ELIZA_LIVE_TEST_SMALL_MODEL"
      : "ELIZA_LIVE_TEST_LARGE_MODEL",
  );
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
  | "local-llama-cpp"
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

export function getFirstRunProviderForLiveProvider(
  provider: Pick<LiveProviderConfig, "name">,
): string {
  if (provider.name === "local-llama-cpp") {
    return "openai";
  }
  if (provider.name === "google") {
    return "gemini";
  }
  return provider.name;
}

export const LIVE_PROVIDER_ENV_KEYS = new Set<string>([
  "ELIZA_PROVIDER",
  "SMALL_MODEL",
  "MEDIUM_MODEL",
  "LARGE_MODEL",
  "ACTION_PLANNER_MODEL",
  "PLANNER_MODEL",
  "OPENAI_MEDIUM_MODEL",
  "OPENAI_ACTION_PLANNER_MODEL",
  "OPENAI_PLANNER_MODEL",
  "CEREBRAS_BASE_URL",
  "CEREBRAS_MODEL",
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
    defaultSmallModel: DEFAULT_CEREBRAS_TEXT_MODEL,
    defaultLargeModel: DEFAULT_CEREBRAS_TEXT_MODEL,
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
    // Keep the dev smoke on a current text model. OpenRouter removed the old
    // gemini-2.0-flash-001 route, which made live onboarding fail before app
    // plumbing was exercised.
    defaultSmallModel: "google/gemini-2.5-flash-lite",
    defaultLargeModel: "google/gemini-2.5-flash-lite",
  },
  {
    // Local OpenAI-compatible server (mtp llama-server fork or Ollama).
    // The mtp fork at ~/.cache/eliza-mtp/eliza-llama-cpp is preferred
    // when present; otherwise ELIZA_OPENCODE_BASE_URL points at Ollama
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
    defaultSmallModel: "eliza-1-2b",
    defaultLargeModel: "eliza-1-2b",
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

async function resolveProviderApiKey(def: {
  name: LiveProviderName;
  keyEnvVars: string[];
  keyEnvVarAliases?: string[];
}): Promise<string> {
  for (const envVar of providerKeyEnvCandidates(def)) {
    const val = getTrimmedEnv(envVar);
    if (!val) continue;
    const resolved = await resolveMaybeVaultRef(val);
    if (resolved && providerKeyMatchesSelection(def.name, resolved)) {
      return resolved;
    }
  }

  for (const envVar of def.keyEnvVars) {
    const persisted = readLocalConfigEnvValue(envVar);
    if (!persisted) continue;
    const resolved = await resolveMaybeVaultRef(persisted.value, {
      stateDir: persisted.stateDir,
    });
    if (resolved && providerKeyMatchesSelection(def.name, resolved)) {
      return resolved;
    }
  }

  return "";
}

function buildLiveProviderConfig(
  def: (typeof PROVIDERS)[number],
  apiKey: string,
): LiveProviderConfig {
  const baseUrl = getLiveTestBaseUrlOverride(def.name) ?? def.defaultBaseUrl;

  const smallModel = getLiveTestModelOverride("small") ?? def.defaultSmallModel;
  const largeModel = getLiveTestModelOverride("large") ?? def.defaultLargeModel;

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
    env.ELIZA_PROVIDER = "cerebras";
    env.CEREBRAS_BASE_URL = baseUrl;
    env.CEREBRAS_MODEL = largeModel;
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

/**
 * Select the first available LLM provider based on environment variables.
 * Returns null if no provider API keys are found.
 *
 * Preference order: cerebras -> groq -> openai -> anthropic -> google -> openrouter.
 */
// ---------------------------------------------------------------------------
// CLI-subscription provider (@elizaos/plugin-cli-inference)
//
// A subscription-only host (Claude Max / ChatGPT-Codex, no API key) serves live
// inference by spawning the sanctioned local CLI: ELIZA_CHAT_VIA_CLI selects the
// backend and the CLI reads its own on-disk credentials — eliza never sees the
// token, so there is no real apiKey. Mirrors core's selectCliProvider
// (packages/core/src/testing/live-provider.ts). Selected FIRST when
// ELIZA_CHAT_VIA_CLI names a supported backend: setting it is an explicit opt-in
// to the subscription route, so it wins over an ambient API key. Existing CI
// never sets ELIZA_CHAT_VIA_CLI, so this path is inert there.
// ---------------------------------------------------------------------------

const CLI_BACKENDS = ["claude", "claude-sdk", "codex", "codex-sdk"] as const;
type CliBackend = (typeof CLI_BACKENDS)[number];

const CLI_SUBSCRIPTION_SENTINEL_API_KEY =
  "cli-subscription:no-api-key-cli-reads-own-credentials";

const CLI_PASSTHROUGH_ENV_VARS = [
  "ELIZA_PLANNER_NATIVE_TOOLS",
  "ELIZA_CLI_CLAUDE_MODEL",
  "ELIZA_CLI_CLAUDE_PLANNER_MODEL",
  "ELIZA_CLI_CLAUDE_BIN",
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

function cliBackendCredentialsPath(backend: CliBackend): string {
  return backend.startsWith("codex")
    ? path.join(homedir(), ".codex", "auth.json")
    : path.join(homedir(), ".claude", ".credentials.json");
}

function selectCliProvider(): LiveProviderConfig | null {
  const backend = resolveConfiguredCliBackend();
  if (!backend) return null;
  if (!existsSync(cliBackendCredentialsPath(backend))) return null;

  const isCodex = backend.startsWith("codex");
  const model = isCodex
    ? getTrimmedEnv("ELIZA_CLI_CODEX_MODEL") || "gpt-5.5"
    : getTrimmedEnv("ELIZA_CLI_CLAUDE_MODEL") || "claude-opus-4-7";

  const env: Record<string, string> = { ELIZA_CHAT_VIA_CLI: backend };
  for (const envVar of CLI_PASSTHROUGH_ENV_VARS) {
    const val = getTrimmedEnv(envVar);
    if (val) env[envVar] = val;
  }

  return {
    name: "cli",
    apiKey: CLI_SUBSCRIPTION_SENTINEL_API_KEY,
    baseUrl: `cli://${backend}`,
    // plugin-cli-inference registers large-tier handlers only; both tiers map to
    // the same subscription-served model.
    smallModel: model,
    largeModel: model,
    pluginPackage: "@elizaos/plugin-cli-inference",
    env,
  };
}

export function selectLiveProvider(
  preferredProvider?: LiveProviderName,
): LiveProviderConfig | null {
  if (!preferredProvider || preferredProvider === "cli") {
    const cli = selectCliProvider();
    if (cli) return cli;
    if (preferredProvider === "cli") return null;
  }

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
    // Cerebras when the operator explicitly says so via ELIZA_PROVIDER or
    // an explicit cerebras OPENAI_BASE_URL. Otherwise the eval key would
    // silently switch the agent provider and we'd benchmark Cerebras
    // grading itself instead of Anthropic-vs-Cerebras.
    if (def.name === "cerebras" && !preferredProvider) {
      const explicitProvider = process.env.ELIZA_PROVIDER?.trim().toLowerCase();
      const explicitBaseUrl = process.env.OPENAI_BASE_URL?.trim();
      const baseUrlIsCerebras =
        !!explicitBaseUrl && /cerebras\.ai(?:\/|$)/i.test(explicitBaseUrl);
      if (explicitProvider !== "cerebras" && !baseUrlIsCerebras) {
        continue;
      }
    }

    return buildLiveProviderConfig(def, apiKey);
  }

  return null;
}

/**
 * Async selector for live harnesses that should also accept `vault://KEY`
 * sentinels and keys persisted in the local Eliza config. The synchronous
 * `selectLiveProvider()` intentionally remains env-only for older test code.
 */
export async function selectLiveProviderAsync(
  preferredProvider?: LiveProviderName,
): Promise<LiveProviderConfig | null> {
  if (!preferredProvider || preferredProvider === "cli") {
    const cli = selectCliProvider();
    if (cli) return cli;
    if (preferredProvider === "cli") return null;
  }

  const candidates = preferredProvider
    ? PROVIDERS.filter((p) => p.name === preferredProvider)
    : PROVIDERS;

  for (const def of candidates) {
    const apiKey = await resolveProviderApiKey(def);
    if (!apiKey) continue;

    if (def.name === "cerebras" && !preferredProvider) {
      const explicitProvider = process.env.ELIZA_PROVIDER?.trim().toLowerCase();
      const explicitBaseUrl = process.env.OPENAI_BASE_URL?.trim();
      const baseUrlIsCerebras =
        !!explicitBaseUrl && /cerebras\.ai(?:\/|$)/i.test(explicitBaseUrl);
      if (explicitProvider !== "cerebras" && !baseUrlIsCerebras) {
        continue;
      }
    }

    return buildLiveProviderConfig(def, apiKey);
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

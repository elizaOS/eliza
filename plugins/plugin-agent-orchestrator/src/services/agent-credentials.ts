import type { IAgentRuntime } from "@elizaos/core";
import type { AgentCredentials } from "coding-agent-adapters";
import { readConfigCloudKey, readConfigEnvKey } from "./config-env.js";

const ELIZA_CLOUD_ANTHROPIC_BASE = "https://www.elizacloud.ai/api";
const ELIZA_CLOUD_OPENAI_BASE = "https://www.elizacloud.ai/api/v1";

const OPENCODE_LOCAL_DEFAULT_BASE_URL = "http://localhost:11434/v1";
const OPENCODE_OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

/**
 * Standard provider env-var → OpenAI-compatible endpoint mapping. Used to
 * auto-derive a working OpenCode config when the user has set a normal
 * provider API key (the same env var they'd use for direct API access)
 * but hasn't set any `PARALLAX_OPENCODE_*` variables.
 *
 * Order is priority: the first env-var with a non-empty value wins. Order
 * is provider-quality + clarity (OpenRouter first because it's the
 * "any-model" provider; Cerebras second because it's the fastest
 * inference; etc.). The OpenAI fallback runs last so a user who has
 * `OPENAI_API_KEY` set as a generic secret doesn't accidentally route to
 * openai.com when they actually meant a different provider.
 *
 * The `defaultModel` is a non-reasoning, fast, generally-available model
 * for each provider so opencode sessions just work without per-model
 * tuning. Users can override via `PARALLAX_OPENCODE_MODEL_POWERFUL` (which
 * takes precedence over this default).
 */
interface OpencodeProviderEnvMapping {
  envKey: string;
  providerId: string;
  providerLabel: string;
  baseURL: string;
  defaultModel: string;
}

const OPENCODE_PROVIDER_ENV_MAPPINGS: readonly OpencodeProviderEnvMapping[] = [
  {
    envKey: "OPENROUTER_API_KEY",
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "meta-llama/llama-3.3-70b-instruct",
  },
  {
    envKey: "CEREBRAS_API_KEY",
    providerId: "cerebras",
    providerLabel: "Cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    defaultModel: "llama-3.3-70b",
  },
  {
    envKey: "GROQ_API_KEY",
    providerId: "groq",
    providerLabel: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
  },
  {
    envKey: "TOGETHER_API_KEY",
    providerId: "together",
    providerLabel: "Together AI",
    baseURL: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  {
    envKey: "DEEPSEEK_API_KEY",
    providerId: "deepseek",
    providerLabel: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
  },
] as const;

/**
 * Inspect the runtime for a recognized provider env var and synthesize
 * an OpenCode config for it. Returns null when no provider is detected.
 *
 * Resolution order:
 *   1. Each provider in `OPENCODE_PROVIDER_ENV_MAPPINGS` (first match wins).
 *   2. Generic `OPENAI_API_KEY` + custom `OPENAI_BASE_URL` (third-party
 *      OpenAI-compatible endpoint like a private deployment).
 *   3. Generic `OPENAI_API_KEY` alone → openai.com direct.
 *
 * Step 2/3 are last so users with multiple keys set get their explicit
 * provider preference (cerebras > openai-as-fallback).
 */
function detectOpencodeProviderFromEnv(
  runtime: IAgentRuntime,
): (OpencodeProviderEnvMapping & { apiKey: string }) | null {
  const settingOrEnv = (key: string): string | undefined => {
    const fromSetting = runtime.getSetting(key);
    if (typeof fromSetting === "string" && fromSetting.trim()) {
      return fromSetting.trim();
    }
    const fromEnv = readConfigEnvKey(key);
    if (fromEnv?.trim()) return fromEnv.trim();
    return undefined;
  };

  for (const mapping of OPENCODE_PROVIDER_ENV_MAPPINGS) {
    const apiKey = settingOrEnv(mapping.envKey);
    if (apiKey) return { ...mapping, apiKey };
  }

  const openaiKey = settingOrEnv("OPENAI_API_KEY");
  if (openaiKey) {
    const customBase = settingOrEnv("OPENAI_BASE_URL");
    if (customBase) {
      try {
        const hostname = new URL(customBase).hostname.toLowerCase();
        const isOpenAIDirect = hostname === "api.openai.com";
        if (!isOpenAIDirect) {
          return {
            envKey: "OPENAI_API_KEY",
            providerId: "openai-compatible",
            providerLabel: `OpenAI-compatible (${hostname})`,
            baseURL: customBase,
            defaultModel: settingOrEnv("OPENAI_LARGE_MODEL") ?? "gpt-4o-mini",
            apiKey: openaiKey,
          };
        }
      } catch {
        // Malformed URL — fall through to openai-direct.
      }
    }
    return {
      envKey: "OPENAI_API_KEY",
      providerId: "openai",
      providerLabel: "OpenAI",
      baseURL: "https://api.openai.com/v1",
      defaultModel: settingOrEnv("OPENAI_LARGE_MODEL") ?? "gpt-4o-mini",
      apiKey: openaiKey,
    };
  }

  return null;
}

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

export interface OpencodeSpawnConfig {
  configContent: string;
  providerLabel: string;
  providerId: string;
  model: string;
  smallModel?: string;
}

/**
 * Build the per-spawn OpenCode config (fed via OPENCODE_CONFIG_CONTENT).
 * Resolution order (first match wins):
 *   1. Cloud: PARALLAX_LLM_PROVIDER=cloud + paired Eliza Cloud key.
 *   2. Local: PARALLAX_OPENCODE_LOCAL=1 (and/or PARALLAX_OPENCODE_BASE_URL).
 *   3. User-config: PARALLAX_OPENCODE_MODEL_POWERFUL alone — defers to
 *      whatever providers the user has in ~/.config/opencode/opencode.json.
 *   4. **Auto-detect**: a recognized provider env var (CEREBRAS_API_KEY,
 *      OPENROUTER_API_KEY, GROQ_API_KEY, TOGETHER_API_KEY, DEEPSEEK_API_KEY,
 *      or OPENAI_API_KEY[+OPENAI_BASE_URL]) — the user's normal API-key env
 *      becomes a fully working opencode config, no `PARALLAX_OPENCODE_*`
 *      vars required. This is the "BYO key on any device" path.
 * Returns null when no mode produces a usable config (no key, no local
 * server, no user-configured opencode model).
 */
export function buildOpencodeSpawnConfig(
  runtime: IAgentRuntime,
): OpencodeSpawnConfig | null {
  const llmProvider =
    readConfigEnvKey("PARALLAX_LLM_PROVIDER") || "subscription";
  const customBaseUrl = readConfigEnvKey("PARALLAX_OPENCODE_BASE_URL");
  const localOptIn =
    readConfigEnvKey("PARALLAX_OPENCODE_LOCAL") === "1" ||
    readConfigEnvKey("PARALLAX_OPENCODE_LOCAL")?.toLowerCase() === "true";
  const userPowerful =
    (runtime.getSetting("PARALLAX_OPENCODE_MODEL_POWERFUL") as
      | string
      | undefined) || readConfigEnvKey("PARALLAX_OPENCODE_MODEL_POWERFUL");
  const userFast =
    (runtime.getSetting("PARALLAX_OPENCODE_MODEL_FAST") as
      | string
      | undefined) || readConfigEnvKey("PARALLAX_OPENCODE_MODEL_FAST");

  if (llmProvider === "cloud") {
    const cloudKey = readConfigCloudKey("apiKey");
    if (!cloudKey) return null;
    const providerId = "elizacloud";
    const powerful = userPowerful?.trim() || "claude-opus-4-7";
    const fast = userFast?.trim() || "claude-haiku-4-5";
    const config = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [providerId]: {
          npm: OPENCODE_OPENAI_COMPATIBLE_NPM,
          name: "Eliza Cloud",
          options: { baseURL: ELIZA_CLOUD_OPENAI_BASE, apiKey: cloudKey },
          models: {
            [powerful]: { name: powerful },
            ...(fast && fast !== powerful ? { [fast]: { name: fast } } : {}),
          },
        },
      },
      model: `${providerId}/${powerful}`,
      ...(fast && fast !== powerful
        ? { small_model: `${providerId}/${fast}` }
        : {}),
    };
    return {
      configContent: JSON.stringify(config),
      providerLabel: "Eliza Cloud",
      providerId,
      model: `${providerId}/${powerful}`,
      smallModel:
        fast && fast !== powerful ? `${providerId}/${fast}` : undefined,
    };
  }

  if (localOptIn || customBaseUrl?.trim()) {
    const baseURL = customBaseUrl?.trim() || OPENCODE_LOCAL_DEFAULT_BASE_URL;
    const apiKey = readConfigEnvKey("PARALLAX_OPENCODE_API_KEY");
    const providerId = "eliza-local";
    const powerful = userPowerful?.trim() || "eliza-1-9b";
    const fast = userFast?.trim();
    const config = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [providerId]: {
          npm: OPENCODE_OPENAI_COMPATIBLE_NPM,
          name: "Local model",
          options: { baseURL, ...(apiKey ? { apiKey } : {}) },
          models: {
            [powerful]: { name: powerful },
            ...(fast && fast !== powerful ? { [fast]: { name: fast } } : {}),
          },
        },
      },
      model: `${providerId}/${powerful}`,
      ...(fast && fast !== powerful
        ? { small_model: `${providerId}/${fast}` }
        : {}),
    };
    return {
      configContent: JSON.stringify(config),
      providerLabel: `Local (${baseURL})`,
      providerId,
      model: `${providerId}/${powerful}`,
      smallModel:
        fast && fast !== powerful ? `${providerId}/${fast}` : undefined,
    };
  }

  if (userPowerful?.trim()) {
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      model: userPowerful.trim(),
      ...(userFast?.trim() ? { small_model: userFast.trim() } : {}),
    };
    return {
      configContent: JSON.stringify(config),
      providerLabel: "User-configured opencode.json",
      providerId: "user",
      model: userPowerful.trim(),
      smallModel: userFast?.trim() || undefined,
    };
  }

  // Mode 4: auto-detect from a standard provider env var. This is the
  // "BYO API key" path — users only need their normal CEREBRAS_API_KEY /
  // OPENROUTER_API_KEY / etc. and opencode just works.
  const detected = detectOpencodeProviderFromEnv(runtime);
  if (!detected) return null;
  const powerful = userPowerful?.trim() || detected.defaultModel;
  const fast = userFast?.trim();
  const autoConfig = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [detected.providerId]: {
        npm: OPENCODE_OPENAI_COMPATIBLE_NPM,
        name: detected.providerLabel,
        options: { baseURL: detected.baseURL, apiKey: detected.apiKey },
        models: {
          [powerful]: { name: powerful },
          ...(fast && fast !== powerful ? { [fast]: { name: fast } } : {}),
        },
      },
    },
    model: `${detected.providerId}/${powerful}`,
    ...(fast && fast !== powerful
      ? { small_model: `${detected.providerId}/${fast}` }
      : {}),
  };
  return {
    configContent: JSON.stringify(autoConfig),
    providerLabel: `${detected.providerLabel} (auto-detected from ${detected.envKey})`,
    providerId: detected.providerId,
    model: `${detected.providerId}/${powerful}`,
    smallModel:
      fast && fast !== powerful ? `${detected.providerId}/${fast}` : undefined,
  };
}

import type { IAgentRuntime } from "@elizaos/core";
import type { AgentCredentials } from "coding-agent-adapters";
import { readConfigCloudKey, readConfigEnvKey } from "./config-env.js";

const ELIZA_CLOUD_ANTHROPIC_BASE = "https://www.elizacloud.ai/api";
const ELIZA_CLOUD_OPENAI_BASE = "https://www.elizacloud.ai/api/v1";

const OPENCODE_LOCAL_DEFAULT_BASE_URL = "http://localhost:11434/v1";
const OPENCODE_OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

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
 * Three modes — verified live against an OpenAI-compatible Eliza-1 endpoint:
 *   1. Cloud: PARALLAX_LLM_PROVIDER=cloud + paired Eliza Cloud key.
 *   2. Local: PARALLAX_OPENCODE_LOCAL=1 (and/or PARALLAX_OPENCODE_BASE_URL).
 *   3. User-config: PARALLAX_OPENCODE_MODEL_POWERFUL alone — defers to
 *      whatever providers the user has in ~/.config/opencode/opencode.json.
 * Returns null when no mode can produce a usable config.
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

  if (!userPowerful?.trim()) return null;
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

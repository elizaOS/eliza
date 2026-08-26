/**
 * Derives the human-facing model/provider label the API surface reports for a
 * runtime. detectRuntimeModel resolves in priority order: the character/settings
 * model, the configured service-routing transport (direct / remote /
 * cloud-proxy — but only when the cloud plugin actually registered its
 * chat-brain handler, so a cloud-proxy config without a signed-in account
 * falls through to the local-provider / plugin-name / env-signal path that
 * reflects the handler really serving requests, #20045), the config default
 * model, a loaded provider plugin name, then an env provider signal (API-key
 * or base-URL presence, including ELIZA_LOCAL_LLAMA on AOSP).
 * resolveProviderFromModel maps a model string to a provider display name.
 */

import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import {
  DEFAULT_CEREBRAS_TEXT_MODEL,
  normalizeFirstRunProviderId,
  resolveDeploymentTargetInConfig,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";

/**
 * The provider name the elizacloud plugin registers its chat-brain handlers
 * under (`elizaOSCloudPlugin.name` in plugins/plugin-elizacloud/src/index.ts).
 * Used by {@link hasCloudTextHandlerRegistered} to verify the configured
 * cloud-proxy route actually has a registered handler before reporting
 * "elizacloud" as the active model — when the user is not signed in, the
 * plugin skips handler registration (ELIZAOS_CLOUD_USE_INFERENCE=false) and
 * the runtime silently falls through to local inference, so reporting
 * "elizacloud" from config alone is dishonest. See elizaOS/eliza#20045.
 */
const ELIZA_CLOUD_PROVIDER_NAME = "elizaOSCloud";

/**
 * The provider that served the most recent successful chat `useModel` call, or
 * undefined before any call has completed. This is evidence rather than
 * availability: a registered handler can still lose to an override or fail
 * over to another provider, so when core knows who actually answered, that
 * wins over every config- and registration-derived guess below.
 *
 * Fails closed to undefined — callers fall through to the configured route
 * rather than fabricating a provider.
 */
export function lastServingTextProvider(
  runtime: AgentRuntime,
): string | undefined {
  try {
    return (
      runtime.getLastResolvedModelProvider?.(ModelType.TEXT_LARGE) ??
      runtime.getLastResolvedModelProvider?.(ModelType.TEXT_SMALL)
    );
  } catch {
    // error-policy:J7 diagnostics must not kill the model-label resolver
    return undefined;
  }
}

/**
 * True when a chat-brain text handler is registered under the elizacloud
 * provider name. `detectRuntimeModel` uses this to decide whether the
 * `cloud-proxy` config branch should report `elizacloud` or fall through to
 * the local-provider / plugin-name / env-signal path that reflects the
 * handler actually serving requests.
 */
export function hasCloudTextHandlerRegistered(runtime: AgentRuntime): boolean {
  try {
    const registrations = runtime.getModelRegistrations?.() ?? [];
    return registrations.some(
      (entry) =>
        entry.modelType === ModelType.TEXT_SMALL &&
        entry.provider === ELIZA_CLOUD_PROVIDER_NAME,
    );
  } catch {
    // error-policy:J7 diagnostics must not kill the model-label resolver
    return false;
  }
}

const MODEL_PLACEHOLDERS = new Set(["", "n/a", "na", "unknown", "provided"]);

const PROVIDER_HINTS = [
  "openai-codex",
  "openai-subscription",
  "anthropic-subscription",
  "gemini-subscription",
  "gemini-cli",
  "zai-coding-subscription",
  "zai-coding",
  "kimi-coding-subscription",
  "kimi-coding",
  "deepseek-coding-subscription",
  "deepseek-coding",
  "openrouter",
  "moonshot",
  "kimi",
  "deepseek",
  "anthropic",
  "openai",
  "groq",
  "gemini",
  "google",
  "grok",
  "xai",
  "ollama",
  "mistral",
  "together",
  "nearai",
  "zai",
] as const;

const ENV_PROVIDER_SIGNALS: ReadonlyArray<{
  envVar: string;
  label: string;
}> = [
  { envVar: "ANTHROPIC_API_KEY", label: "anthropic" },
  { envVar: "OPENAI_API_KEY", label: "openai" },
  { envVar: "OPENROUTER_API_KEY", label: "openrouter" },
  { envVar: "GROQ_API_KEY", label: "groq" },
  { envVar: "GOOGLE_GENERATIVE_AI_API_KEY", label: "gemini" },
  { envVar: "XAI_API_KEY", label: "grok" },
  { envVar: "DEEPSEEK_API_KEY", label: "deepseek" },
  { envVar: "MISTRAL_API_KEY", label: "mistral" },
  { envVar: "TOGETHER_API_KEY", label: "together" },
  { envVar: "NEARAI_API_KEY", label: "nearai" },
  { envVar: "ZAI_API_KEY", label: "zai" },
  { envVar: "MOONSHOT_API_KEY", label: "moonshot" },
  { envVar: "OLLAMA_BASE_URL", label: "ollama" },
  // The native-inference plugin sets ELIZA_LOCAL_LLAMA=1 when it
  // registers the bundled llama.cpp model handlers at agent boot.
  // Without this signal `detectRuntimeModel` returns undefined on AOSP
  // installs, the API surface reports no `model` field, and the React
  // shell's chat composer locks behind "Setup Provider To Chat" even
  // though llama is loaded and ready.
  { envVar: "ELIZA_LOCAL_LLAMA", label: "aosp-local-llama" },
];

function normalizeModelSpec(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (MODEL_PLACEHOLDERS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

function readRuntimeSetting(runtime: AgentRuntime, key: string): unknown {
  const getSetting = (
    runtime as AgentRuntime & {
      getSetting?: (settingKey: string) => unknown;
    }
  ).getSetting;
  if (typeof getSetting !== "function") return undefined;
  try {
    return getSetting.call(runtime, key);
  } catch {
    return undefined;
  }
}

function readCharacterModel(runtime: AgentRuntime): string | undefined {
  const character = (runtime as { character?: unknown }).character;
  if (!character || typeof character !== "object") return undefined;

  const modelValue = (character as { model?: unknown }).model;
  const fromCharacterModel = normalizeModelSpec(modelValue);
  if (fromCharacterModel) return fromCharacterModel;

  const settings = (character as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object") return undefined;

  const model = (settings as { model?: unknown }).model;
  const fromSettingsModel = normalizeModelSpec(model);
  if (fromSettingsModel) return fromSettingsModel;

  if (!model || typeof model !== "object") return undefined;
  const modelObj = model as {
    primary?: unknown;
    large?: unknown;
    small?: unknown;
  };

  return (
    normalizeModelSpec(modelObj.primary) ??
    normalizeModelSpec(modelObj.large) ??
    normalizeModelSpec(modelObj.small)
  );
}

export function detectRuntimeModel(
  runtime: AgentRuntime | null,
  config?: Pick<ElizaConfig, "deploymentTarget" | "serviceRouting" | "agents">,
): string | undefined {
  if (!runtime) return undefined;

  const routing = resolveServiceRoutingInConfig(
    (config ?? null) as Record<string, unknown> | null,
  );
  const llmText = routing?.llmText;
  const backend = normalizeFirstRunProviderId(llmText?.backend);

  // Who actually answered beats who was configured to. A character `model`
  // pin is a request, not a receipt: with a cloud-proxy route and no live
  // Cloud account the runtime falls through to another provider, and
  // reporting the pin made /api/status claim "elizacloud" while local
  // inference served every turn (elizaOS/eliza#20045 review).
  const serving = lastServingTextProvider(runtime);
  if (serving) {
    const explicitProvider = normalizeModelSpec(
      readRuntimeSetting(runtime, "ELIZA_PROVIDER"),
    );
    const cerebrasRoute =
      (llmText?.transport === "direct" && backend === "cerebras") ||
      explicitProvider?.toLowerCase() === "cerebras";
    if (serving.toLowerCase() === "openai" && cerebrasRoute) {
      return (
        normalizeModelSpec(readRuntimeSetting(runtime, "OPENAI_LARGE_MODEL")) ??
        normalizeModelSpec(
          readRuntimeSetting(runtime, "CEREBRAS_LARGE_MODEL"),
        ) ??
        normalizeModelSpec(readRuntimeSetting(runtime, "CEREBRAS_MODEL")) ??
        normalizeModelSpec(llmText?.primaryModel) ??
        DEFAULT_CEREBRAS_TEXT_MODEL
      );
    }
    return serving;
  }

  const configured = readCharacterModel(runtime);
  if (configured) return configured;

  const deploymentTarget = resolveDeploymentTargetInConfig(
    (config ?? null) as Record<string, unknown> | null,
  );
  if (llmText?.transport === "direct") {
    const provider = backend && backend !== "elizacloud" ? backend : undefined;
    return llmText.primaryModel ?? provider;
  }

  if (llmText?.transport === "remote") {
    const provider = backend && backend !== "elizacloud" ? backend : undefined;
    return (
      llmText.primaryModel ??
      provider ??
      llmText.remoteApiBase ??
      deploymentTarget.remoteApiBase
    );
  }

  // Only report `elizacloud` from the cloud-proxy route when the cloud
  // plugin actually registered its chat-brain handler. When the user is not
  // signed in (no ELIZAOS_CLOUD_API_KEY), the host sets
  // ELIZAOS_CLOUD_USE_INFERENCE=false and the plugin skips handler
  // registration, so the runtime falls through to local inference. Reporting
  // "elizacloud" from config alone hides that fallback and leaves /api/status
  // disagreeing with the handler actually serving requests (#20045).
  if (
    llmText?.transport === "cloud-proxy" &&
    backend === "elizacloud" &&
    hasCloudTextHandlerRegistered(runtime)
  ) {
    return (
      llmText.responseModel ??
      llmText.largeModel ??
      llmText.megaModel ??
      llmText.mediumModel ??
      llmText.smallModel ??
      llmText.nanoModel ??
      backend
    );
  }

  const configModel = normalizeModelSpec(
    config?.agents?.defaults?.model?.primary,
  );
  if (configModel) return configModel;

  const pluginNames = Array.isArray(runtime.plugins)
    ? runtime.plugins
        .map((plugin) =>
          typeof plugin.name === "string" ? plugin.name.trim() : "",
        )
        .filter((name): name is string => name.length > 0)
    : [];

  if (pluginNames.length > 0) {
    const lowerPluginNames = pluginNames.map((name) => name.toLowerCase());
    for (const hint of PROVIDER_HINTS) {
      const index = lowerPluginNames.findIndex((name) => name.includes(hint));
      if (index >= 0) return pluginNames[index];
    }
  }

  for (const { envVar, label } of ENV_PROVIDER_SIGNALS) {
    const value = process.env[envVar]?.trim();
    if (value && value.length > 0) return label;
  }

  return undefined;
}

export function resolveProviderFromModel(model: string): string | null {
  const lower = model.trim().toLowerCase();
  if (!lower) return null;

  const providers: Array<{ match: string; label: string }> = [
    { match: "elizacloud", label: "Eliza Cloud" },
    { match: "openrouter", label: "OpenRouter" },
    { match: "openai", label: "OpenAI" },
    { match: "anthropic", label: "Anthropic" },
    { match: "gemini", label: "Google" },
    { match: "google", label: "Google" },
    { match: "grok", label: "xAI" },
    { match: "xai", label: "xAI" },
    { match: "groq", label: "Groq" },
    { match: "ollama", label: "Ollama" },
    { match: "deepseek", label: "DeepSeek" },
    { match: "mistral", label: "Mistral" },
    { match: "together", label: "Together AI" },
    { match: "cohere", label: "Cohere" },
    { match: "moonshot", label: "Moonshot" },
    { match: "kimi", label: "Kimi" },
  ];
  for (const { match, label } of providers) {
    if (lower.includes(match)) return label;
  }

  if (lower.startsWith("gpt")) return "OpenAI";
  if (lower.startsWith("claude")) return "Anthropic";
  if (lower.startsWith("gemini")) return "Google";

  return null;
}

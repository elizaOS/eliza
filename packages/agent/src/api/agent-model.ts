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

const CHAT_TEXT_MODEL_TYPES = new Set<string>([
  ModelType.TEXT_LARGE,
  ModelType.TEXT_SMALL,
  ModelType.TEXT_MEDIUM,
  ModelType.TEXT_NANO,
  ModelType.TEXT_MEGA,
]);

/**
 * Return the provider behind a directly registered normal-chat text model.
 * Planner and response-handler delegates may themselves depend on TEXT_SMALL;
 * counting those wrappers made provider-less runtimes look ready.
 */
export function registeredChatTextProvider(
  runtime: AgentRuntime,
): string | undefined {
  if (typeof runtime.getModelRegistrations !== "function") return undefined;
  try {
    const registration = runtime
      .getModelRegistrations()
      .find(
        (entry) =>
          CHAT_TEXT_MODEL_TYPES.has(String(entry.modelType)) &&
          typeof entry.provider === "string" &&
          entry.provider.trim().length > 0,
      );
    return registration?.provider.trim() || undefined;
  } catch {
    return undefined;
  }
}

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
    const serving =
      runtime.getLastResolvedModelProvider?.(ModelType.TEXT_LARGE) ??
      runtime.getLastResolvedModelProvider?.(ModelType.TEXT_SMALL);
    return resolveCompatibleTextBackend(runtime, serving);
  } catch {
    // error-policy:J7 diagnostics must not kill the model-label resolver
    return undefined;
  }
}

function readRuntimeSetting(
  runtime: AgentRuntime,
  key: string,
): string | undefined {
  const runtimeValue = runtime.getSetting?.(key);
  if (typeof runtimeValue === "string" && runtimeValue.trim()) {
    return runtimeValue.trim();
  }
  const environmentValue = process.env[key]?.trim();
  return environmentValue || undefined;
}

/**
 * The OpenAI plugin is also the transport for compatible APIs. Core normally
 * records the concrete backend receipt, but legacy/string-only model results
 * can expose only the registration name. In that case, apply the same explicit
 * endpoint selection rules as the plugin so status names the service actually
 * handling requests instead of the transport implementation.
 */
function resolveCompatibleTextBackend(
  runtime: AgentRuntime,
  serving: string | undefined,
): string | undefined {
  if (serving?.toLowerCase() !== "openai") return serving;

  const explicitProvider = readRuntimeSetting(
    runtime,
    "ELIZA_PROVIDER",
  )?.toLowerCase();
  if (explicitProvider === "cerebras" || explicitProvider === "evolink") {
    return explicitProvider;
  }

  const baseUrl = readRuntimeSetting(runtime, "OPENAI_BASE_URL");
  if (baseUrl && /(^|\.)cerebras\.ai(\/|$)/i.test(baseUrl)) return "cerebras";
  if (baseUrl && /(^|\.)evolink\.ai(\/|$)/i.test(baseUrl)) return "evolink";

  const openAiKey = readRuntimeSetting(runtime, "OPENAI_API_KEY");
  if (!openAiKey && !baseUrl) {
    if (readRuntimeSetting(runtime, "CEREBRAS_API_KEY")) return "cerebras";
    if (readRuntimeSetting(runtime, "EVOLINK_API_KEY")) return "evolink";
  }
  return serving;
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

  // Who actually answered beats who was configured to. A character `model`
  // pin is a request, not a receipt: with a cloud-proxy route and no live
  // Cloud account the runtime falls through to another provider, and
  // reporting the pin made /api/status claim "elizacloud" while local
  // inference served every turn (elizaOS/eliza#20045 review).
  const serving = lastServingTextProvider(runtime);
  if (serving) return serving;

  const configured = readCharacterModel(runtime);
  if (configured) return configured;

  const routing = resolveServiceRoutingInConfig(
    (config ?? null) as Record<string, unknown> | null,
  );
  const deploymentTarget = resolveDeploymentTargetInConfig(
    (config ?? null) as Record<string, unknown> | null,
  );
  const llmText = routing?.llmText;
  const backend = normalizeFirstRunProviderId(llmText?.backend);

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

  const registeredProvider = registeredChatTextProvider(runtime);
  if (registeredProvider) {
    return resolveCompatibleTextBackend(runtime, registeredProvider);
  }

  const configModel = normalizeModelSpec(
    config?.agents?.defaults?.model?.primary,
  );
  if (configModel) return configModel;

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
    { match: "cerebras", label: "Cerebras" },
    { match: "evolink", label: "EvoLink" },
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

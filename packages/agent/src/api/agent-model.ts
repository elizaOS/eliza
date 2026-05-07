import type { AgentRuntime } from "@elizaos/core";
import {
  normalizeOnboardingProviderId,
  resolveDeploymentTargetInConfig,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.js";

const MODEL_PLACEHOLDERS = new Set(["", "n/a", "na", "unknown", "provided"]);

const PROVIDER_HINTS = [
  "openai-codex",
  "openai-subscription",
  "anthropic-subscription",
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
  { envVar: "ZAI_API_KEY", label: "zai" },
  { envVar: "MOONSHOT_API_KEY", label: "moonshot" },
  { envVar: "OLLAMA_BASE_URL", label: "ollama" },
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

  const configured = readCharacterModel(runtime);
  if (configured) return configured;

  const routing = resolveServiceRoutingInConfig(
    (config ?? null) as Record<string, unknown> | null,
  );
  const deploymentTarget = resolveDeploymentTargetInConfig(
    (config ?? null) as Record<string, unknown> | null,
  );
  const llmText = routing?.llmText;
  const backend = normalizeOnboardingProviderId(llmText?.backend);

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

  if (llmText?.transport === "cloud-proxy" && backend === "elizacloud") {
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
          typeof plugin?.name === "string" ? plugin.name.trim() : "",
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

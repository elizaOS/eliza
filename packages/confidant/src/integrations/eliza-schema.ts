import { defineSecretSchema } from "../secret-schema.js";
import { ELIZA_PROVIDER_SECRET_IDS } from "./eliza-providers.js";

/**
 * Registers the canonical schema for every elizaOS provider Confidant
 * knows about. Apps that adopt Confidant in their boot path call this
 * once instead of writing 14 individual `defineSecretSchema` calls.
 *
 * Each schema entry attributes ownership to the corresponding
 * `@elizaos/plugin-{providerId}` so the implicit-grant rule
 * (registering plugin gets always-access to its own ids) fires
 * automatically once those plugins migrate to Confidant reads.
 *
 * Plugins not yet in this set keep `process.env` access until they
 * register their own schemas; that's the migration path described in
 * §9.5 of the design doc.
 */
export function registerElizaProviderSchemas(): void {
  const entries: Record<
    string,
    {
      label: string;
      formatHint?: string;
      sensitive: boolean;
      pluginId: string;
    }
  > = {};
  for (const [providerId, secretId] of Object.entries(
    ELIZA_PROVIDER_SECRET_IDS,
  )) {
    entries[secretId] = {
      label: humanLabelFor(providerId),
      ...(formatHintFor(providerId)
        ? { formatHint: formatHintFor(providerId) as string }
        : {}),
      sensitive: true,
      pluginId: pluginIdFor(providerId),
    };
  }
  defineSecretSchema(entries);
}

function humanLabelFor(providerId: string): string {
  switch (providerId) {
    case "anthropic":
      return "Anthropic API Key";
    case "openai":
      return "OpenAI API Key";
    case "openrouter":
      return "OpenRouter API Key";
    case "google":
    case "google-genai":
      return "Google AI API Key";
    case "groq":
      return "Groq API Key";
    case "xai":
      return "xAI API Key";
    case "deepseek":
      return "DeepSeek API Key";
    case "mistral":
      return "Mistral API Key";
    case "together":
      return "Together AI API Key";
    case "zai":
      return "Z.AI API Key";
    case "elizacloud":
      return "Eliza Cloud API Key";
    case "ollama":
      return "Ollama API Key";
    case "anthropic-subscription":
      return "Claude Subscription Token";
    case "openai-codex":
      return "OpenAI (Codex) Subscription Token";
    default:
      return providerId;
  }
}

function formatHintFor(providerId: string): string | undefined {
  switch (providerId) {
    case "anthropic":
      return "sk-ant-...";
    case "openai":
    case "openai-codex":
      return "sk-...";
    case "openrouter":
      return "sk-or-v1-...";
    case "groq":
      return "gsk_...";
    case "xai":
      return "xai-...";
    default:
      return undefined;
  }
}

function pluginIdFor(providerId: string): string {
  if (providerId === "anthropic-subscription") {
    return "@elizaos/plugin-anthropic";
  }
  if (providerId === "openai-codex") {
    return "@elizaos/plugin-openai";
  }
  return `@elizaos/plugin-${providerId}`;
}

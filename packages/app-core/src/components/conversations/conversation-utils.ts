import { getOnboardingProviderOption } from "@elizaos/shared/contracts/onboarding";
import { VRM_COUNT } from "../../state";

function catalogProviderName(
  id: Parameters<typeof getOnboardingProviderOption>[0],
  fallback: string,
): string {
  return getOnboardingProviderOption(id)?.name ?? fallback;
}

export function getLocalizedConversationTitle(
  title: string | undefined | null,
  t: (
    key: string,
    vars?: Record<string, string | number | boolean | null | undefined>,
  ) => string,
): string {
  const trimmed = title?.trim() ?? "";
  if (
    !trimmed ||
    trimmed === "New Chat" ||
    trimmed === "companion.newChat" ||
    trimmed.toLowerCase() === "default"
  ) {
    const localized = t("companion.newChat");
    return localized === "companion.newChat" ? "New Chat" : localized;
  }
  return trimmed;
}

export const BROWSER_CAPABILITY_PLUGIN_IDS = new Set([
  "browser",
  "browserbase",
  "chrome-extension",
]);

export const COMPUTER_CAPABILITY_PLUGIN_IDS = new Set([
  "computeruse",
  "computer-use",
]);

export function formatRelativeTime(
  dateString: string,
  t: (
    key: string,
    vars?: Record<string, string | number | boolean | null | undefined>,
  ) => string,
): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t("conversations.justNow");
  if (diffMins < 60) return t("conversations.minutesAgo", { count: diffMins });
  if (diffHours < 24) return t("conversations.hoursAgo", { count: diffHours });
  if (diffDays < 7) return t("conversations.daysAgo", { count: diffDays });

  return date.toLocaleDateString();
}

export function avatarIndexFromConversationId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const normalized = Math.abs(hash) % VRM_COUNT;
  return normalized + 1;
}

export function resolveProviderLabel(model: string | undefined): string {
  const value = (model ?? "").trim();
  if (!value) return "";

  const lower = value.toLowerCase();
  const knownProviders: Array<{ match: string; label: string }> = [
    {
      match: "elizacloud",
      label: catalogProviderName("elizacloud", "Eliza Cloud"),
    },
    {
      match: "openrouter",
      label: catalogProviderName("openrouter", "OpenRouter"),
    },
    { match: "openai", label: catalogProviderName("openai", "OpenAI") },
    {
      match: "anthropic",
      label: catalogProviderName("anthropic", "Claude Platform (api key)"),
    },
    { match: "gemini", label: catalogProviderName("gemini", "Gemini") },
    { match: "google", label: catalogProviderName("gemini", "Google") },
    { match: "grok", label: catalogProviderName("grok", "xAI (Grok)") },
    { match: "xai", label: catalogProviderName("grok", "xAI") },
    { match: "groq", label: catalogProviderName("groq", "Groq") },
    { match: "ollama", label: catalogProviderName("ollama", "Ollama") },
    {
      match: "deepseek",
      label: catalogProviderName("deepseek", "DeepSeek"),
    },
    { match: "mistral", label: catalogProviderName("mistral", "Mistral") },
    {
      match: "together",
      label: catalogProviderName("together", "Together AI"),
    },
    { match: "zai", label: catalogProviderName("zai", "z.ai") },
    { match: "cohere", label: "Cohere" },
  ];
  for (const provider of knownProviders) {
    if (lower.includes(provider.match)) return provider.label;
  }

  if (lower.startsWith("gpt")) return catalogProviderName("openai", "OpenAI");
  if (lower.startsWith("claude"))
    return catalogProviderName("anthropic", "Claude Platform (api key)");
  if (lower.startsWith("gemini"))
    return catalogProviderName("gemini", "Gemini");

  const splitToken = value.split(/[/:|]/)[0]?.trim();
  if (splitToken) return splitToken.toUpperCase();
  return "";
}

export function isNonChatModelLabel(model: string | undefined): boolean {
  const value = (model ?? "").trim().toLowerCase();
  if (!value) return false;
  if (value === "text_embedding") return true;
  if (value === "text_large") return true;
  if (value === "text_small") return true;
  if (value.includes("text_embedding")) return true;
  if (value.includes("embedding")) return true;
  if (value.includes("text_large") || value.includes("text_small")) return true;
  if (/^text_[a-z0-9_]+$/.test(value)) return true;
  return false;
}

export function estimateTokenCost(
  promptTokens: number,
  completionTokens: number,
  model: string | undefined,
): string {
  const normalizedModel = (model ?? "").toLowerCase();
  const pricingByMillion: Record<string, [number, number]> = {
    "gpt-5.4-pro": [30.0, 180.0],
    "gpt-5.4-mini": [0.75, 4.5],
    "gpt-5.4-nano": [0.2, 1.25],
    "gpt-5.4": [2.5, 15.0],
    "gpt-4.1": [2.0, 8.0],
    "gpt-4o": [2.5, 10.0],
    "gpt-4": [30.0, 60.0],
    "claude-4": [15.0, 75.0],
    "claude-3.7": [3.0, 15.0],
    "claude-3.5": [3.0, 15.0],
    "gemini-2.5-pro": [1.25, 10.0],
    "gemini-2.0-flash": [0.1, 0.4],
    deepseek: [0.55, 2.19],
    qwen: [0.35, 1.4],
    kimi: [0.2, 0.8],
    moonshot: [0.2, 0.8],
  };

  let inputCostPerMillion = 1.0;
  let outputCostPerMillion = 3.0;
  for (const [key, [inCost, outCost]] of Object.entries(pricingByMillion)) {
    if (normalizedModel.includes(key)) {
      inputCostPerMillion = inCost;
      outputCostPerMillion = outCost;
      break;
    }
  }

  const estimated =
    (promptTokens / 1_000_000) * inputCostPerMillion +
    (completionTokens / 1_000_000) * outputCostPerMillion;
  if (estimated <= 0) return "$0.0000";
  if (estimated < 0.0001) return "<$0.0001";
  if (estimated < 0.01) return `~$${estimated.toFixed(4)}`;
  return `~$${estimated.toFixed(3)}`;
}

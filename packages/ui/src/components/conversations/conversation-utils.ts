/**
 * Presentation helpers for the conversations sidebar: localized title fallback
 * ("New Chat"), a stable avatar index hashed from a conversation id, provider
 * label resolution from a model string, an embedding/utility-model classifier,
 * and the browser/computer capability plugin-id sets used to badge rows. Pure
 * and framework-free (re-exports `formatRelativeTime` for callers).
 */

import { VRM_COUNT } from "../../state";
import { formatRelativeTime } from "../../utils/format";

export { formatRelativeTime };

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
    const localized = t("common.newChat");
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
    { match: "zai", label: "z.ai" },
    { match: "cohere", label: "Cohere" },
  ];
  for (const provider of knownProviders) {
    if (lower.includes(provider.match)) return provider.label;
  }

  if (lower.startsWith("gpt")) return "OpenAI";
  if (lower.startsWith("claude")) return "Anthropic";
  if (lower.startsWith("gemini")) return "Google";

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

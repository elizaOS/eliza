import { resolveAppAssetUrl } from "../../utils/asset-url.js";

const PROVIDER_LOGOS: Record<string, readonly [dark: string, light: string]> = {
  openai: ["logos/openai-icon-white.png", "logos/openai-icon.png"],
  anthropic: ["logos/anthropic-icon-white.png", "logos/anthropic-icon.png"],
  "anthropic-subscription": ["logos/claude-icon.png", "logos/claude-icon.png"],
  "openai-subscription": [
    "logos/openai-icon-white.png",
    "logos/openai-icon.png",
  ],
  "gemini-subscription": ["logos/gemini-icon.png", "logos/gemini-icon.png"],
  "zai-coding-subscription": ["logos/zai-icon-white.png", "logos/zai-icon.png"],
  "kimi-coding-subscription": [
    "logos/openai-icon-white.png",
    "logos/openai-icon.png",
  ],
  "deepseek-coding-subscription": [
    "logos/deepseek-icon.png",
    "logos/deepseek-icon.png",
  ],
  groq: ["logos/groq-icon-white.png", "logos/groq-icon.png"],
  google: ["logos/gemini-icon.png", "logos/gemini-icon.png"],
  gemini: ["logos/gemini-icon.png", "logos/gemini-icon.png"],
  ollama: ["logos/ollama-icon-white.png", "logos/ollama-icon.png"],
  xai: ["logos/grok-icon-white.png", "logos/grok-icon.png"],
  grok: ["logos/grok-icon-white.png", "logos/grok-icon.png"],
  openrouter: ["logos/openrouter-icon-white.png", "logos/openrouter-icon.png"],
  elizacloud: ["logos/elizaos-icon.png", "logos/elizaos-icon.png"],
  deepseek: ["logos/deepseek-icon.png", "logos/deepseek-icon.png"],
  mistral: ["logos/mistral-icon.png", "logos/mistral-icon.png"],
  together: ["logos/together-ai-icon.png", "logos/together-ai-icon.png"],
  "together-ai": ["logos/together-ai-icon.png", "logos/together-ai-icon.png"],
  zai: ["logos/zai-icon-white.png", "logos/zai-icon.png"],
  "z.ai": ["logos/zai-icon-white.png", "logos/zai-icon.png"],
};

export function getProviderLogo(
  providerId: string,
  isDarkMode = true,
  customLogo?: { logoDark?: string; logoLight?: string },
): string {
  const custom = isDarkMode ? customLogo?.logoDark : customLogo?.logoLight;
  if (custom) return resolveAppAssetUrl(custom);
  const key = providerId.toLowerCase();
  const logo = Object.hasOwn(PROVIDER_LOGOS, key)
    ? PROVIDER_LOGOS[key][isDarkMode ? 0 : 1]
    : undefined;
  if (logo) return resolveAppAssetUrl(logo);
  const initials = Array.from(providerId)
    .slice(0, 2)
    .join("")
    .toUpperCase()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const colors = ["3b82f6", "ef4444", "10b981", "f59e0b", "8b5cf6", "ec4899"];
  const color = colors[(providerId.charCodeAt(0) || 0) % colors.length];
  const svg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="4" fill="#${color}"/><text x="12" y="16" font-family="sans-serif" font-size="10" font-weight="bold" fill="white" text-anchor="middle">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

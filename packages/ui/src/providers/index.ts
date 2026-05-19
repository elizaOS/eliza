/** Provider logo mapping — maps AI provider IDs to their logo image paths. */

export {
  getDirectAccountProviderForOnboardingProvider,
  getOnboardingProviderFamily,
  getOnboardingProviderOption,
  getStoredOnboardingProviderId,
  getStoredSubscriptionProvider,
  getSubscriptionProviderFamily,
  isSubscriptionProviderSelectionId,
  normalizeOnboardingProviderId,
  normalizeSubscriptionProviderSelectionId,
  ONBOARDING_PROVIDER_CATALOG,
  type OnboardingProviderId,
  type ProviderOption as OnboardingProviderOption,
  requiresAdditionalRuntimeProvider,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  type SubscriptionProviderSelectionId,
  sortOnboardingProviders,
} from "@elizaos/shared";

import { resolveAppAssetUrl } from "../utils/asset-url";

const PROVIDER_LOGO_MAP_DARK: Record<string, string> = {
  openai: "logos/openai-icon-white.png",
  anthropic: "logos/anthropic-icon-white.png", // Anthropic API Key
  "anthropic-subscription": "logos/claude-icon.png", // Claude Subscription
  "openai-subscription": "logos/openai-icon-white.png", // ChatGPT Subscription
  "gemini-subscription": "logos/gemini-icon.png",
  "zai-coding-subscription": "logos/zai-icon-white.png",
  "kimi-coding-subscription": "logos/openai-icon-white.png",
  "deepseek-coding-subscription": "logos/deepseek-icon.png",
  groq: "logos/groq-icon-white.png",
  google: "logos/gemini-icon.png",
  gemini: "logos/gemini-icon.png",
  ollama: "logos/ollama-icon-white.png",
  xai: "logos/grok-icon-white.png",
  grok: "logos/grok-icon-white.png",
  openrouter: "logos/openrouter-icon-white.png",
  elizacloud: "logos/elizaos-icon.png",
  deepseek: "logos/deepseek-icon.png",
  mistral: "logos/mistral-icon.png",
  together: "logos/together-ai-icon.png",
  "together-ai": "logos/together-ai-icon.png",
  zai: "logos/zai-icon-white.png",
  "z.ai": "logos/zai-icon-white.png",
};

const PROVIDER_LOGO_MAP_LIGHT: Record<string, string> = {
  openai: "logos/openai-icon.png",
  anthropic: "logos/anthropic-icon.png", // Anthropic API Key
  "anthropic-subscription": "logos/claude-icon.png", // Claude Subscription
  "openai-subscription": "logos/openai-icon.png", // ChatGPT Subscription
  "gemini-subscription": "logos/gemini-icon.png",
  "zai-coding-subscription": "logos/zai-icon.png",
  "kimi-coding-subscription": "logos/openai-icon.png",
  "deepseek-coding-subscription": "logos/deepseek-icon.png",
  groq: "logos/groq-icon.png",
  google: "logos/gemini-icon.png",
  gemini: "logos/gemini-icon.png",
  ollama: "logos/ollama-icon.png",
  xai: "logos/grok-icon.png",
  grok: "logos/grok-icon.png",
  openrouter: "logos/openrouter-icon.png",
  elizacloud: "logos/elizaos-icon.png",
  deepseek: "logos/deepseek-icon.png",
  mistral: "logos/mistral-icon.png",
  together: "logos/together-ai-icon.png",
  "together-ai": "logos/together-ai-icon.png",
  zai: "logos/zai-icon.png",
  "z.ai": "logos/zai-icon.png",
};

// ---------------------------------------------------------------------------
// Provider logo registry — allows plugins to register logos for custom
// providers at runtime without modifying the hardcoded maps above.
// ---------------------------------------------------------------------------

const _registeredLogos: {
  dark: Record<string, string>;
  light: Record<string, string>;
} = { dark: {}, light: {} };

/**
 * Register a provider logo at runtime. Plugins should call this during
 * initialization to add logos for their custom providers.
 *
 * @param providerId - The provider ID (e.g., "my-custom-provider")
 * @param logos - Logo paths for dark and/or light themes
 */
export function registerProviderLogo(
  providerId: string,
  logos: { logoDark?: string; logoLight?: string },
): void {
  const key = providerId.toLowerCase();
  if (logos.logoDark) {
    _registeredLogos.dark[key] = logos.logoDark;
  }
  if (logos.logoLight) {
    _registeredLogos.light[key] = logos.logoLight;
  }
}

/**
 * Get the logo path for a provider based on theme.
 *
 * @param providerId - The provider ID (e.g., "openai", "anthropic")
 * @param isDarkMode - Whether dark mode is active (default: true)
 * @param customLogo - Optional custom logo paths (from CustomProviderOption)
 * @returns The logo image path or a fallback SVG data URI
 */
export function getProviderLogo(
  providerId: string,
  isDarkMode: boolean = true,
  customLogo?: { logoDark?: string; logoLight?: string },
): string {
  // Check custom logo first (from app-injected providers)
  const custom = isDarkMode ? customLogo?.logoDark : customLogo?.logoLight;
  if (custom) {
    return resolveAppAssetUrl(custom);
  }

  const key = providerId.toLowerCase();

  // Check runtime-registered logos
  const registeredMap = isDarkMode
    ? _registeredLogos.dark
    : _registeredLogos.light;
  const registeredLogo = registeredMap[key];
  if (registeredLogo) {
    return resolveAppAssetUrl(registeredLogo);
  }

  // Check hardcoded logo maps
  const logoMap = isDarkMode ? PROVIDER_LOGO_MAP_DARK : PROVIDER_LOGO_MAP_LIGHT;
  const logo = logoMap[key];
  if (logo) {
    return resolveAppAssetUrl(logo);
  }

  // Fallback: generate a colored square with initials
  return generateFallbackLogo(providerId);
}

/**
 * Generate a fallback logo for unknown providers
 * Creates a colored square with the provider's initials
 */
function generateFallbackLogo(providerId: string): string {
  const initials = providerId.slice(0, 2).toUpperCase();
  const colors = ["3b82f6", "ef4444", "10b981", "f59e0b", "8b5cf6", "ec4899"];
  const colorIndex = providerId.charCodeAt(0) % colors.length;
  const bgColor = colors[colorIndex];

  return `data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='24' height='24' rx='4' fill='%23${bgColor}'/%3E%3Ctext x='12' y='16' font-family='sans-serif' font-size='10' font-weight='bold' fill='white' text-anchor='middle'%3E${initials}%3C/text%3E%3C/svg%3E`;
}

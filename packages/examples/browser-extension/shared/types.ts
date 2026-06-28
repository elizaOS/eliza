/**
 * Shared types for the Browser Extension
 */

// Provider modes - one per inference backend the extension can run.
export type ProviderMode =
  | "openai"
  | "openrouter"
  | "anthropic"
  | "xai"
  | "gemini"
  | "groq"
  | "elizacloud";

// Provider settings for API keys
export type ProviderSettings = {
  // OpenAI
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiSmallModel: string;
  openaiLargeModel: string;

  // OpenRouter
  openrouterApiKey: string;
  openrouterBaseUrl: string;
  openrouterSmallModel: string;
  openrouterLargeModel: string;

  // Anthropic
  anthropicApiKey: string;
  anthropicSmallModel: string;
  anthropicLargeModel: string;

  // xAI (Grok)
  xaiApiKey: string;
  xaiBaseUrl: string;
  xaiSmallModel: string;
  xaiLargeModel: string;

  // Gemini
  googleGenaiApiKey: string;
  googleSmallModel: string;
  googleLargeModel: string;

  // Groq
  groqApiKey: string;
  groqBaseUrl: string;
  groqSmallModel: string;
  groqLargeModel: string;

  // Eliza Cloud
  elizaCloudApiKey: string;
};

// Extension configuration
export type ExtensionConfig = {
  mode: ProviderMode;
  provider: ProviderSettings;
};

// Default configuration
export const DEFAULT_CONFIG: ExtensionConfig = {
  mode: "openai",
  provider: {
    // OpenAI
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiSmallModel: "gpt-5-mini",
    openaiLargeModel: "gpt-5",

    // OpenRouter
    openrouterApiKey: "",
    openrouterBaseUrl: "https://openrouter.ai/api/v1",
    openrouterSmallModel: "openai/gpt-4o-mini",
    openrouterLargeModel: "openai/gpt-4o",

    // Anthropic
    anthropicApiKey: "",
    anthropicSmallModel: "claude-3-5-haiku-20241022",
    anthropicLargeModel: "claude-sonnet-4-6",

    // xAI (Grok)
    xaiApiKey: "",
    xaiBaseUrl: "https://api.x.ai/v1",
    xaiSmallModel: "grok-3-mini",
    xaiLargeModel: "grok-3",

    // Gemini
    googleGenaiApiKey: "",
    googleSmallModel: "gemini-2.0-flash-001",
    googleLargeModel: "gemini-2.0-flash-001",

    // Groq
    groqApiKey: "",
    groqBaseUrl: "https://api.groq.com/openai/v1",
    groqSmallModel: "openai/gpt-oss-120b",
    groqLargeModel: "openai/gpt-oss-120b",

    // Eliza Cloud
    elizaCloudApiKey: "",
  },
};

// Page content extracted from the current webpage
export type PageContent = {
  title: string;
  url: string;
  content: string;
  extractedAt: number;
  // Enhanced content fields
  selectedText?: string;
  visibleText?: string;
  screenshot?: string; // base64 data URL
};

// Chat message for UI
export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
};

// Message types for communication between extension parts
export type MessageType =
  | "GET_PAGE_CONTENT"
  | "PAGE_CONTENT_RESPONSE"
  | "SEND_CHAT_MESSAGE"
  | "CHAT_RESPONSE"
  | "GET_CONFIG"
  | "SET_CONFIG"
  | "CONFIG_RESPONSE";

export type ExtensionMessage =
  | { type: "GET_PAGE_CONTENT" }
  | { type: "PAGE_CONTENT_RESPONSE"; content: PageContent | null }
  | { type: "SEND_CHAT_MESSAGE"; text: string }
  | { type: "CHAT_RESPONSE"; text: string; done: boolean }
  | { type: "GET_CONFIG" }
  | { type: "SET_CONFIG"; config: ExtensionConfig }
  | { type: "CONFIG_RESPONSE"; config: ExtensionConfig };

// Whether the given provider has its API key configured.
function providerKeyPresent(
  mode: ProviderMode,
  provider: ProviderSettings,
): boolean {
  switch (mode) {
    case "openai":
      return (provider.openaiApiKey ?? "").trim().length > 0;
    case "openrouter":
      return (provider.openrouterApiKey ?? "").trim().length > 0;
    case "anthropic":
      return (provider.anthropicApiKey ?? "").trim().length > 0;
    case "elizacloud":
      return (provider.elizaCloudApiKey ?? "").trim().length > 0;
    case "xai":
      return (provider.xaiApiKey ?? "").trim().length > 0;
    case "gemini":
      return (provider.googleGenaiApiKey ?? "").trim().length > 0;
    case "groq":
      return (provider.groqApiKey ?? "").trim().length > 0;
  }
}

// Whether the explicitly selected provider has a valid API key configured.
export function hasValidApiKey(config: ExtensionConfig): boolean {
  return providerKeyPresent(config.mode, config.provider);
}

// Auto-selection order when the chosen provider has no key. Mirrors the
// inference-provider contract: OpenAI > OpenRouter > Anthropic > Eliza Cloud,
// then the remaining OpenAI-compatible providers this extension supports.
export const PROVIDER_PRIORITY: ProviderMode[] = [
  "openai",
  "openrouter",
  "anthropic",
  "elizacloud",
  "xai",
  "gemini",
  "groq",
];

/**
 * Pick the provider to run with:
 *  - honor the explicitly selected mode when its key is set,
 *  - otherwise fall back to the first configured provider by priority,
 *  - return null when no provider has a key (caller must surface a clear error).
 */
export function selectProvider(config: ExtensionConfig): ProviderMode | null {
  if (providerKeyPresent(config.mode, config.provider)) return config.mode;
  for (const mode of PROVIDER_PRIORITY) {
    if (providerKeyPresent(mode, config.provider)) return mode;
  }
  return null;
}

// Deep merge utility for config objects
export function deepMergeConfig(
  target: ExtensionConfig,
  source: Partial<ExtensionConfig>,
): ExtensionConfig {
  const result: ExtensionConfig = {
    mode: source.mode ?? target.mode,
    provider: {
      ...target.provider,
      ...(source.provider ?? {}),
    },
  };
  return result;
}

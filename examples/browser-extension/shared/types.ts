/**
 * Shared types for the Browser Extension
 */

// Provider modes - matches VRM demo pattern
export type ProviderMode = "elizaClassic" | "openai" | "anthropic" | "xai" | "gemini" | "groq";

// Provider settings for API keys
export type ProviderSettings = {
  // OpenAI
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiSmallModel: string;
  openaiLargeModel: string;

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
};

// Extension configuration
export type ExtensionConfig = {
  mode: ProviderMode;
  provider: ProviderSettings;
};

// Default configuration
export const DEFAULT_CONFIG: ExtensionConfig = {
  mode: "elizaClassic",
  provider: {
    // OpenAI
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiSmallModel: "gpt-5-mini",
    openaiLargeModel: "gpt-5",

    // Anthropic
    anthropicApiKey: "",
    anthropicSmallModel: "claude-3-5-haiku-20241022",
    anthropicLargeModel: "claude-sonnet-4-20250514",

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
    groqSmallModel: "llama-3.1-8b-instant",
    groqLargeModel: "llama-3.3-70b-versatile",
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

// Provider mode labels for UI
export function getModeLabel(mode: ProviderMode): string {
  switch (mode) {
    case "elizaClassic":
      return "ELIZA (offline)";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Claude";
    case "xai":
      return "Grok";
    case "gemini":
      return "Gemini";
    case "groq":
      return "Groq";
    default:
      return "ELIZA (offline)";
  }
}

// Check if a mode has a valid API key configured
export function hasValidApiKey(config: ExtensionConfig): boolean {
  switch (config.mode) {
    case "elizaClassic":
      return true; // No API key needed
    case "openai":
      return (config.provider.openaiApiKey ?? "").trim().length > 0;
    case "anthropic":
      return (config.provider.anthropicApiKey ?? "").trim().length > 0;
    case "xai":
      return (config.provider.xaiApiKey ?? "").trim().length > 0;
    case "gemini":
      return (config.provider.googleGenaiApiKey ?? "").trim().length > 0;
    case "groq":
      return (config.provider.groqApiKey ?? "").trim().length > 0;
    default:
      return false;
  }
}

// Get effective mode (falls back to elizaClassic if no API key)
export function getEffectiveMode(config: ExtensionConfig): ProviderMode {
  if (config.mode === "elizaClassic") return "elizaClassic";
  return hasValidApiKey(config) ? config.mode : "elizaClassic";
}

// Deep merge utility for config objects
export function deepMergeConfig(
  target: ExtensionConfig,
  source: Partial<ExtensionConfig>
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

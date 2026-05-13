export type ProviderMode =
  | "elizaClassic"
  | "openai"
  | "anthropic"
  | "xai"
  | "gemini"
  | "groq"
  | "openrouter"
  | "ollama";

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

  // xAI (OpenAI-compatible)
  xaiApiKey: string;
  xaiBaseUrl: string;
  xaiSmallModel: string;
  xaiLargeModel: string;

  // Gemini (Google GenAI)
  googleGenaiApiKey: string;
  googleSmallModel: string;
  googleLargeModel: string;

  // Groq (OpenAI-compatible)
  groqApiKey: string;
  groqBaseUrl: string;
  groqSmallModel: string;
  groqLargeModel: string;

  // OpenRouter
  openrouterApiKey: string;
  openrouterBaseUrl: string;
  openrouterSmallModel: string;
  openrouterLargeModel: string;

  // Ollama
  ollamaApiEndpoint: string;
  ollamaSmallModel: string;
  ollamaLargeModel: string;
};

export type AppConfig = {
  mode: ProviderMode;
  provider: ProviderSettings;
};

export const DEFAULT_CONFIG: AppConfig = {
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
    anthropicLargeModel: "claude-sonnet-4-6",

    // xAI (Grok via OpenAI-compatible API)
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

    // OpenRouter
    openrouterApiKey: "",
    openrouterBaseUrl: "https://openrouter.ai/api/v1",
    openrouterSmallModel: "openai/gpt-5-mini",
    openrouterLargeModel: "openai/gpt-5",

    // Ollama
    ollamaApiEndpoint: "http://localhost:11434",
    ollamaSmallModel: "eliza-1-2b",
    ollamaLargeModel: "eliza-1-9b",
  },
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
};

function hasValidCredentials(config: AppConfig): boolean {
  switch (config.mode) {
    case "elizaClassic":
      return true;
    case "openai":
      return config.provider.openaiApiKey.trim().length > 0;
    case "anthropic":
      return config.provider.anthropicApiKey.trim().length > 0;
    case "xai":
      return config.provider.xaiApiKey.trim().length > 0;
    case "gemini":
      return config.provider.googleGenaiApiKey.trim().length > 0;
    case "groq":
      return config.provider.groqApiKey.trim().length > 0;
    case "openrouter":
      return config.provider.openrouterApiKey.trim().length > 0;
    case "ollama":
      return config.provider.ollamaApiEndpoint.trim().length > 0;
    default:
      return false;
  }
}

export function getEffectiveMode(config: AppConfig): ProviderMode {
  if (config.mode === "elizaClassic") return "elizaClassic";
  return hasValidCredentials(config) ? config.mode : "elizaClassic";
}

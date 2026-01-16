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
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiSmallModel: string;
  openaiLargeModel: string;

  anthropicApiKey: string;
  anthropicSmallModel: string;
  anthropicLargeModel: string;

  xaiApiKey: string;
  xaiBaseUrl: string;
  xaiSmallModel: string;
  xaiLargeModel: string;

  googleGenaiApiKey: string;
  googleSmallModel: string;
  googleLargeModel: string;

  groqApiKey: string;
  groqBaseUrl: string;
  groqSmallModel: string;
  groqLargeModel: string;

  openrouterApiKey: string;
  openrouterBaseUrl: string;
  openrouterSmallModel: string;
  openrouterLargeModel: string;

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
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiSmallModel: "gpt-5-mini",
    openaiLargeModel: "gpt-5",

    anthropicApiKey: "",
    anthropicSmallModel: "claude-3-5-haiku-20241022",
    anthropicLargeModel: "claude-sonnet-4-20250514",

    xaiApiKey: "",
    xaiBaseUrl: "https://api.x.ai/v1",
    xaiSmallModel: "grok-3-mini",
    xaiLargeModel: "grok-3",

    googleGenaiApiKey: "",
    googleSmallModel: "gemini-2.0-flash-001",
    googleLargeModel: "gemini-2.0-flash-001",

    groqApiKey: "",
    groqBaseUrl: "https://api.groq.com/openai/v1",
    groqSmallModel: "llama-3.1-8b-instant",
    groqLargeModel: "llama-3.3-70b-versatile",

    openrouterApiKey: "",
    openrouterBaseUrl: "https://openrouter.ai/api/v1",
    openrouterSmallModel: "openai/gpt-5-mini",
    openrouterLargeModel: "openai/gpt-5",

    ollamaApiEndpoint: "http://localhost:11434",
    ollamaSmallModel: "llama3.2:3b",
    ollamaLargeModel: "llama3.1:8b",
  },
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
};

export function hasValidCredentials(config: AppConfig): boolean {
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


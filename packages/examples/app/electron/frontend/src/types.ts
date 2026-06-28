export type ProviderMode =
  | "openai"
  | "anthropic"
  | "xai"
  | "gemini"
  | "groq"
  | "openrouter"
  | "ollama"
  | "elizacloud";

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

  elizacloudApiKey: string;
  elizacloudBaseUrl: string;
  elizacloudSmallModel: string;
  elizacloudLargeModel: string;
};

export type AppConfig = {
  mode: ProviderMode;
  provider: ProviderSettings;
};

export const DEFAULT_CONFIG: AppConfig = {
  mode: "openai",
  provider: {
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiSmallModel: "gpt-5-mini",
    openaiLargeModel: "gpt-5",

    anthropicApiKey: "",
    anthropicSmallModel: "claude-3-5-haiku-20241022",
    anthropicLargeModel: "claude-sonnet-4-6",

    xaiApiKey: "",
    xaiBaseUrl: "https://api.x.ai/v1",
    xaiSmallModel: "grok-3-mini",
    xaiLargeModel: "grok-3",

    googleGenaiApiKey: "",
    googleSmallModel: "gemini-2.0-flash-001",
    googleLargeModel: "gemini-2.0-flash-001",

    groqApiKey: "",
    groqBaseUrl: "https://api.groq.com/openai/v1",
    groqSmallModel: "openai/gpt-oss-120b",
    groqLargeModel: "openai/gpt-oss-120b",

    openrouterApiKey: "",
    openrouterBaseUrl: "https://openrouter.ai/api/v1",
    openrouterSmallModel: "openai/gpt-5-mini",
    openrouterLargeModel: "openai/gpt-5",

    ollamaApiEndpoint: "http://localhost:11434",
    ollamaSmallModel: "eliza-1-2b",
    ollamaLargeModel: "eliza-1-9b",

    elizacloudApiKey: "",
    elizacloudBaseUrl: "https://elizacloud.ai/api/v1",
    elizacloudSmallModel: "gpt-oss-120b",
    elizacloudLargeModel: "zai-glm-4.7",
  },
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
};

export function getModeLabel(mode: ProviderMode): string {
  switch (mode) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Claude";
    case "xai":
      return "Grok (xAI)";
    case "gemini":
      return "Gemini";
    case "groq":
      return "Groq";
    case "openrouter":
      return "OpenRouter";
    case "ollama":
      return "Ollama";
    case "elizacloud":
      return "Eliza Cloud";
    default:
      return "OpenAI";
  }
}

export type ProviderMode =
  | "openai"
  | "anthropic"
  | "xai"
  | "gemini"
  | "groq"
  | "openrouter"
  | "ollama"
  | "elizacloud";

type ProviderSettings = {
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
    elizacloudSmallModel: "gemma-4-31b",
    elizacloudLargeModel: "gemma-4-31b",
  },
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
};

/**
 * Provider-selection contract. When the UI-selected provider has no
 * credentials entered, fall back to whichever real inference provider has an
 * API key present in the environment, checked in this fixed priority order.
 * There is no offline fallback.
 */
const ENV_PROVIDER_PRIORITY: ReadonlyArray<{
  mode: ProviderMode;
  envVar: string;
}> = [
  { mode: "openai", envVar: "OPENAI_API_KEY" },
  { mode: "openrouter", envVar: "OPENROUTER_API_KEY" },
  { mode: "anthropic", envVar: "ANTHROPIC_API_KEY" },
  { mode: "elizacloud", envVar: "ELIZA_API_KEY" },
];

export function selectProviderFromEnv(): ProviderMode {
  for (const { mode, envVar } of ENV_PROVIDER_PRIORITY) {
    const value = process.env[envVar];
    if (typeof value === "string" && value.trim().length > 0) return mode;
  }
  throw new Error(
    "No inference provider configured. Set one of OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or ELIZA_API_KEY.",
  );
}

function hasValidCredentials(config: AppConfig): boolean {
  switch (config.mode) {
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
    case "elizacloud":
      return config.provider.elizacloudApiKey.trim().length > 0;
    default:
      return false;
  }
}

export function getEffectiveMode(config: AppConfig): ProviderMode {
  if (hasValidCredentials(config)) return config.mode;
  return selectProviderFromEnv();
}

export type ModelProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "groq"
  | "xai"
  | "local";

export type ProviderModelConfig = {
  apiKey: string;
  baseUrl?: string;
  smallModel: string;
  largeModel: string;
};

export type ModelSettings = {
  provider: ModelProvider;
  openai: ProviderModelConfig;
  anthropic: ProviderModelConfig;
  google: ProviderModelConfig;
  groq: ProviderModelConfig;
  xai: ProviderModelConfig;
  local: ProviderModelConfig;
};

export const MODEL_PROVIDER_LABELS: Record<ModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Gemini",
  groq: "Groq",
  xai: "xAI",
  local: "Local",
};

export function defaultModelSettings(): ModelSettings {
  return {
    provider: "openai",
    openai: {
      apiKey: "",
      baseUrl: "",
      smallModel: "gpt-5-mini",
      largeModel: "gpt-5",
    },
    anthropic: {
      apiKey: "",
      baseUrl: "",
      smallModel: "claude-3-haiku-20240307",
      largeModel: "claude-3-5-sonnet-20240620",
    },
    google: {
      apiKey: "",
      baseUrl: "",
      smallModel: "gemini-1.5-flash",
      largeModel: "gemini-1.5-pro",
    },
    groq: {
      apiKey: "",
      baseUrl: "",
      smallModel: "llama-3.1-8b-instant",
      largeModel: "llama-3.3-70b-versatile",
    },
    xai: {
      apiKey: "",
      baseUrl: "https://api.x.ai/v1",
      smallModel: "grok-3-mini",
      largeModel: "grok-3",
    },
    local: {
      apiKey: "",
      baseUrl: "",
      smallModel: "DeepHermes-3-Llama-3-3B-Preview-q4.gguf",
      largeModel: "DeepHermes-3-Llama-3-8B-q4.gguf",
    },
  };
}

const PROVIDER_VALUES: ModelProvider[] = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "xai",
  "local",
];

export function isModelProvider(value: string): value is ModelProvider {
  return PROVIDER_VALUES.includes(value as ModelProvider);
}

export function isProviderConfigured(settings: ModelSettings): boolean {
  const modelReady = (config: ProviderModelConfig): boolean =>
    config.smallModel.trim().length > 0 && config.largeModel.trim().length > 0;

  // Check if we're running in a browser environment
  const isBrowser =
    typeof window !== "undefined" && typeof document !== "undefined";

  switch (settings.provider) {
    case "openai":
      return (
        settings.openai.apiKey.trim().length > 0 && modelReady(settings.openai)
      );
    case "anthropic":
      return (
        settings.anthropic.apiKey.trim().length > 0 &&
        modelReady(settings.anthropic)
      );
    case "google":
      return (
        settings.google.apiKey.trim().length > 0 && modelReady(settings.google)
      );
    case "groq":
      return (
        settings.groq.apiKey.trim().length > 0 && modelReady(settings.groq)
      );
    case "xai":
      return settings.xai.apiKey.trim().length > 0 && modelReady(settings.xai);
    case "local":
      // Local provider doesn't work in browsers - requires server environment
      if (isBrowser) {
        return false;
      }
      return modelReady(settings.local);
    default:
      return false;
  }
}

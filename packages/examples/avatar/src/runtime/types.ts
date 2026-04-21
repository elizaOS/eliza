export type DemoMode = "elizaClassic" | "openai" | "anthropic" | "xai" | "gemini" | "groq";

export type SamVoiceParams = {
  speed: number;
  pitch: number;
  throat: number;
  mouth: number;
};

export type VoiceOutputProvider = "sam" | "elevenlabs";

export type ProviderSettings = {
  // OpenAI
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiSmallModel: string;
  openaiLargeModel: string;
  openaiBrowserBaseUrl: string;

  // Anthropic
  anthropicApiKey: string;
  anthropicSmallModel: string;
  anthropicLargeModel: string;
  anthropicBrowserBaseUrl: string;

  // xAI
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

  // ElevenLabs
  elevenlabsApiKey: string;
};

export type DemoConfig = {
  mode: DemoMode;
  voiceInputEnabled: boolean;
  voiceOutputEnabled: boolean;
  voiceOutputProvider: VoiceOutputProvider;
  sam: SamVoiceParams;
  provider: ProviderSettings;
};

export const DEFAULT_DEMO_CONFIG: DemoConfig = {
  mode: "elizaClassic",
  voiceInputEnabled: false,
  voiceOutputEnabled: true,
  voiceOutputProvider: "sam",
  sam: {
    speed: 60,
    pitch: 60,
    throat: 190,
    mouth: 160,
  },
  provider: {
    openaiApiKey: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    // NOTE: This demo runs in the browser using AI SDK v5.
    // GPT-5 models require a newer OpenAI provider spec (v3), so default to v2-compatible models.
    openaiSmallModel: "gpt-5-mini",
    openaiLargeModel: "gpt-5",
    openaiBrowserBaseUrl: "",

    anthropicApiKey: "",
    anthropicSmallModel: "claude-3-5-haiku-20241022",
    anthropicLargeModel: "claude-sonnet-4-20250514",
    anthropicBrowserBaseUrl: "",

    xaiApiKey: "",
    xaiBaseUrl: "https://api.x.ai/v1",
    xaiSmallModel: "grok-3-mini",
    xaiLargeModel: "grok-3",

    googleGenaiApiKey: "",
    googleSmallModel: "gemini-2.0-flash-001",
    googleLargeModel: "gemini-2.0-flash-001",

    groqApiKey: "",
    groqBaseUrl: "https://api.groq.com/openai/v1",
    groqSmallModel: "openai/gpt-oss-20b",
    groqLargeModel: "llama-3.3-70b-versatile",

    elevenlabsApiKey: "",
  },
};

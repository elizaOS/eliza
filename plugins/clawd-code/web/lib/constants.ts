export const MODELS = [
  { id: "glm-5.2", label: "GLM-5.2", description: "Default coding and reasoning" },
  { id: "glm-5-turbo", label: "GLM-5 Turbo", description: "Fast Z.AI route" },
  { id: "glm-5v-turbo", label: "GLM-5V Turbo", description: "Vision and chart analysis" },
  { id: "glm-image", label: "GLM-Image", description: "Image generation" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", description: "Most capable" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", description: "Balanced" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", description: "Fastest" },
] as const;

export const DEFAULT_MODEL = "glm-5.2";

/** Mirrors clawd-code's CLI provider list (src/grok-models.ts) — Z.AI is the default. */
export const PROVIDERS = [
  { id: "zai", label: "Z.AI (default)", keyLabel: "ZAI_API_KEY", keyPlaceholder: "zai-...", defaultModel: "glm-5.2" },
  { id: "xai", label: "xAI (Grok)", keyLabel: "XAI_API_KEY", keyPlaceholder: "xai-...", defaultModel: "grok-4.3" },
  { id: "anthropic", label: "Anthropic (Claude)", keyLabel: "ANTHROPIC_API_KEY", keyPlaceholder: "sk-ant-...", defaultModel: "claude-sonnet-4-6" },
  { id: "openrouter", label: "OpenRouter", keyLabel: "OPENROUTER_API_KEY", keyPlaceholder: "sk-or-...", defaultModel: "auto" },
  { id: "deepseek", label: "DeepSeek", keyLabel: "DEEPSEEK_API_KEY", keyPlaceholder: "sk-...", defaultModel: "deepseek-v4-pro" },
] as const;

export const DEFAULT_PROVIDER = "zai";

export const API_ROUTES = {
  chat: "/api/chat",
  stream: "/api/stream",
} as const;

export const MAX_MESSAGE_LENGTH = 100_000;

export const STREAMING_CHUNK_SIZE = 64;

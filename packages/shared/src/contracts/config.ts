/**
 * Shared configuration contracts used across runtime, server, and app client.
 */

export type DatabaseProviderType = "pglite" | "postgres";

export type MediaMode = "cloud" | "own-key";

export type ImageProvider =
  | "cloud"
  | "fal"
  | "openai"
  | "google"
  | "xai"
  | (string & {});

export type ImageFalConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

export type ImageOpenaiConfig = {
  apiKey?: string;
  model?: string;
  quality?: "standard" | "hd";
  style?: "natural" | "vivid";
};

export type ImageGoogleConfig = {
  apiKey?: string;
  model?: string;
  aspectRatio?: string;
};

export type ImageXaiConfig = {
  apiKey?: string;
  model?: string;
};

export type ImageConfig = {
  enabled?: boolean;
  mode?: MediaMode;
  provider?: ImageProvider;
  defaultSize?: string;
  fal?: ImageFalConfig;
  openai?: ImageOpenaiConfig;
  google?: ImageGoogleConfig;
  xai?: ImageXaiConfig;
};

export type VideoProvider =
  | "cloud"
  | "fal"
  | "openai"
  | "google"
  | (string & {});

export type VideoFalConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

export type VideoOpenaiConfig = {
  apiKey?: string;
  model?: string;
};

export type VideoGoogleConfig = {
  apiKey?: string;
  model?: string;
};

export type VideoConfig = {
  enabled?: boolean;
  mode?: MediaMode;
  provider?: VideoProvider;
  defaultDuration?: number;
  fal?: VideoFalConfig;
  openai?: VideoOpenaiConfig;
  google?: VideoGoogleConfig;
};

export type AudioGenProvider = "cloud" | "suno" | "elevenlabs" | (string & {});

export type AudioSunoConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

export type AudioElevenlabsSfxConfig = {
  apiKey?: string;
  duration?: number;
};

export type AudioGenConfig = {
  enabled?: boolean;
  mode?: MediaMode;
  provider?: AudioGenProvider;
  suno?: AudioSunoConfig;
  elevenlabs?: AudioElevenlabsSfxConfig;
};

export type VisionProvider =
  | "cloud"
  | "openai"
  | "google"
  | "anthropic"
  | "xai"
  | "ollama"
  | (string & {});

export type VisionOpenaiConfig = {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
};

export type VisionGoogleConfig = {
  apiKey?: string;
  model?: string;
};

export type VisionAnthropicConfig = {
  apiKey?: string;
  model?: string;
};

export type VisionXaiConfig = {
  apiKey?: string;
  model?: string;
};

export type VisionOllamaConfig = {
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  autoDownload?: boolean;
};

export type VisionConfig = {
  enabled?: boolean;
  mode?: MediaMode;
  provider?: VisionProvider;
  openai?: VisionOpenaiConfig;
  google?: VisionGoogleConfig;
  anthropic?: VisionAnthropicConfig;
  xai?: VisionXaiConfig;
  ollama?: VisionOllamaConfig;
};

export type MediaConfig = {
  image?: ImageConfig;
  video?: VideoConfig;
  audio?: AudioGenConfig;
  vision?: VisionConfig;
};

export type ReleaseChannel = "stable" | "beta" | "nightly";

export type CustomActionHandler =
  | {
      type: "http";
      method: string;
      url: string;
      headers?: Record<string, string>;
      bodyTemplate?: string;
    }
  | { type: "shell"; command: string }
  | { type: "code"; code: string };

export type CustomActionDef = {
  id: string;
  name: string;
  description: string;
  similes?: string[];
  parameters: Array<{ name: string; description: string; required: boolean }>;
  handler: CustomActionHandler;
  enabled: boolean;
  /** Minimum elizaOS role required to invoke this action (OWNER > ADMIN > USER > GUEST). */
  requiredRole?: "OWNER" | "ADMIN" | "USER" | "GUEST";
  createdAt: string;
  updatedAt: string;
};

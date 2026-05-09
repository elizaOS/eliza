/**
 * Media Provider Abstraction Layer
 *
 * Provides a single interface for media generation across multiple providers:
 * - Image Generation: FAL.ai, OpenAI (DALL-E), Google (Imagen), xAI, Eliza Cloud
 * - Video Generation: FAL.ai, OpenAI (Sora), Google (Veo), Eliza Cloud
 * - Audio Generation: Suno, ElevenLabs (SFX), Eliza Cloud
 * - Vision (Analysis): OpenAI, Google, Anthropic, xAI, Eliza Cloud
 *
 * Follows the same pattern as TTS provider selection:
 * - "cloud" mode uses Eliza Cloud (no API key needed)
 * - "own-key" mode uses the user's own API keys
 */

import type {
  AudioGenConfig,
  AudioGenProvider,
  AudioKind,
  ImageConfig,
  MediaConfig,
  VideoConfig,
  VisionConfig,
} from "../config/types.eliza.js";

// ============================================================================
// Fetch Utilities
// ============================================================================

/** Fetch with an AbortController-based timeout (default 30s). */
export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

async function withProviderErrorBoundary<T>(
  providerName: string,
  run: () => Promise<MediaProviderResult<T>>,
): Promise<MediaProviderResult<T>> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `[${providerName}] Network error: ${message}`,
    };
  }
}

const DEFAULT_ELIZA_CLOUD_BASE_URL = "https://elizacloud.ai/api/v1";
const DEFAULT_AUDIO_TIMEOUT_MS = 120_000;

function normalizeAudioKind(value: unknown): AudioKind | undefined {
  switch (value) {
    case "music":
      return "music";
    case "sfx":
    case "sound-effect":
    case "sound_effect":
      return "sfx";
    case "tts":
    case "speech":
    case "text-to-speech":
    case "text_to_speech":
      return "tts";
    default:
      return undefined;
  }
}

function getAudioKind(
  options: AudioGenerationOptions,
  config?: AudioGenConfig,
): AudioKind {
  return (
    normalizeAudioKind(options.audioKind) ??
    normalizeAudioKind(options.kind) ??
    normalizeAudioKind(config?.audioKind) ??
    normalizeAudioKind(config?.kind) ??
    normalizeAudioKind(config?.defaultKind) ??
    "music"
  );
}

function createCloudAudioProvider(
  options: MediaProviderFactoryOptions,
): AudioGenerationProvider {
  return new ElizaCloudAudioProvider(
    options.elizaCloudBaseUrl ?? DEFAULT_ELIZA_CLOUD_BASE_URL,
    options.elizaCloudApiKey,
  );
}

async function responseToAudioResult(
  response: Response,
  title: string,
  duration?: number,
): Promise<AudioGenerationResult> {
  const contentType =
    response.headers.get("content-type")?.split(";")[0] || "audio/mpeg";
  const arrayBuffer = await response.arrayBuffer();
  const audioBase64 = Buffer.from(arrayBuffer).toString("base64");
  return {
    audioUrl: `data:${contentType};base64,${audioBase64}`,
    audioBase64,
    mimeType: contentType,
    id: response.headers.get("song-id") ?? undefined,
    title,
    duration,
  };
}

function buildOutputFormatQuery(outputFormat: string | undefined): string {
  if (!outputFormat) return "";
  return `?output_format=${encodeURIComponent(outputFormat)}`;
}

// ============================================================================
// Result Types
// ============================================================================

export interface MediaProviderResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ImageGenerationResult {
  imageUrl?: string;
  imageBase64?: string;
  revisedPrompt?: string;
}

export interface VideoGenerationResult {
  videoUrl?: string;
  thumbnailUrl?: string;
  duration?: number;
}

export interface AudioGenerationResult {
  audioUrl?: string;
  audioBase64?: string;
  mimeType?: string;
  id?: string;
  fileName?: string;
  title?: string;
  duration?: number;
}

export interface VisionAnalysisResult {
  description: string;
  labels?: string[];
  confidence?: number;
}

// ============================================================================
// Options Types
// ============================================================================

export interface ImageGenerationOptions {
  prompt: string;
  size?: string;
  quality?: "standard" | "hd";
  style?: "natural" | "vivid";
  negativePrompt?: string;
  seed?: number;
}

export interface VideoGenerationOptions {
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  imageUrl?: string;
}

export interface AudioGenerationOptions {
  prompt: string;
  kind?: AudioKind;
  audioKind?: AudioKind;
  text?: string;
  duration?: number;
  instrumental?: boolean;
  genre?: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
  loop?: boolean;
  promptInfluence?: number;
  seed?: number;
  languageCode?: string;
  voiceSettings?: NonNullable<
    NonNullable<AudioGenConfig["elevenlabs"]>["voiceSettings"]
  >;
}

export interface VisionAnalysisOptions {
  imageUrl?: string;
  imageBase64?: string;
  prompt?: string;
  maxTokens?: number;
}

// ============================================================================
// Provider Interfaces
// ============================================================================

export interface ImageGenerationProvider {
  name: string;
  generate(
    options: ImageGenerationOptions,
  ): Promise<MediaProviderResult<ImageGenerationResult>>;
}

export interface VideoGenerationProvider {
  name: string;
  generate(
    options: VideoGenerationOptions,
  ): Promise<MediaProviderResult<VideoGenerationResult>>;
}

export interface AudioGenerationProvider {
  name: string;
  generate(
    options: AudioGenerationOptions,
  ): Promise<MediaProviderResult<AudioGenerationResult>>;
}

export interface VisionAnalysisProvider {
  name: string;
  analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>>;
}

// ============================================================================
// Eliza Cloud Provider Implementations
// ============================================================================

class ElizaCloudImageProvider implements ImageGenerationProvider {
  name = "eliza-cloud";
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async generate(
    options: ImageGenerationOptions,
  ): Promise<MediaProviderResult<ImageGenerationResult>> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/media/image/generate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          prompt: options.prompt,
          size: options.size,
          quality: options.quality,
          style: options.style,
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Eliza Cloud error: ${text}` };
    }

    const data = (await response.json()) as {
      imageUrl?: string;
      imageBase64?: string;
      revisedPrompt?: string;
    };
    return {
      success: true,
      data: {
        imageUrl: data.imageUrl,
        imageBase64: data.imageBase64,
        revisedPrompt: data.revisedPrompt,
      },
    };
  }
}

class ElizaCloudVideoProvider implements VideoGenerationProvider {
  name = "eliza-cloud";
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async generate(
    options: VideoGenerationOptions,
  ): Promise<MediaProviderResult<VideoGenerationResult>> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/media/video/generate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          prompt: options.prompt,
          duration: options.duration,
          aspectRatio: options.aspectRatio,
          imageUrl: options.imageUrl,
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Eliza Cloud error: ${text}` };
    }

    const data = (await response.json()) as {
      videoUrl?: string;
      thumbnailUrl?: string;
      duration?: number;
    };
    return {
      success: true,
      data: {
        videoUrl: data.videoUrl,
        thumbnailUrl: data.thumbnailUrl,
        duration: data.duration,
      },
    };
  }
}

class ElizaCloudAudioProvider implements AudioGenerationProvider {
  name = "eliza-cloud";
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async generate(
    options: AudioGenerationOptions,
  ): Promise<MediaProviderResult<AudioGenerationResult>> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/media/audio/generate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          prompt: options.prompt,
          kind: options.kind,
          audioKind: options.audioKind,
          duration: options.duration,
          instrumental: options.instrumental,
          genre: options.genre,
          voiceId: options.voiceId,
          modelId: options.modelId,
          outputFormat: options.outputFormat,
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Eliza Cloud error: ${text}` };
    }

    const data = (await response.json()) as {
      audioUrl?: string;
      title?: string;
      duration?: number;
    };
    return {
      success: true,
      data: {
        audioUrl: data.audioUrl,
        title: data.title,
        duration: data.duration,
      },
    };
  }
}

class ElizaCloudVisionProvider implements VisionAnalysisProvider {
  name = "eliza-cloud";
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/media/vision/analyze`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          imageUrl: options.imageUrl,
          imageBase64: options.imageBase64,
          prompt: options.prompt,
          maxTokens: options.maxTokens,
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Eliza Cloud error: ${text}` };
    }

    const data = (await response.json()) as {
      description: string;
      labels?: string[];
      confidence?: number;
    };
    return {
      success: true,
      data: {
        description: data.description,
        labels: data.labels,
        confidence: data.confidence,
      },
    };
  }
}

// ============================================================================
// FAL.ai Provider Implementations
// ============================================================================

export class FalImageProvider implements ImageGenerationProvider {
  name = "fal";
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: NonNullable<ImageConfig["fal"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "fal-ai/flux-pro";
    this.baseUrl = config.baseUrl ?? "https://fal.run";
  }

  async generate(
    options: ImageGenerationOptions,
  ): Promise<MediaProviderResult<ImageGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(`${this.baseUrl}/${this.model}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Key ${this.apiKey}`,
        },
        body: JSON.stringify({
          prompt: options.prompt,
          image_size: options.size ?? "landscape_4_3",
          num_images: 1,
          ...(options.negativePrompt
            ? { negative_prompt: options.negativePrompt }
            : {}),
          ...(options.seed ? { seed: options.seed } : {}),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `FAL error: ${text}` };
      }

      const data = (await response.json()) as {
        images?: Array<{ url: string }>;
      };
      const imageUrl = data.images?.[0]?.url;
      if (!imageUrl) {
        return { success: false, error: "No image returned from FAL" };
      }

      return {
        success: true,
        data: { imageUrl },
      };
    });
  }
}

export class FalVideoProvider implements VideoGenerationProvider {
  name = "fal";
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: NonNullable<VideoConfig["fal"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "fal-ai/minimax-video";
    this.baseUrl = config.baseUrl ?? "https://fal.run";
  }

  async generate(
    options: VideoGenerationOptions,
  ): Promise<MediaProviderResult<VideoGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(`${this.baseUrl}/${this.model}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Key ${this.apiKey}`,
        },
        body: JSON.stringify({
          prompt: options.prompt,
          ...(options.duration ? { duration: options.duration } : {}),
          ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
          ...(options.imageUrl ? { image_url: options.imageUrl } : {}),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `FAL error: ${text}` };
      }

      const data = (await response.json()) as {
        video?: { url: string };
        thumbnail?: { url: string };
        duration?: number;
      };

      return {
        success: true,
        data: {
          videoUrl: data.video?.url,
          thumbnailUrl: data.thumbnail?.url,
          duration: data.duration,
        },
      };
    });
  }
}

// ============================================================================
// OpenAI Provider Implementations
// ============================================================================

export class OpenAIImageProvider implements ImageGenerationProvider {
  name = "openai";
  private apiKey: string;
  private model: string;
  private quality: "standard" | "hd";
  private style: "natural" | "vivid";

  constructor(config: NonNullable<ImageConfig["openai"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "dall-e-3";
    this.quality = config.quality ?? "standard";
    this.style = config.style ?? "vivid";
  }

  async generate(
    options: ImageGenerationOptions,
  ): Promise<MediaProviderResult<ImageGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        "https://api.openai.com/v1/images/generations",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            prompt: options.prompt,
            n: 1,
            size: options.size ?? "1024x1024",
            quality: options.quality ?? this.quality,
            style: options.style ?? this.style,
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `OpenAI error: ${text}` };
      }

      const data = (await response.json()) as {
        data?: Array<{ url?: string; revised_prompt?: string }>;
      };
      const image = data.data?.[0];
      if (!image?.url) {
        return { success: false, error: "No image returned from OpenAI" };
      }

      return {
        success: true,
        data: {
          imageUrl: image.url,
          revisedPrompt: image.revised_prompt,
        },
      };
    });
  }
}

export class OpenAIVideoProvider implements VideoGenerationProvider {
  name = "openai";
  private apiKey: string;
  private model: string;

  constructor(config: NonNullable<VideoConfig["openai"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "sora-1.0-turbo";
  }

  async generate(
    options: VideoGenerationOptions,
  ): Promise<MediaProviderResult<VideoGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      // OpenAI Sora API (video generation)
      const response = await fetchWithTimeout(
        "https://api.openai.com/v1/videos/generations",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            prompt: options.prompt,
            n: 1,
            duration: options.duration ?? 5,
            aspect_ratio: options.aspectRatio ?? "16:9",
            ...(options.imageUrl ? { image: options.imageUrl } : {}),
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `OpenAI Sora error: ${text}` };
      }

      const data = (await response.json()) as {
        data?: Array<{ url?: string; duration?: number }>;
      };
      const video = data.data?.[0];
      if (!video?.url) {
        return { success: false, error: "No video returned from OpenAI Sora" };
      }

      return {
        success: true,
        data: {
          videoUrl: video.url,
          duration: video.duration,
        },
      };
    });
  }
}

export class OpenAIVisionProvider implements VisionAnalysisProvider {
  name = "openai";
  private apiKey: string;
  private model: string;
  private maxTokens: number;

  constructor(config: NonNullable<VisionConfig["openai"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gpt-4o";
    this.maxTokens = config.maxTokens ?? 1024;
  }

  async analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    const imageContent = options.imageBase64
      ? {
          type: "image_url" as const,
          image_url: { url: `data:image/jpeg;base64,${options.imageBase64}` },
        }
      : {
          type: "image_url" as const,
          image_url: { url: options.imageUrl ?? "" },
        };

    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: options.maxTokens ?? this.maxTokens,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: options.prompt ?? "Describe this image in detail.",
                  },
                  imageContent,
                ],
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `OpenAI error: ${text}` };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const description = data.choices?.[0]?.message?.content;
      if (!description) {
        return {
          success: false,
          error: "No description returned from OpenAI",
        };
      }

      return {
        success: true,
        data: { description },
      };
    });
  }
}

// ============================================================================
// Google Provider Implementations
// ============================================================================

export class GoogleImageProvider implements ImageGenerationProvider {
  name = "google";
  private apiKey: string;
  private model: string;
  private aspectRatio: string;

  constructor(config: NonNullable<ImageConfig["google"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "imagen-3.0-generate-002";
    this.aspectRatio = config.aspectRatio ?? "1:1";
  }

  async generate(
    options: ImageGenerationOptions,
  ): Promise<MediaProviderResult<ImageGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:predict`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            instances: [{ prompt: options.prompt }],
            parameters: {
              sampleCount: 1,
              aspectRatio: options.size ?? this.aspectRatio,
              personGeneration: "allow_adult",
              safetyFilterLevel: "block_few",
            },
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Google Imagen error: ${text}` };
      }

      const data = (await response.json()) as {
        predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
      };
      const imageData = data.predictions?.[0]?.bytesBase64Encoded;
      if (!imageData) {
        return {
          success: false,
          error: "No image returned from Google Imagen",
        };
      }

      return {
        success: true,
        data: {
          imageBase64: imageData,
        },
      };
    });
  }
}

export class GoogleVideoProvider implements VideoGenerationProvider {
  name = "google";
  private apiKey: string;
  private model: string;

  constructor(config: NonNullable<VideoConfig["google"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "veo-2.0-generate-001";
  }

  async generate(
    options: VideoGenerationOptions,
  ): Promise<MediaProviderResult<VideoGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      // Google Veo uses a different endpoint structure
      const response = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:predictLongRunning`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            instances: [
              {
                prompt: options.prompt,
                ...(options.imageUrl
                  ? { image: { gcsUri: options.imageUrl } }
                  : {}),
              },
            ],
            parameters: {
              aspectRatio: options.aspectRatio ?? "16:9",
              durationSeconds: options.duration ?? 5,
              personGeneration: "allow_adult",
            },
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Google Veo error: ${text}` };
      }

      // Veo returns a long-running operation - for now we return the operation name
      // In production, you'd poll the operation until it completes
      const data = (await response.json()) as {
        name?: string;
        done?: boolean;
        response?: {
          predictions?: Array<{ videoUri?: string }>;
        };
      };

      if (data.done && data.response?.predictions?.[0]?.videoUri) {
        return {
          success: true,
          data: {
            videoUrl: data.response.predictions[0].videoUri,
          },
        };
      }

      // Operation started but not complete - return operation reference
      // Client should poll the operation endpoint
      return {
        success: true,
        data: {
          videoUrl: `pending:${data.name}`,
        },
      };
    });
  }
}

export class GoogleVisionProvider implements VisionAnalysisProvider {
  name = "google";
  private apiKey: string;
  private model: string;

  constructor(config: NonNullable<VisionConfig["google"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gemini-2.0-flash";
  }

  async analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    const imagePart = options.imageBase64
      ? { inline_data: { mime_type: "image/jpeg", data: options.imageBase64 } }
      : { file_data: { file_uri: options.imageUrl, mime_type: "image/jpeg" } };

    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: options.prompt ?? "Describe this image in detail." },
                  imagePart,
                ],
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Google error: ${text}` };
      }

      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const description = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!description) {
        return {
          success: false,
          error: "No description returned from Google",
        };
      }

      return {
        success: true,
        data: { description },
      };
    });
  }
}

// ============================================================================
// xAI Provider Implementations
// ============================================================================

export class XAIImageProvider implements ImageGenerationProvider {
  name = "xai";
  private apiKey: string;
  private model: string;

  constructor(config: NonNullable<ImageConfig["xai"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "grok-2-image";
  }

  async generate(
    options: ImageGenerationOptions,
  ): Promise<MediaProviderResult<ImageGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      // xAI uses OpenAI-compatible API format for image generation
      const response = await fetchWithTimeout(
        "https://api.x.ai/v1/images/generations",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            prompt: options.prompt,
            n: 1,
            size: options.size ?? "1024x1024",
            response_format: "url",
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `xAI error: ${text}` };
      }

      const data = (await response.json()) as {
        data?: Array<{ url?: string; revised_prompt?: string }>;
      };
      const image = data.data?.[0];
      if (!image?.url) {
        return { success: false, error: "No image returned from xAI" };
      }

      return {
        success: true,
        data: {
          imageUrl: image.url,
          revisedPrompt: image.revised_prompt,
        },
      };
    });
  }
}

export class XAIVisionProvider implements VisionAnalysisProvider {
  name = "xai";
  private apiKey: string;
  private model: string;

  constructor(config: NonNullable<VisionConfig["xai"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "grok-2-vision-1212";
  }

  async analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    // xAI uses OpenAI-compatible API format
    const imageContent = options.imageBase64
      ? {
          type: "image_url" as const,
          image_url: { url: `data:image/jpeg;base64,${options.imageBase64}` },
        }
      : {
          type: "image_url" as const,
          image_url: { url: options.imageUrl ?? "" },
        };

    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        "https://api.x.ai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: options.maxTokens ?? 1024,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: options.prompt ?? "Describe this image in detail.",
                  },
                  imageContent,
                ],
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `xAI error: ${text}` };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const description = data.choices?.[0]?.message?.content;
      if (!description) {
        return { success: false, error: "No description returned from xAI" };
      }

      return {
        success: true,
        data: { description },
      };
    });
  }
}

// ============================================================================
// Anthropic Provider Implementation
// ============================================================================

// ============================================================================
// Ollama Provider Implementation (Local Vision)
// ============================================================================

class OllamaVisionProvider implements VisionAnalysisProvider {
  name = "ollama";
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private autoDownload: boolean;
  private modelChecked = false;

  constructor(config: NonNullable<VisionConfig["ollama"]>) {
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    this.model = config.model ?? "llava";
    this.maxTokens = config.maxTokens ?? 1024;
    this.autoDownload = config.autoDownload ?? true;
  }

  private async ensureModelAvailable(): Promise<void> {
    if (this.modelChecked) return;

    try {
      // Check if model exists
      const response = await fetchWithTimeout(
        `${this.baseUrl}/api/tags`,
        {},
        120_000,
      );
      if (!response.ok) {
        throw new Error(`Ollama server not reachable: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        models?: Array<{ name: string }>;
      };
      const models = data.models ?? [];
      const hasModel = models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`),
      );

      if (!hasModel && this.autoDownload) {
        console.log(
          `[ollama-vision] Model ${this.model} not found, downloading...`,
        );
        await this.downloadModel();
      } else if (!hasModel) {
        throw new Error(
          `Ollama model ${this.model} not found. Run 'ollama pull ${this.model}' or enable autoDownload.`,
        );
      }

      this.modelChecked = true;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("Ollama server not reachable")
      ) {
        throw err;
      }
      throw new Error(
        `Failed to check Ollama models: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async downloadModel(): Promise<void> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/pull`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.model, stream: false }),
      },
      300_000,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to download model ${this.model}: ${text}`);
    }

    // Wait for download to complete (non-streaming mode)
    await response.json();
    console.log(`[ollama-vision] Model ${this.model} downloaded successfully`);
  }

  async analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    try {
      await this.ensureModelAvailable();
    } catch (err) {
      return {
        success: false,
        error: `Ollama setup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Ollama uses a different format for vision - images must be base64
    let imageData = options.imageBase64;
    if (!imageData && options.imageUrl) {
      // Fetch the image and convert to base64
      try {
        const imageResponse = await fetchWithTimeout(
          options.imageUrl,
          {},
          120_000,
        );
        if (!imageResponse.ok) {
          return {
            success: false,
            error: `Failed to fetch image: ${imageResponse.statusText}`,
          };
        }
        const buffer = await imageResponse.arrayBuffer();
        imageData = Buffer.from(buffer).toString("base64");
      } catch (err) {
        return {
          success: false,
          error: `Failed to fetch image: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (!imageData) {
      return {
        success: false,
        error: "No image provided (imageUrl or imageBase64 required)",
      };
    }

    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages: [
              {
                role: "user",
                content: options.prompt ?? "Describe this image in detail.",
                images: [imageData],
              },
            ],
            stream: false,
            options: {
              num_predict: this.maxTokens,
            },
          }),
        },
        120_000,
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Ollama error: ${text}` };
      }

      const data = (await response.json()) as {
        message?: { content?: string };
      };
      const description = data.message?.content;
      if (!description) {
        return { success: false, error: "No description returned from Ollama" };
      }

      return {
        success: true,
        data: { description },
      };
    });
  }
}

// ============================================================================
// Anthropic Provider Implementation
// ============================================================================

export class AnthropicVisionProvider implements VisionAnalysisProvider {
  name = "anthropic";
  private apiKey: string;
  private model: string;

  constructor(config: NonNullable<VisionConfig["anthropic"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "claude-opus-4-7";
  }

  async analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    const imageSource = options.imageBase64
      ? {
          type: "base64" as const,
          media_type: "image/jpeg" as const,
          data: options.imageBase64,
        }
      : { type: "url" as const, url: options.imageUrl ?? "" };

    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: options.maxTokens ?? 1024,
            messages: [
              {
                role: "user",
                content: [
                  { type: "image", source: imageSource },
                  {
                    type: "text",
                    text: options.prompt ?? "Describe this image in detail.",
                  },
                ],
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Anthropic error: ${text}` };
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textBlock = data.content?.find((c) => c.type === "text");
      if (!textBlock?.text) {
        return {
          success: false,
          error: "No description returned from Anthropic",
        };
      }

      return {
        success: true,
        data: { description: textBlock.text },
      };
    });
  }
}

// ============================================================================
// FAL Audio Provider Implementation
// ============================================================================

export class FalAudioProvider implements AudioGenerationProvider {
  name = "fal";
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private secondsStart?: number;
  private secondsTotal?: number;
  private steps?: number;
  private timeoutMs: number;
  private extraInput?: Record<string, unknown>;

  constructor(config: NonNullable<AudioGenConfig["fal"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "fal-ai/stable-audio";
    this.baseUrl = config.baseUrl ?? "https://fal.run";
    this.secondsStart = config.secondsStart;
    this.secondsTotal = config.secondsTotal;
    this.steps = config.steps;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_AUDIO_TIMEOUT_MS;
    this.extraInput = config.extraInput;
  }

  async generate(
    options: AudioGenerationOptions,
  ): Promise<MediaProviderResult<AudioGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/${this.model}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Key ${this.apiKey}`,
          },
          body: JSON.stringify({
            ...(this.extraInput ?? {}),
            prompt: options.prompt,
            ...(this.secondsStart !== undefined
              ? { seconds_start: this.secondsStart }
              : {}),
            seconds_total:
              options.duration ??
              this.secondsTotal ??
              this.extraInput?.duration,
            ...(this.steps !== undefined ? { steps: this.steps } : {}),
          }),
        },
        this.timeoutMs,
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `FAL audio error: ${text}` };
      }

      const data = (await response.json()) as {
        audio?: { url?: string; content_type?: string; file_name?: string };
        audio_file?: {
          url?: string;
          content_type?: string;
          file_name?: string;
        };
        file?: { url?: string; content_type?: string; file_name?: string };
        url?: string;
        audio_url?: string;
        duration?: number;
      };
      const file = data.audio_file ?? data.audio ?? data.file;
      const audioUrl = file?.url ?? data.audio_url ?? data.url;
      if (!audioUrl) {
        return { success: false, error: "No audio returned from FAL" };
      }

      return {
        success: true,
        data: {
          audioUrl,
          mimeType: file?.content_type,
          fileName: file?.file_name,
          title: "Generated Audio",
          duration: data.duration ?? options.duration,
        },
      };
    });
  }
}

// ============================================================================
// ElevenLabs Audio Provider Implementation
// ============================================================================

export class ElevenLabsAudioProvider implements AudioGenerationProvider {
  name = "elevenlabs";
  private apiKey: string;
  private baseUrl: string;
  private config: NonNullable<AudioGenConfig["elevenlabs"]>;
  private timeoutMs: number;

  constructor(config: NonNullable<AudioGenConfig["elevenlabs"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io/v1";
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_AUDIO_TIMEOUT_MS;
  }

  async generate(
    options: AudioGenerationOptions,
  ): Promise<MediaProviderResult<AudioGenerationResult>> {
    const kind = normalizeAudioKind(options.audioKind ?? options.kind) ?? "sfx";
    switch (kind) {
      case "tts":
        return this.generateSpeech(options);
      case "music":
        return this.generateMusic(options);
      default:
        return this.generateSoundEffect(options);
    }
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "xi-api-key": this.apiKey,
    };
  }

  private async generateSoundEffect(
    options: AudioGenerationOptions,
  ): Promise<MediaProviderResult<AudioGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      const outputFormat = options.outputFormat ?? this.config.outputFormat;
      const response = await fetchWithTimeout(
        `${this.baseUrl}/sound-generation${buildOutputFormatQuery(outputFormat)}`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            text: options.prompt,
            ...(options.duration !== undefined ||
            this.config.duration !== undefined
              ? { duration_seconds: options.duration ?? this.config.duration }
              : {}),
            ...(options.promptInfluence !== undefined ||
            this.config.promptInfluence !== undefined
              ? {
                  prompt_influence:
                    options.promptInfluence ?? this.config.promptInfluence,
                }
              : {}),
            ...(options.loop !== undefined || this.config.loop !== undefined
              ? { loop: options.loop ?? this.config.loop }
              : {}),
            ...(options.seed !== undefined || this.config.seed !== undefined
              ? { seed: options.seed ?? this.config.seed }
              : {}),
            model_id:
              options.modelId ??
              this.config.sfxModelId ??
              this.config.modelId ??
              "eleven_text_to_sound_v2",
          }),
        },
        this.timeoutMs,
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `ElevenLabs SFX error: ${text}` };
      }

      return {
        success: true,
        data: await responseToAudioResult(
          response,
          "Generated Sound Effect",
          options.duration ?? this.config.duration,
        ),
      };
    });
  }

  private async generateMusic(
    options: AudioGenerationOptions,
  ): Promise<MediaProviderResult<AudioGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      const outputFormat = options.outputFormat ?? this.config.outputFormat;
      const prompt = options.genre
        ? `${options.prompt}\nGenre: ${options.genre}`
        : options.prompt;
      const response = await fetchWithTimeout(
        `${this.baseUrl}/music${buildOutputFormatQuery(outputFormat)}`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            prompt,
            ...(options.duration
              ? { music_length_ms: Math.round(options.duration * 1000) }
              : {}),
            ...(options.instrumental !== undefined
              ? { force_instrumental: options.instrumental }
              : {}),
            ...(options.seed !== undefined || this.config.seed !== undefined
              ? { seed: options.seed ?? this.config.seed }
              : {}),
            ...(this.config.signWithC2pa !== undefined
              ? { sign_with_c2pa: this.config.signWithC2pa }
              : {}),
            model_id:
              options.modelId ??
              this.config.musicModelId ??
              this.config.modelId ??
              "music_v1",
          }),
        },
        this.timeoutMs,
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `ElevenLabs music error: ${text}` };
      }

      return {
        success: true,
        data: await responseToAudioResult(
          response,
          "Generated Music",
          options.duration,
        ),
      };
    });
  }

  private async generateSpeech(
    options: AudioGenerationOptions,
  ): Promise<MediaProviderResult<AudioGenerationResult>> {
    const voiceId = options.voiceId ?? this.config.voiceId;
    if (!voiceId) {
      return {
        success: false,
        error: "ElevenLabs TTS requires a voiceId in config or request options",
      };
    }

    return withProviderErrorBoundary(this.name, async () => {
      const outputFormat = options.outputFormat ?? this.config.outputFormat;
      const response = await fetchWithTimeout(
        `${this.baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}${buildOutputFormatQuery(outputFormat)}`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            text: options.text ?? options.prompt,
            model_id:
              options.modelId ??
              this.config.ttsModelId ??
              this.config.modelId ??
              "eleven_multilingual_v2",
            ...(options.languageCode !== undefined ||
            this.config.languageCode !== undefined
              ? {
                  language_code:
                    options.languageCode ?? this.config.languageCode,
                }
              : {}),
            ...(options.voiceSettings !== undefined ||
            this.config.voiceSettings !== undefined
              ? {
                  voice_settings:
                    options.voiceSettings ?? this.config.voiceSettings,
                }
              : {}),
            ...(options.seed !== undefined || this.config.seed !== undefined
              ? { seed: options.seed ?? this.config.seed }
              : {}),
            ...(this.config.applyTextNormalization
              ? {
                  apply_text_normalization: this.config.applyTextNormalization,
                }
              : {}),
          }),
        },
        this.timeoutMs,
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `ElevenLabs TTS error: ${text}` };
      }

      return {
        success: true,
        data: await responseToAudioResult(response, "Generated Speech"),
      };
    });
  }
}

// ============================================================================
// Suno Provider Implementation
// ============================================================================

export class SunoAudioProvider implements AudioGenerationProvider {
  name = "suno";
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: NonNullable<AudioGenConfig["suno"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "chirp-v3.5";
    this.baseUrl = config.baseUrl ?? "https://api.suno.ai/v1";
  }

  async generate(
    options: AudioGenerationOptions,
  ): Promise<MediaProviderResult<AudioGenerationResult>> {
    return withProviderErrorBoundary(this.name, async () => {
      const response = await fetchWithTimeout(`${this.baseUrl}/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          prompt: options.prompt,
          model: this.model,
          duration: options.duration,
          instrumental: options.instrumental,
          genre: options.genre,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Suno error: ${text}` };
      }

      const data = (await response.json()) as {
        audio_url?: string;
        title?: string;
        duration?: number;
      };

      return {
        success: true,
        data: {
          audioUrl: data.audio_url,
          title: data.title,
          duration: data.duration,
        },
      };
    });
  }
}

// ============================================================================
// Provider Factories
// ============================================================================

export interface MediaProviderFactoryOptions {
  elizaCloudBaseUrl?: string;
  elizaCloudApiKey?: string;
  /** When true, factories will NOT fall back to ElizaCloud providers. */
  cloudMediaDisabled?: boolean;
}

export function createImageProvider(
  config: ImageConfig | undefined,
  options: MediaProviderFactoryOptions,
): ImageGenerationProvider {
  const mode = config?.mode ?? (options.cloudMediaDisabled ? "local" : "cloud");
  const provider = mode === "cloud" ? "cloud" : (config?.provider ?? "cloud");

  switch (provider) {
    case "fal":
      if (config?.fal?.apiKey) {
        return new FalImageProvider(config.fal);
      }
      break;
    case "openai":
      if (config?.openai?.apiKey) {
        return new OpenAIImageProvider(config.openai);
      }
      break;
    case "google":
      if (config?.google?.apiKey) {
        return new GoogleImageProvider(config.google);
      }
      break;
    case "xai":
      if (config?.xai?.apiKey) {
        return new XAIImageProvider(config.xai);
      }
      break;
  }

  if (options.cloudMediaDisabled) {
    throw new Error(
      "No image provider configured and cloud media is disabled. " +
        "Configure a direct provider (fal, openai, google, xai) or enable cloud media.",
    );
  }
  return new ElizaCloudImageProvider(
    options.elizaCloudBaseUrl ?? "https://elizacloud.ai/api/v1",
    options.elizaCloudApiKey,
  );
}

export function createVideoProvider(
  config: VideoConfig | undefined,
  options: MediaProviderFactoryOptions,
): VideoGenerationProvider {
  const mode = config?.mode ?? (options.cloudMediaDisabled ? "local" : "cloud");
  const provider = mode === "cloud" ? "cloud" : (config?.provider ?? "cloud");

  switch (provider) {
    case "fal":
      if (config?.fal?.apiKey) {
        return new FalVideoProvider(config.fal);
      }
      break;
    case "openai":
      if (config?.openai?.apiKey) {
        return new OpenAIVideoProvider(config.openai);
      }
      break;
    case "google":
      if (config?.google?.apiKey) {
        return new GoogleVideoProvider(config.google);
      }
      break;
  }

  if (options.cloudMediaDisabled) {
    throw new Error(
      "No video provider configured and cloud media is disabled. " +
        "Configure a direct provider (fal, openai, google) or enable cloud media.",
    );
  }
  return new ElizaCloudVideoProvider(
    options.elizaCloudBaseUrl ?? "https://elizacloud.ai/api/v1",
    options.elizaCloudApiKey,
  );
}

function hasUsableDirectAudioProvider(config: AudioGenConfig | undefined) {
  return !!(
    config?.suno?.apiKey ||
    config?.elevenlabs?.apiKey ||
    config?.fal?.apiKey
  );
}

function getConfiguredAudioProvider(
  config: AudioGenConfig | undefined,
  kind: AudioKind,
): AudioGenProvider | undefined {
  return (
    config?.providers?.[kind] ?? config?.providers?.default ?? config?.provider
  );
}

function getAutoAudioProvider(
  config: AudioGenConfig | undefined,
  kind: AudioKind,
): AudioGenProvider | undefined {
  if (kind === "music") {
    if (config?.suno?.apiKey) return "suno";
    if (config?.elevenlabs?.apiKey) return "elevenlabs";
    if (config?.fal?.apiKey) return "fal";
    return undefined;
  }

  if (config?.elevenlabs?.apiKey) return "elevenlabs";
  if (config?.fal?.apiKey) return "fal";
  return undefined;
}

function missingAudioProviderError(kind: AudioKind): string {
  return (
    `No ${kind} audio provider configured and cloud media is disabled. ` +
    "Configure a direct provider (suno, elevenlabs, fal) or enable cloud media."
  );
}

class RoutedAudioProvider implements AudioGenerationProvider {
  name = "audio-router";
  private config?: AudioGenConfig;
  private options: MediaProviderFactoryOptions;

  constructor(
    config: AudioGenConfig | undefined,
    options: MediaProviderFactoryOptions,
  ) {
    this.config = config;
    this.options = options;
  }

  async generate(
    options: AudioGenerationOptions,
  ): Promise<MediaProviderResult<AudioGenerationResult>> {
    const kind = getAudioKind(options, this.config);
    const providerName =
      getConfiguredAudioProvider(this.config, kind) ??
      getAutoAudioProvider(this.config, kind) ??
      "cloud";

    if (providerName === "cloud") {
      if (this.options.cloudMediaDisabled) {
        return { success: false, error: missingAudioProviderError(kind) };
      }
      return createCloudAudioProvider(this.options).generate({
        ...options,
        kind,
      });
    }

    try {
      switch (providerName) {
        case "suno":
          if (!this.config?.suno?.apiKey) break;
          if (kind !== "music") {
            return {
              success: false,
              error: "Suno audio generation only supports music requests",
            };
          }
          return new SunoAudioProvider(this.config.suno).generate({
            ...options,
            kind,
          });
        case "elevenlabs":
          if (!this.config?.elevenlabs?.apiKey) break;
          return new ElevenLabsAudioProvider(this.config.elevenlabs).generate({
            ...options,
            kind,
          });
        case "fal":
          if (!this.config?.fal?.apiKey) break;
          return new FalAudioProvider(this.config.fal).generate({
            ...options,
            kind,
          });
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (this.options.cloudMediaDisabled) {
      return { success: false, error: missingAudioProviderError(kind) };
    }

    return createCloudAudioProvider(this.options).generate({
      ...options,
      kind,
    });
  }
}

export function createAudioProvider(
  config: AudioGenConfig | undefined,
  options: MediaProviderFactoryOptions,
): AudioGenerationProvider {
  const mode =
    config?.mode ?? (options.cloudMediaDisabled ? "own-key" : "cloud");

  if (mode === "cloud") {
    if (options.cloudMediaDisabled) {
      throw new Error(
        "Audio media is configured for cloud mode but cloud media is disabled.",
      );
    }
    return createCloudAudioProvider(options);
  }

  if (options.cloudMediaDisabled && !hasUsableDirectAudioProvider(config)) {
    throw new Error(
      "No audio provider configured and cloud media is disabled. " +
        "Configure a direct provider (suno, elevenlabs, fal) or enable cloud media.",
    );
  }

  return new RoutedAudioProvider(config, options);
}

export function createVisionProvider(
  config: VisionConfig | undefined,
  options: MediaProviderFactoryOptions,
): VisionAnalysisProvider {
  const mode = config?.mode ?? (options.cloudMediaDisabled ? "local" : "cloud");
  const provider = mode === "cloud" ? "cloud" : (config?.provider ?? "cloud");

  switch (provider) {
    case "openai":
      if (config?.openai?.apiKey) {
        return new OpenAIVisionProvider(config.openai);
      }
      break;
    case "google":
      if (config?.google?.apiKey) {
        return new GoogleVisionProvider(config.google);
      }
      break;
    case "anthropic":
      if (config?.anthropic?.apiKey) {
        return new AnthropicVisionProvider(config.anthropic);
      }
      break;
    case "xai":
      if (config?.xai?.apiKey) {
        return new XAIVisionProvider(config.xai);
      }
      break;
    case "ollama":
      // Ollama doesn't require an API key, just a base URL
      return new OllamaVisionProvider(config?.ollama ?? {});
  }

  if (options.cloudMediaDisabled) {
    throw new Error(
      "No vision provider configured and cloud media is disabled. " +
        "Configure a direct provider (openai, google, anthropic, xai, ollama) or enable cloud media.",
    );
  }
  return new ElizaCloudVisionProvider(
    options.elizaCloudBaseUrl ?? "https://elizacloud.ai/api/v1",
    options.elizaCloudApiKey,
  );
}

// ============================================================================
// Convenience function to create all providers from MediaConfig
// ============================================================================

export interface MediaProviders {
  image: ImageGenerationProvider;
  video: VideoGenerationProvider;
  audio: AudioGenerationProvider;
  vision: VisionAnalysisProvider;
}

export function createMediaProviders(
  config: MediaConfig | undefined,
  options: MediaProviderFactoryOptions,
): MediaProviders {
  return {
    image: createImageProvider(config?.image, options),
    video: createVideoProvider(config?.video, options),
    audio: createAudioProvider(config?.audio, options),
    vision: createVisionProvider(config?.vision, options),
  };
}

/** Contracts and transport helpers for explicitly configured direct media providers. */
import type { AudioGenConfig, AudioKind } from "@elizaos/contracts";
import { isElizaError } from "@elizaos/core/protocol";

export interface MediaProviderResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
  errorContext?: Record<string, unknown>;
}

export interface MediaImageGenerationResult {
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
  signal?: AbortSignal;
  prompt: string;
  size?: string;
  quality?: "standard" | "hd";
  style?: "natural" | "vivid";
  negativePrompt?: string;
  seed?: number;
}

export interface VideoGenerationOptions {
  signal?: AbortSignal;
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  imageUrl?: string;
}

export interface AudioGenerationOptions {
  signal?: AbortSignal;
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
  signal?: AbortSignal;
  imageUrl?: string;
  imageBase64?: string;
  prompt?: string;
  maxTokens?: number;
}

type VisionImageInput =
  | { type: "base64"; value: string }
  | { type: "url"; value: string };

export function resolveVisionImageInput(
  providerName: string,
  options: VisionAnalysisOptions,
): VisionImageInput | MediaProviderResult<VisionAnalysisResult> {
  const imageBase64 = options.imageBase64?.trim();
  if (imageBase64) {
    return { type: "base64", value: imageBase64 };
  }
  const imageUrl = options.imageUrl?.trim();
  if (imageUrl) {
    return { type: "url", value: imageUrl };
  }
  return {
    success: false,
    error: `[${providerName}] imageUrl or imageBase64 is required`,
  };
}

export function isMediaProviderResult<T>(
  value: VisionImageInput | MediaProviderResult<T>,
): value is MediaProviderResult<T> {
  return "success" in value;
}

// ============================================================================
// Provider Interfaces
// ============================================================================

export interface ImageGenerationProvider {
  name: string;
  generate(
    options: ImageGenerationOptions,
  ): Promise<MediaProviderResult<MediaImageGenerationResult>>;
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

export function fetchMediaProviderResponse(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  if (timeoutMs === undefined) return fetch(url, init);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadline])
    : deadline;
  return fetch(url, { ...init, signal });
}
export async function withMediaProviderErrorBoundary<T>(
  providerName: string,
  run: () => Promise<MediaProviderResult<T>>,
): Promise<MediaProviderResult<T>> {
  try {
    return await run();
  } catch (err) {
    // error-policy:J1 provider boundary returns an explicit failed result.
    const message = err instanceof Error ? err.message : String(err);
    const structuredError = isElizaError(err) ? err : undefined;
    return {
      success: false,
      error: `[${providerName}] ${structuredError ? message : `Network error: ${message}`}`,
      ...(structuredError
        ? {
            errorCode: structuredError.code,
            errorContext: structuredError.context,
          }
        : {}),
    };
  }
}

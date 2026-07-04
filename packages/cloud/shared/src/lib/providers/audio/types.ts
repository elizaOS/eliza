// Defines cloud shared types behavior for backend service consumers.
import type { PricingBillingSource } from "../../services/ai-pricing-definitions";

export type AudioGenerationKind = "music" | "sfx";

export interface AudioGenRequest {
  kind: AudioGenerationKind;
  model: string;
  prompt: string;
  lyrics?: string;
  lyricsOptimizer?: boolean;
  instrumental?: boolean;
  durationSeconds?: number;
  /** Reference audio URL for style/continuation models. */
  referenceUrl?: string;
  seed?: number;
  outputFormat?: string;
  /** 0..1 — how literally SFX models should follow the prompt. */
  promptInfluence?: number;
  audioSettings?: {
    format?: string;
    sampleRate?: string;
    bitrate?: string;
  };
  extraInput?: Record<string, unknown>;
  apiKeys: Record<string, string | undefined>;
}

/**
 * Providers either return a URL the upstream hosts (fal CDN, suno) or the raw
 * bytes (ElevenLabs streams the file body). Storage of byte results is the
 * route's job — providers never touch R2.
 */
export type GeneratedAudio =
  | {
      source: "hosted";
      url: string;
      fileName?: string;
      fileSize?: number;
      contentType?: string;
      requestId?: string;
      status?: string;
      raw?: Record<string, unknown>;
    }
  | {
      source: "bytes";
      bytes: Uint8Array;
      contentType: string;
      requestId?: string;
      raw?: Record<string, unknown>;
    };

export interface AudioProvider {
  billingSource: PricingBillingSource;
  generate(req: AudioGenRequest): Promise<GeneratedAudio>;
}

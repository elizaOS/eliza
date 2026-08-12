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

/**
 * Upstream job state as verified against the provider's status API.
 * `failed` means a TERMINAL failure (or unknown job) — the only state where
 * refunding the credit hold is safe.
 */
export type AudioJobStatus =
  | { state: "pending" }
  | { state: "succeeded"; result: GeneratedAudio }
  | { state: "failed"; error: string };

export interface AudioJobStatusRequest {
  model: string;
  requestId: string;
  apiKeys: Record<string, string | undefined>;
}

/**
 * Thrown when an upstream audio job was enqueued but its terminal state could
 * not be determined within the sync poll window (timeout / probe failure).
 * The upstream render may still complete and bill the platform, so the route
 * must NOT refund the credit hold (#18436) — it persists a pending generation
 * carrying {@link AudioPendingSettlement} and the reconcile sweep
 * (`/api/cron/reconcile-music-generations`) verifies the terminal state.
 */
export class AudioGenerationPendingError extends Error {
  readonly requestId: string;

  constructor(requestId: string, message: string) {
    super(message);
    this.name = "AudioGenerationPendingError";
    this.requestId = requestId;
  }
}

/** Marks a generation row's metadata as awaiting upstream music settlement. */
export const MUSIC_PENDING_SETTLEMENT_MARKER = "music_pending_settlement_v1";

/**
 * Settlement payload stored on `generations.metadata` when a music request
 * timed out with the upstream job still live.
 */
export interface AudioPendingSettlement {
  settlement_marker: typeof MUSIC_PENDING_SETTLEMENT_MARKER;
  reservation_transaction_id: string;
  reserved_amount: number;
  billed_cost: number;
  billing_source: string;
}

export interface AudioProvider {
  billingSource: PricingBillingSource;
  generate(req: AudioGenRequest): Promise<GeneratedAudio>;
  /**
   * Verifies the upstream state of an enqueued job. Must only report
   * `failed` when the provider says the job is terminally failed/unknown;
   * transport failures must throw so the caller keeps the credit hold.
   * Optional — providers without a queue status API cannot participate in
   * pending settlement.
   */
  getJobStatus?(req: AudioJobStatusRequest): Promise<AudioJobStatus>;
}

// Defines cloud shared types behavior for backend service consumers.
import type { PricingBillingSource } from "../../services/ai-pricing-definitions";

export interface VideoGenerationRequest {
  model: string;
  prompt: string;
  referenceUrl?: string;
  durationSeconds?: number;
  resolution?: string;
  audio?: boolean;
  voiceControl?: boolean;
  apiKeys: Record<string, string | undefined>;
}

export interface GeneratedVideoObject {
  url: string;
  width?: number;
  height?: number;
  file_name?: string;
  file_size?: number;
  content_type?: string;
}

export interface GeneratedVideo {
  requestId?: string;
  video: GeneratedVideoObject;
  seed?: number;
  timings?: Record<string, number> | null;
  hasNsfwConcepts?: boolean[];
}

/**
 * Upstream job state as verified against the provider's status API.
 * `failed` means the provider reported a TERMINAL failure (or does not know
 * the job) — the only states in which refunding the credit hold is safe.
 */
export type VideoJobStatus =
  | { state: "pending" }
  | { state: "succeeded"; result: GeneratedVideo }
  | { state: "failed"; error: string };

export interface VideoJobStatusRequest {
  model: string;
  requestId: string;
  apiKeys: Record<string, string | undefined>;
}

/**
 * Thrown by a provider when an upstream video job was enqueued but its
 * terminal state could not be determined (poll timeout, poll transport
 * failure). The upstream render may still complete and bill the platform, so
 * the route must NOT refund the credit hold (#11862) — it persists a pending
 * generation carrying {@link VideoPendingSettlement} and the reconcile sweep
 * (`/api/cron/reconcile-video-generations`) verifies the upstream terminal
 * state before settling (late success → charge stands) or refunding.
 */
export class VideoGenerationPendingError extends Error {
  readonly requestId: string;

  constructor(requestId: string, message: string) {
    super(message);
    this.name = "VideoGenerationPendingError";
    this.requestId = requestId;
  }
}

/** Marks a generation row's metadata as awaiting upstream settlement. */
export const VIDEO_PENDING_SETTLEMENT_MARKER = "video_pending_settlement_v1";

/**
 * Settlement payload stored on `generations.metadata` when a video request
 * timed out with the upstream job still live. The reconcile sweep reads it to
 * settle the credit hold once the job reaches a terminal state.
 */
export interface VideoPendingSettlement {
  settlement_marker: typeof VIDEO_PENDING_SETTLEMENT_MARKER;
  reservation_transaction_id: string;
  reserved_amount: number;
  billed_cost: number;
  billing_source: string;
}

export interface VideoProvider {
  billingSource: PricingBillingSource;
  isConfigured?(apiKeys: Record<string, string | undefined>): boolean;
  generate(req: VideoGenerationRequest): Promise<GeneratedVideo>;
  /**
   * Verifies the upstream state of an enqueued job. Must only report
   * `failed` when the provider says the job is terminally failed/unknown;
   * transport failures must throw so the caller keeps the credit hold.
   */
  getJobStatus(req: VideoJobStatusRequest): Promise<VideoJobStatus>;
  healthCheck?(): Promise<boolean>;
}

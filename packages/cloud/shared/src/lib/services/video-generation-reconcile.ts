/**
 * Settles video generations whose upstream job outlived the route's poll
 * window (#11862). The generate-video route keeps the credit hold open on a
 * poll timeout (refunding while the render may still complete upstream is a
 * per-transaction platform loss) and persists a pending generation carrying
 * the settlement payload. This sweep verifies the upstream terminal state:
 *
 *  - succeeded → the charge stands (the hold is settled at the billed cost)
 *    and the generation is completed with the delivered video;
 *  - failed / unknown to the provider → the hold is refunded exactly once
 *    (reconcile is idempotent on the reservation row's settled_at claim +
 *    the `recon:<txid>:refund` key) and the generation is marked failed;
 *  - still pending → left for the next tick, until the reconcile deadline,
 *    after which the verified-non-terminal job is refunded (bounded loss);
 *  - status probe fails → nothing moves: the state is unknown, so the hold
 *    is never refunded blind. The stranded-reservation sweep (#11493, ~2h
 *    grace) remains the platform-safe backstop that settles the hold at the
 *    estimated cost if this sweep can never reach the provider.
 */

import { type Generation, generationsRepository } from "../../db/repositories/generations";
import { findVideoProvider } from "../providers/video/registry";
import {
  VIDEO_PENDING_SETTLEMENT_MARKER,
  type VideoJobStatus,
  type VideoPendingSettlement,
} from "../providers/video/types";
import { logger } from "../utils/logger";
import { creditsService } from "./credits";

/**
 * How long a pending video may stay non-terminal upstream before the sweep
 * refunds it. Renders finish in minutes; a job still IN_QUEUE/IN_PROGRESS an
 * hour later is dead upstream. Must stay well below the generic
 * stranded-reservation sweep grace (~2h) so this sweep decides first.
 */
export const VIDEO_PENDING_SETTLEMENT_DEADLINE_MS = 60 * 60 * 1000;

export interface VideoReconcileStats {
  scanned: number;
  charged: number;
  refunded: number;
  expired: number;
  stillPending: number;
  skipped: number;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function parseVideoPendingSettlement(
  metadata: Record<string, unknown> | null,
): VideoPendingSettlement | null {
  if (!metadata || metadata.settlement_marker !== VIDEO_PENDING_SETTLEMENT_MARKER) {
    return null;
  }
  const reservationTransactionId = metadataString(metadata.reservation_transaction_id);
  const reservedAmount = metadataNumber(metadata.reserved_amount);
  const billedCost = metadataNumber(metadata.billed_cost);
  const billingSource = metadataString(metadata.billing_source);
  if (
    !reservationTransactionId ||
    reservedAmount === undefined ||
    billedCost === undefined ||
    !billingSource
  ) {
    return null;
  }
  return {
    settlement_marker: VIDEO_PENDING_SETTLEMENT_MARKER,
    reservation_transaction_id: reservationTransactionId,
    reserved_amount: reservedAmount,
    billed_cost: billedCost,
    billing_source: billingSource,
  };
}

async function settleHold(
  generation: Generation,
  settlement: VideoPendingSettlement,
  actualCost: number,
): Promise<void> {
  await creditsService.reconcile({
    organizationId: generation.organization_id,
    reservedAmount: settlement.reserved_amount,
    actualCost,
    description: `Video generation: ${generation.model}`,
    metadata: {
      ...(generation.user_id ? { user_id: generation.user_id } : {}),
      reservation_transaction_id: settlement.reservation_transaction_id,
      model: generation.model,
      settlement_source: "video_pending_reconcile",
    },
  });
}

async function markFailed(
  generation: Generation,
  settlementState: "refunded" | "refunded_expired",
  error: string,
): Promise<void> {
  await generationsRepository.update(generation.id, {
    status: "failed",
    error,
    metadata: { ...generation.metadata, settlement_state: settlementState },
  });
}

export async function reconcilePendingVideoGenerations(params: {
  apiKeys: Record<string, string | undefined>;
  deadlineMs?: number;
  batchSize?: number;
}): Promise<VideoReconcileStats> {
  const deadlineMs = params.deadlineMs ?? VIDEO_PENDING_SETTLEMENT_DEADLINE_MS;
  const stats: VideoReconcileStats = {
    scanned: 0,
    charged: 0,
    refunded: 0,
    expired: 0,
    stillPending: 0,
    skipped: 0,
  };

  const pending = await generationsRepository.listPendingVideoSettlements(params.batchSize ?? 50);
  stats.scanned = pending.length;

  for (const generation of pending) {
    const settlement = parseVideoPendingSettlement(generation.metadata);
    if (!settlement || !generation.job_id) {
      stats.skipped++;
      logger.error("[VideoReconcile] Pending video generation has no usable settlement payload", {
        generationId: generation.id,
        organizationId: generation.organization_id,
        jobId: generation.job_id,
      });
      continue;
    }

    const provider = findVideoProvider(settlement.billing_source);
    if (!provider) {
      stats.skipped++;
      logger.error("[VideoReconcile] No video provider registered for pending settlement", {
        generationId: generation.id,
        billingSource: settlement.billing_source,
      });
      continue;
    }

    let job: VideoJobStatus;
    try {
      job = await provider.getJobStatus({
        model: generation.model,
        requestId: generation.job_id,
        apiKeys: params.apiKeys,
      });
    } catch (error) {
      // Upstream state unknown — never refund blind. The hold stays for the
      // next tick; the stranded-reservation sweep is the eventual backstop.
      stats.skipped++;
      logger.warn("[VideoReconcile] Upstream status probe failed; keeping hold", {
        generationId: generation.id,
        jobId: generation.job_id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (job.state === "succeeded") {
      await settleHold(generation, settlement, settlement.billed_cost);
      await generationsRepository.update(generation.id, {
        status: "completed",
        storage_url: job.result.video.url,
        thumbnail_url: job.result.video.url,
        file_size: job.result.video.file_size ? BigInt(job.result.video.file_size) : undefined,
        mime_type: job.result.video.content_type ?? "video/mp4",
        result: {
          requestId: job.result.requestId ?? generation.job_id,
          seed: job.result.seed,
          timings: job.result.timings,
          billingSource: settlement.billing_source,
          settledLate: true,
        },
        metadata: { ...generation.metadata, settlement_state: "charged" },
        completed_at: new Date(),
      });
      stats.charged++;
      logger.info("[VideoReconcile] Late upstream success — charge stands", {
        generationId: generation.id,
        organizationId: generation.organization_id,
        billedCost: settlement.billed_cost,
      });
      continue;
    }

    if (job.state === "failed") {
      await settleHold(generation, settlement, 0);
      await markFailed(generation, "refunded", job.error);
      stats.refunded++;
      logger.info("[VideoReconcile] Verified upstream failure — hold refunded", {
        generationId: generation.id,
        organizationId: generation.organization_id,
        error: job.error,
      });
      continue;
    }

    const ageMs = Date.now() - generation.created_at.getTime();
    if (ageMs < deadlineMs) {
      stats.stillPending++;
      continue;
    }

    // Verified non-terminal past the deadline: the render is presumed dead
    // upstream. Refund once (bounded loss if it somehow completes later).
    await settleHold(generation, settlement, 0);
    await markFailed(
      generation,
      "refunded_expired",
      "Video generation never reached a terminal upstream state before the reconcile deadline",
    );
    stats.expired++;
    logger.warn("[VideoReconcile] Pending video expired past deadline — hold refunded", {
      generationId: generation.id,
      organizationId: generation.organization_id,
      ageMs,
    });
  }

  return stats;
}

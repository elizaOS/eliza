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
 *
 * The "refunded exactly once" guarantee holds even when that stale sweep
 * settled the hold at full cost BEFORE this sweep verified the terminal state:
 * `reconcile` can no longer move the refund on a settled row, so this sweep
 * issues a compensating refund under the same `recon:<txid>:refund` key
 * (`ensureHoldRefunded`) — otherwise a verified failure would be charged full
 * price while the ledger falsely claimed a refund (#11942).
 */

import { type Generation, generationsRepository } from "../../db/repositories/generations";
import { findVideoProvider } from "../providers/video/registry";
import {
  VIDEO_PENDING_SETTLEMENT_MARKER,
  type VideoJobStatus,
  type VideoPendingSettlement,
} from "../providers/video/types";
import { logger } from "../utils/logger";
import { type CreditReconciliationResult, creditsService } from "./credits";

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
): Promise<CreditReconciliationResult> {
  return await creditsService.reconcile({
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

/**
 * Guarantees the hold for a dead render is refunded exactly once — even when the
 * generic stranded-reservation sweep (#11493) beat this sweep to the
 * reservation and settled it at full estimated cost.
 *
 * Once the reservation row carries `settled_at`, `creditsService.reconcile` is a
 * no-op (`adjustmentType: 'none'`) and its keyed refund lane is unreachable, so
 * `settleHold(…, 0)` alone leaves the org charged full price for a render we
 * have now determined died upstream — while `markFailed` would still stamp a
 * `settlement_state='refunded'` the ledger never backed (#11942). When
 * `settleHold` could not move the refund itself, issue the compensating refund
 * under the SAME idempotency key the reconcile refund lane uses
 * (`recon:<reservationTxId>:refund`). `applyCreditIncrease` dedupes on that key
 * (`ON CONFLICT DO NOTHING`), so the refund fires exactly once across the normal
 * path, the stale-sweep path, crash-retries, and concurrent sweeps — the
 * "refund exactly once" invariant now holds regardless of which sweep wins the
 * race, instead of silently degrading to "refund zero times".
 */
async function ensureHoldRefunded(
  generation: Generation,
  settlement: VideoPendingSettlement,
  reconciliation: CreditReconciliationResult,
): Promise<void> {
  if (reconciliation.adjustmentType === "refund") {
    // settleHold refunded through the reservation lane under the same key.
    return;
  }
  await creditsService.refundCredits({
    organizationId: generation.organization_id,
    amount: settlement.reserved_amount,
    description: `Video generation: ${generation.model} (verified-failure refund)`,
    metadata: {
      ...(generation.user_id ? { user_id: generation.user_id } : {}),
      reservation_transaction_id: settlement.reservation_transaction_id,
      model: generation.model,
      settlement_source: "video_pending_reconcile_stale_sweep_compensation",
    },
    stripePaymentIntentId: `recon:${settlement.reservation_transaction_id}:refund`,
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
      // error-policy:J1 provider status-probe transport boundary — a probe
      // failure means the upstream state is UNKNOWN, which must stay distinct
      // from a verified failed/succeeded terminal state. Translate it into a
      // per-item "skipped" outcome so one unreachable probe never aborts the
      // batch and, critically, never refunds blind. The failure surfaces via
      // the warn below; the hold is retained for the next tick, with the
      // stranded-reservation sweep (#11493) as the eventual backstop.
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
      const reconciliation = await settleHold(generation, settlement, 0);
      await ensureHoldRefunded(generation, settlement, reconciliation);
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
    // upstream. Refund once (bounded loss if it somehow completes later). The
    // outcome must not hinge on whether the stale sweep settled first, so the
    // compensating refund keeps this branch's "refund once" promise honest too.
    const reconciliation = await settleHold(generation, settlement, 0);
    await ensureHoldRefunded(generation, settlement, reconciliation);
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

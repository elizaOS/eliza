/**
 * Settles music generations whose upstream job outlived the route's poll
 * window (#18436). Mirrors video-generation-reconcile (#11862): the generate-
 * music route keeps the credit hold open on a poll timeout and persists a
 * pending generation carrying the settlement payload. This sweep verifies the
 * upstream terminal state:
 *
 *  - succeeded → charge stands and the generation is completed with the audio;
 *  - failed / unknown → hold refunded exactly once and generation marked failed;
 *  - still pending → left for the next tick until the reconcile deadline;
 *  - status probe fails → hold retained (never refund blind).
 */

import { type Generation, generationsRepository } from "../../db/repositories/generations";
import { findAudioProvider } from "../providers/audio/registry";
import {
  type AudioJobStatus,
  type AudioPendingSettlement,
  MUSIC_PENDING_SETTLEMENT_MARKER,
} from "../providers/audio/types";
import { logger } from "../utils/logger";
import { type CreditReconciliationResult, creditsService } from "./credits";

/**
 * How long a pending music job may stay non-terminal upstream before the sweep
 * refunds it. Must stay well below the generic stranded-reservation sweep grace
 * (~2h) so this sweep decides first.
 */
export const MUSIC_PENDING_SETTLEMENT_DEADLINE_MS = 60 * 60 * 1000;

export interface MusicReconcileStats {
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

export function parseMusicPendingSettlement(
  metadata: Record<string, unknown> | null,
): AudioPendingSettlement | null {
  if (!metadata || metadata.settlement_marker !== MUSIC_PENDING_SETTLEMENT_MARKER) {
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
    settlement_marker: MUSIC_PENDING_SETTLEMENT_MARKER,
    reservation_transaction_id: reservationTransactionId,
    reserved_amount: reservedAmount,
    billed_cost: billedCost,
    billing_source: billingSource,
  };
}

async function settleHold(
  generation: Generation,
  settlement: AudioPendingSettlement,
  actualCost: number,
): Promise<CreditReconciliationResult> {
  return await creditsService.reconcile({
    organizationId: generation.organization_id,
    reservedAmount: settlement.reserved_amount,
    actualCost,
    description: `Music generation: ${generation.model}`,
    metadata: {
      ...(generation.user_id ? { user_id: generation.user_id } : {}),
      reservation_transaction_id: settlement.reservation_transaction_id,
      model: generation.model,
      settlement_source: "music_pending_reconcile",
    },
  });
}

async function ensureHoldRefunded(
  generation: Generation,
  settlement: AudioPendingSettlement,
  reconciliation: CreditReconciliationResult,
): Promise<void> {
  if (reconciliation.adjustmentType === "refund") {
    return;
  }
  await creditsService.refundCredits({
    organizationId: generation.organization_id,
    amount: settlement.reserved_amount,
    description: `Music generation: ${generation.model} (verified-failure refund)`,
    metadata: {
      ...(generation.user_id ? { user_id: generation.user_id } : {}),
      reservation_transaction_id: settlement.reservation_transaction_id,
      model: generation.model,
      settlement_source: "music_pending_reconcile_stale_sweep_compensation",
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

export async function reconcilePendingMusicGenerations(params: {
  apiKeys: Record<string, string | undefined>;
  deadlineMs?: number;
  batchSize?: number;
}): Promise<MusicReconcileStats> {
  const deadlineMs = params.deadlineMs ?? MUSIC_PENDING_SETTLEMENT_DEADLINE_MS;
  const stats: MusicReconcileStats = {
    scanned: 0,
    charged: 0,
    refunded: 0,
    expired: 0,
    stillPending: 0,
    skipped: 0,
  };

  const pending = await generationsRepository.listPendingMusicSettlements(params.batchSize ?? 50);
  stats.scanned = pending.length;

  for (const generation of pending) {
    const settlement = parseMusicPendingSettlement(generation.metadata);
    if (!settlement || !generation.job_id) {
      stats.skipped++;
      logger.error("[MusicReconcile] Pending music generation has no usable settlement payload", {
        generationId: generation.id,
        organizationId: generation.organization_id,
        jobId: generation.job_id,
      });
      continue;
    }

    const provider = findAudioProvider(settlement.billing_source);
    if (!provider?.getJobStatus) {
      stats.skipped++;
      logger.error("[MusicReconcile] No audio provider with job status for pending settlement", {
        generationId: generation.id,
        billingSource: settlement.billing_source,
      });
      continue;
    }

    let job: AudioJobStatus;
    try {
      job = await provider.getJobStatus({
        model: generation.model,
        requestId: generation.job_id,
        apiKeys: params.apiKeys,
      });
    } catch (error) {
      // error-policy:J1 provider status-probe transport boundary — unknown
      // state must not refund. Skip this item; hold retained for next tick.
      stats.skipped++;
      logger.warn("[MusicReconcile] Upstream status probe failed; keeping hold", {
        generationId: generation.id,
        jobId: generation.job_id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (job.state === "succeeded") {
      const audio = job.result;
      if (audio.source !== "hosted") {
        // Bytes results require R2 storage the cron cannot perform; leave for
        // a later path rather than completing with incomplete storage_url.
        stats.skipped++;
        logger.error("[MusicReconcile] Late success returned bytes payload; skipping", {
          generationId: generation.id,
        });
        continue;
      }
      await settleHold(generation, settlement, settlement.billed_cost);
      await generationsRepository.update(generation.id, {
        status: "completed",
        storage_url: audio.url,
        thumbnail_url: null,
        file_size: audio.fileSize ? BigInt(audio.fileSize) : undefined,
        mime_type: audio.contentType ?? "audio/mpeg",
        result: {
          requestId: audio.requestId ?? generation.job_id,
          status: audio.status,
          billingSource: settlement.billing_source,
          settledLate: true,
          raw: audio.raw,
        },
        metadata: { ...generation.metadata, settlement_state: "charged" },
        completed_at: new Date(),
      });
      stats.charged++;
      logger.info("[MusicReconcile] Late upstream success — charge stands", {
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
      logger.info("[MusicReconcile] Verified upstream failure — hold refunded", {
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

    const reconciliation = await settleHold(generation, settlement, 0);
    await ensureHoldRefunded(generation, settlement, reconciliation);
    await markFailed(
      generation,
      "refunded_expired",
      "Music generation never reached a terminal upstream state before the reconcile deadline",
    );
    stats.expired++;
    logger.warn("[MusicReconcile] Pending music expired past deadline — hold refunded", {
      generationId: generation.id,
      organizationId: generation.organization_id,
      ageMs,
    });
  }

  return stats;
}

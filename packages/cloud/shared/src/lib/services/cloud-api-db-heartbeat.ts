/**
 * Cloud-api → shared-DB heartbeat (#16160).
 *
 * The provisioning-worker daemon's DB-liveness check cannot distinguish a DB
 * split (the daemon polls a database the cloud-api stopped writing to, #15160)
 * from an idle environment (correct database, simply no provisioning traffic)
 * using jobs-row age alone — both present as "the newest jobs row is old".
 *
 * This module gives the check a signal that survives idle: the per-minute
 * `provisioning-worker-health` cron upserts this row on every fire regardless
 * of provisioning traffic, and the daemon reads it. Fresh heartbeat ⇒ the
 * daemon is on the same database the API writes to ⇒ old jobs mean idle, not
 * split. Stale/absent heartbeat + old jobs ⇒ a real split (or the API is
 * down) — warn loudly.
 *
 * Reuses the existing `provider_health` table (a keyed status row with an
 * `updated_at` the repository refreshes on every upsert), so no migration on
 * the shared database is needed.
 */
import { providerHealthRepository } from "../../db/repositories/provider-health";
import { logger } from "../utils/logger";

/** `provider_health.provider` key reserved for the cloud-api DB heartbeat. */
export const CLOUD_API_DB_HEARTBEAT_PROVIDER = "cloud-api-db-heartbeat";

/**
 * Default freshness window (minutes) for the heartbeat. It is written every
 * minute; 15 minutes tolerates cron hiccups and deploy gaps without going
 * blind, while still detecting a split orders of magnitude faster than the
 * 24h jobs-age threshold.
 */
export const DEFAULT_CLOUD_API_DB_HEARTBEAT_MAX_AGE_MINUTES = 15;

/** Upsert the heartbeat row; never throws (a missed beat only delays idle-vs-split discrimination). */
export async function writeCloudApiDbHeartbeat(): Promise<void> {
  try {
    await providerHealthRepository.createOrUpdate({
      provider: CLOUD_API_DB_HEARTBEAT_PROVIDER,
      status: "healthy",
      last_checked: new Date(),
    });
  } catch (error) {
    // The heartbeat must never break the health cron carrying it. When it is
    // missing/stale the daemon falls back to today's jobs-age-only heuristic.
    logger.warn("[CloudApiDbHeartbeat] Failed to write heartbeat", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Latest heartbeat write time, or null when the row has never been written. */
export async function readCloudApiDbHeartbeatAt(): Promise<Date | null> {
  const row = await providerHealthRepository.findByProvider(CLOUD_API_DB_HEARTBEAT_PROVIDER);
  return row?.updated_at ?? null;
}

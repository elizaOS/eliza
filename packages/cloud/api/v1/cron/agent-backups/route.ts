// Handles v1 cloud API v1 cron agent backups route traffic with route-local auth expectations.
import { Hono } from "hono";
import { verifyCronSecret } from "@/lib/auth/cron";
import { agentBackupV2StorageService } from "@/lib/services/agent-backup-v2-storage";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

/**
 * Scheduled-backups cron.
 *
 * Enqueues an `auto` snapshot for every running agent whose last backup has
 * aged past the interval. Runs in-worker (a DB write) rather than forwarding
 * to the container control plane — the snapshot jobs it creates are picked up
 * by the regular provisioning worker, which has bridge access to pull state.
 * Retention is enforced by `pruneBackups` inside the snapshot handler.
 *
 * Piggybacks the low-frequency `deletion_failed` recovery sweep on the same
 * 6-hourly tick: `reEnqueueFailedDeletions` re-arms sandboxes whose
 * `agent_delete` exhausted its retries only because the host node was
 * transiently unreachable, so the delete finishes once the node returns. It
 * is a cheap, capped DB write (no container control-plane hop), so it shares
 * this cron rather than carrying its own schedule. Without a caller the
 * recovery sweep never runs and `deletion_failed` rows leak forever.
 *
 * The same tick reconciles at most one live backup row and one deleted-sandbox
 * cleanup intent. Each row has at most 5,632 exact keys, deleted in six native
 * object-store batches; the fixed deadline and batch cap keep this maintenance
 * below Worker subrequest and wall-time limits without weakening durable
 * write-epoch fences.
 *
 * Tunables via query string: `?intervalMs=<n>&max=<n>` (snapshots),
 * `?deletionMinAgeMs=<n>&deletionMax=<n>` (deletion recovery).
 */
async function handle(c: AppContext, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(c.req.raw, "[Agent Backups]", env);
  if (authError) return authError;

  const url = new URL(c.req.url);
  const intervalMs = Number(url.searchParams.get("intervalMs"));
  const max = Number(url.searchParams.get("max"));
  const deletionMinAgeMs = Number(url.searchParams.get("deletionMinAgeMs"));
  const deletionMax = Number(url.searchParams.get("deletionMax"));

  const result = await provisioningJobService.enqueueScheduledBackups({
    minIntervalMs:
      Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : undefined,
    maxAgents: Number.isFinite(max) && max > 0 ? max : undefined,
  });

  // Recover stuck `deletion_failed` sandboxes on the same tick. Conservative,
  // capped params keep the sweep from fighting the live retry loop or
  // re-enqueueing a large batch at once. Best-effort: a failure here must not
  // mask a successful backup sweep, so it is reported separately.
  let deletionRecovery: Awaited<
    ReturnType<typeof provisioningJobService.reEnqueueFailedDeletions>
  > | null = null;
  try {
    deletionRecovery = await provisioningJobService.reEnqueueFailedDeletions({
      minAgeMs:
        Number.isFinite(deletionMinAgeMs) && deletionMinAgeMs > 0
          ? deletionMinAgeMs
          : undefined,
      maxAgents:
        Number.isFinite(deletionMax) && deletionMax > 0
          ? Math.min(deletionMax, 50)
          : undefined,
    });
  } catch (error) {
    logger.error("[Agent Backups] deletion-recovery sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let storageReconciliation: Awaited<
    ReturnType<typeof agentBackupV2StorageService.reconcileIncomplete>
  > | null = null;
  const reconciliationDeadline = new AbortController();
  const reconciliationTimer = setTimeout(
    () =>
      reconciliationDeadline.abort(
        new Error(
          "Agent backup object reconciliation exceeded its 25-second deadline",
        ),
      ),
    25_000,
  );
  try {
    storageReconciliation =
      await agentBackupV2StorageService.reconcileIncomplete({
        before: new Date(Date.now() - 15 * 60 * 1_000),
        limit: 1,
        signal: reconciliationDeadline.signal,
      });
  } catch (error) {
    // error-policy:J7 exact keys and database rows remain durable for the next
    // cron tick; a failed cleanup must not mask the primary backup enqueue.
    logger.error("[Agent Backups] object reconciliation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(reconciliationTimer);
  }

  logger.info("[Agent Backups] Scheduled backup sweep complete", {
    ...result,
    deletionRecovery,
    storageReconciliation,
  });
  return c.json({
    success: true,
    ...result,
    deletionRecovery,
    storageReconciliation,
  });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => handle(c, c.env));
__hono_app.post("/", async (c) => handle(c, c.env));
export default __hono_app;

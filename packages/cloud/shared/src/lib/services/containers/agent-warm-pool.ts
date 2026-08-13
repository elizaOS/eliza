/**
 * Agent warm pool — keeps a small set of pre-warmed agent containers ready
 * for instant claim.
 *
 * Architecture:
 *   • Pool entries live in `agent_sandboxes` owned by the sentinel pool org.
 *   • A pool entry is "ready" when status='running' and pool_ready_at is set.
 *   • Claim transfers compute fields from a pool row to a user's pending row
 *     and deletes the pool row in one transaction.
 *
 * This module runs in the Node sidecar (container-control-plane) — the
 * Cloudflare Worker cron forwards to it because container creation needs
 * SSH/Docker access.
 *
 * Decision functions are pure and tested in isolation. The manager wires
 * them to repository + Hetzner client I/O.
 */

import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import type { AgentSandbox } from "../../../db/schemas/agent-sandboxes";
import { containersEnv } from "../../config/containers-env";
import { logger } from "../../utils/logger";
import {
  computeForecast,
  DEFAULT_WARM_POOL_POLICY,
  type WarmPoolPolicy,
} from "./agent-warm-pool-forecast";
import { type ImageRolloutSummary, summarizeImageRollout } from "./image-rollout-status";

// ---------------------------------------------------------------------------
// Pure decisions (tested without a DB).
// ---------------------------------------------------------------------------

export interface PoolStateSnapshot {
  readyCount: number;
  provisioningCount: number;
  unclaimedRows: Array<{
    id: string;
    pool_ready_at: Date | null;
    docker_image: string | null;
    node_id: string | null;
    health_url: string | null;
  }>;
  predictedRate: number;
  targetPoolSize: number;
}

export interface ReplenishDecision {
  toCreate: number;
  reason: string;
}

export function decideReplenish(
  state: PoolStateSnapshot,
  policy: WarmPoolPolicy,
): ReplenishDecision {
  const total = state.readyCount + state.provisioningCount;
  const headroom = Math.max(0, policy.maxPoolSize - total);
  const deficit = Math.max(0, state.targetPoolSize - total);
  const toCreate = Math.max(0, Math.min(deficit, policy.replenishBurstLimit, headroom));

  let reason: string;
  if (toCreate > 0) {
    const burstLimited = deficit > policy.replenishBurstLimit;
    reason = burstLimited
      ? `total ${total} < target ${state.targetPoolSize}; creating ${toCreate} (burst limit ${policy.replenishBurstLimit})`
      : `total ${total} < target ${state.targetPoolSize}; creating ${toCreate}`;
  } else if (deficit > 0 && headroom === 0) {
    reason = `at maxPoolSize ${policy.maxPoolSize}; deferring ${deficit}`;
  } else if (deficit > 0) {
    reason = `at burst limit ${policy.replenishBurstLimit}; deferring ${deficit - toCreate}`;
  } else {
    reason = `steady (total ${total}, target ${state.targetPoolSize})`;
  }
  return { toCreate, reason };
}

export interface DrainDecision {
  toDrain: string[];
  reason: string;
}

export function decideDrain(
  state: PoolStateSnapshot,
  policy: WarmPoolPolicy,
  nowMs: number,
): DrainDecision {
  if (state.targetPoolSize > policy.minPoolSize) {
    return { toDrain: [], reason: "demand keeps target above floor" };
  }
  const surplus = state.readyCount - policy.minPoolSize;
  if (surplus <= 0) return { toDrain: [], reason: "at or below floor" };

  const eligible = state.unclaimedRows
    .filter((r) => r.pool_ready_at && nowMs - r.pool_ready_at.getTime() > policy.idleScaleDownMs)
    .sort((a, b) => (a.pool_ready_at?.getTime() ?? 0) - (b.pool_ready_at?.getTime() ?? 0))
    .slice(0, surplus);

  if (eligible.length === 0) {
    return { toDrain: [], reason: "surplus rows are within idle window" };
  }
  return {
    toDrain: eligible.map((r) => r.id),
    reason: `surplus ${surplus} past idle window; draining ${eligible.length}`,
  };
}

export interface RolloutDecision {
  toReplace: string[];
  reason: string;
}

export function decideRollout(
  unclaimedRows: Array<{ id: string; docker_image: string | null }>,
  currentImage: string,
): RolloutDecision {
  const stale = unclaimedRows.filter(
    (r) => r.docker_image !== currentImage && r.docker_image !== null,
  );
  return {
    toReplace: stale.map((r) => r.id),
    reason:
      stale.length > 0 ? `replacing ${stale.length} stale-image rows` : "all rows on current image",
  };
}

// ---------------------------------------------------------------------------
// Pool manager (I/O — runs in container-control-plane).
// ---------------------------------------------------------------------------

/**
 * The deployed policy: `DEFAULT_WARM_POOL_POLICY` with the operator-tunable
 * floor/ceiling read from `WARM_POOL_MIN_SIZE` / `WARM_POOL_MAX_SIZE` (via
 * `containersEnv`). Every production `WarmPoolManager` must be constructed
 * with this — constructing with the bare default silently pins the floor to 1
 * and makes the env vars inert.
 *
 * The ceiling is the hard cost cap, so a floor configured above it clamps
 * down to the ceiling instead of tripping the `computeForecast`
 * min<=max invariant.
 */
export function envWarmPoolPolicy(): WarmPoolPolicy {
  const maxPoolSize = containersEnv.warmPoolMaxSize();
  const minPoolSize = Math.min(containersEnv.warmPoolMinSize(), maxPoolSize);
  return { ...DEFAULT_WARM_POOL_POLICY, minPoolSize, maxPoolSize };
}

export interface PoolContainerCreator {
  /**
   * Create a new pre-warmed agent container. Implementation lives in the
   * control-plane, where Hetzner SSH is available.
   *
   * Must:
   *   1. Insert a pool entry via `agentSandboxesRepository.createPoolEntry`
   *      with status='pending', `docker_image` set, `pool_status='unclaimed'`.
   *   2. Allocate a node and start the container.
   *   3. Complete the provision path, whose final repository CAS commits
   *      status='running' and `pool_ready_at` together.
   *   4. On failure, leave a non-claimable row for reconciliation.
   */
  createPoolContainer(image: string): Promise<{ id: string; nodeId: string | null }>;

  /**
   * Stop the docker container backing this pool entry and delete the row.
   * Idempotent.
   */
  destroyPoolContainer(poolId: string): Promise<void>;

  /**
   * Verify the pool container responds at its health URL.
   * Returns true when alive, false when unreachable.
   */
  healthProbe(poolId: string): Promise<boolean>;
}

export interface ReplenishResult {
  decision: ReplenishDecision;
  state: PoolStateSnapshot;
  reconciliation: WarmPoolReconciliationResult;
  created: Array<{ id: string; nodeId: string | null }>;
  failed: Array<{ error: string }>;
}

export interface DrainResult {
  decision: DrainDecision;
  drained: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface HealthCheckResult {
  probed: number;
  alive: number;
  reconciliation: WarmPoolReconciliationResult;
  removed: Array<{ id: string; reason: string }>;
}

export interface WarmPoolReconciliationResult {
  scanned: number;
  probed: number;
  promoted: string[];
  reaped: Array<{ id: string; reason: string }>;
  deferred: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface RolloutResult {
  decision: RolloutDecision;
  replaced: string[];
  failed: Array<{ id: string; error: string }>;
}

export class WarmPoolManager {
  constructor(
    private readonly creator: PoolContainerCreator,
    private readonly policy: WarmPoolPolicy = DEFAULT_WARM_POOL_POLICY,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly sleepFn: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * Compute current pool state + forecast. Pure-ish: only reads.
   */
  async snapshot(image: string): Promise<PoolStateSnapshot> {
    const counts = await agentSandboxesRepository.countAllPoolEntries({ image });
    const unclaimedRows = await agentSandboxesRepository.listClaimablePool({ image });

    const buckets = await this.collectHourlyBuckets(this.policy.forecastWindowHours);
    const forecast = computeForecast({
      bucketCounts: buckets,
      emaAlpha: this.policy.emaAlpha,
      leadTimeBuckets: this.policy.leadTimeBuckets,
      minPoolSize: this.policy.minPoolSize,
      maxPoolSize: this.policy.maxPoolSize,
    });

    return {
      readyCount: counts.ready,
      provisioningCount: counts.provisioning,
      unclaimedRows: unclaimedRows.map((r) => ({
        id: r.id,
        pool_ready_at: r.pool_ready_at,
        docker_image: r.docker_image,
        node_id: r.node_id,
        health_url: r.health_url,
      })),
      predictedRate: forecast.predictedRate,
      targetPoolSize: forecast.targetPoolSize,
    };
  }

  async replenish(image: string): Promise<ReplenishResult> {
    if (!containersEnv.warmPoolEnabled()) {
      return {
        decision: { toCreate: 0, reason: "WARM_POOL_ENABLED=false (no-op)" },
        state: emptyState(),
        reconciliation: emptyReconciliation(),
        created: [],
        failed: [],
      };
    }

    // Reconciliation runs on the production replenish path, not only the
    // manually-invoked health route. A stranded row is repaired or fenced
    // before the capacity snapshot decides whether to create a replacement.
    const reconciliation = await this.reconcileUnclaimable();
    const state = await this.snapshot(image);
    const decision = decideReplenish(state, this.policy);
    const created: Array<{ id: string; nodeId: string | null }> = [];
    const failed: Array<{ error: string }> = [];

    for (let i = 0; i < decision.toCreate; i++) {
      try {
        const result = await this.creator.createPoolContainer(image);
        created.push(result);
      } catch (err) {
        // error-policy:J1 batch boundary — a per-container provision failure is
        // recorded in the structured `failed[]` result and logged, then the
        // burst stops. The failure surfaces to the caller; it never reads as a
        // successful create.
        failed.push({ error: err instanceof Error ? err.message : String(err) });
        logger.warn("[warm-pool] replenish create failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    logger.info("[warm-pool] replenish", {
      decision,
      ready: state.readyCount,
      provisioning: state.provisioningCount,
      target: state.targetPoolSize,
      created: created.length,
      failed: failed.length,
      reconciled: {
        promoted: reconciliation.promoted.length,
        reaped: reconciliation.reaped.length,
        deferred: reconciliation.deferred.length,
        failed: reconciliation.failed.length,
      },
    });
    return { decision, state, reconciliation, created, failed };
  }

  async drainIdle(image: string): Promise<DrainResult> {
    if (!containersEnv.warmPoolEnabled()) {
      return {
        decision: { toDrain: [], reason: "WARM_POOL_ENABLED=false (no-op)" },
        drained: [],
        failed: [],
      };
    }

    const state = await this.snapshot(image);
    const decision = decideDrain(state, this.policy, this.nowFn());
    const drained: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of decision.toDrain) {
      try {
        await this.creator.destroyPoolContainer(id);
        drained.push(id);
      } catch (err) {
        // error-policy:J1 batch boundary — a per-row destroy failure is recorded
        // in the structured `failed[]` result; the row stays in the pool and is
        // retried next pass. The failure surfaces; it never reads as drained.
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    logger.info("[warm-pool] drain-idle", {
      decision,
      drained: drained.length,
      failed: failed.length,
    });
    return { decision, drained, failed };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!containersEnv.warmPoolEnabled()) {
      return {
        probed: 0,
        alive: 0,
        reconciliation: emptyReconciliation(),
        removed: [],
      };
    }

    const rows = await agentSandboxesRepository.listClaimablePool();
    const reconciliation = await this.reconcileUnclaimable();
    const removed: Array<{ id: string; reason: string }> = [...reconciliation.reaped];
    let alive = reconciliation.promoted.length;

    // A single missed probe no longer reaps a row: the probe crosses the
    // headscale mesh, whose routine >5s transient hiccups made one-strike
    // reaping destroy every ready entry within a couple of sweeps. Rows that
    // miss the first probe get a bounded, spaced retry round instead.
    const suspects: Array<{ id: string }> = [];
    for (const row of rows) {
      // `healthProbe` is contracted to return false for an unreachable
      // container and only throws on an internal failure (its lookup/DB read).
      // We must NOT swallow that throw into `false` — doing so would treat a DB
      // blip as "container dead" and destroy the whole pool. Let it propagate so
      // the failure surfaces to the cron; only a designed `false` reaps a row.
      const ok = await this.creator.healthProbe(row.id);
      if (ok) {
        alive++;
        continue;
      }
      suspects.push({ id: row.id });
    }

    const confirmedDead = await this.retrySuspectProbes(suspects);
    alive += suspects.length - confirmedDead.length;
    const attempts = Math.max(1, this.policy.healthProbeAttempts);
    const deadReason =
      attempts === 1 ? "health probe failed" : `health probe failed after ${attempts} attempts`;
    for (const row of confirmedDead) {
      try {
        await this.creator.destroyPoolContainer(row.id);
        removed.push({ id: row.id, reason: deadReason });
      } catch (err) {
        // error-policy:J6 best-effort teardown — destroy is idempotent and the
        // next health-check pass retries; record the failure in the reason.
        removed.push({
          id: row.id,
          reason: `${deadReason}; destroy errored: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Also reap stuck-in-provisioning rows that never became ready.
    const stuck = await agentSandboxesRepository.findStuckPoolProvisioning(
      this.policy.stuckProvisioningMs,
    );
    for (const row of stuck) {
      const reserved = await agentSandboxesRepository.reserveStuckPoolEntryForReap(
        row,
        this.policy.stuckProvisioningMs,
      );
      if (!reserved) continue;
      try {
        await this.creator.destroyPoolContainer(row.id);
        removed.push({ id: row.id, reason: "stuck in provisioning past threshold" });
      } catch (err) {
        // error-policy:J6 best-effort teardown — destroy is idempotent and the
        // next pass retries; record the failure in the reason.
        removed.push({
          id: row.id,
          reason: `stuck; destroy errored: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    logger.info("[warm-pool] health-check", {
      probed: rows.length,
      alive,
      removed: removed.length,
      stuck: stuck.length,
      reconciled: {
        promoted: reconciliation.promoted.length,
        reaped: reconciliation.reaped.length,
        deferred: reconciliation.deferred.length,
        failed: reconciliation.failed.length,
      },
    });
    return {
      probed: rows.length + reconciliation.probed,
      alive,
      reconciliation,
      removed,
    };
  }

  /**
   * Re-probe ready entries that missed their first health probe, up to
   * `healthProbeAttempts - 1` extra times spaced `healthProbeRetryDelayMs`
   * apart, and return only the rows that failed every attempt. Suspects retry
   * concurrently so the sweep's worst case stays (attempts - 1) × (delay +
   * probe timeout) regardless of row count — bounded inside the daemon's
   * phase budget. `healthProbe`'s contract is preserved: an internal throw
   * from any attempt propagates (via allSettled + rethrow, so a sibling row's
   * in-flight probe can never become an unhandled rejection) and NOTHING is
   * reaped from an indeterminate sweep.
   */
  private async retrySuspectProbes(
    suspects: Array<{ id: string }>,
  ): Promise<Array<{ id: string }>> {
    if (suspects.length === 0) return [];
    const retries = Math.max(0, this.policy.healthProbeAttempts - 1);
    if (retries === 0) return suspects;

    const outcomes = await Promise.allSettled(
      suspects.map(async (row) => {
        for (let attempt = 0; attempt < retries; attempt++) {
          await this.sleepFn(this.policy.healthProbeRetryDelayMs);
          if (await this.creator.healthProbe(row.id)) return null;
        }
        return row;
      }),
    );
    const rejection = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (rejection) throw rejection.reason;
    return outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" && outcome.value !== null ? [outcome.value] : [],
    );
  }

  async rollout(image: string): Promise<RolloutResult> {
    if (!containersEnv.warmPoolEnabled()) {
      return {
        decision: { toReplace: [], reason: "WARM_POOL_ENABLED=false (no-op)" },
        replaced: [],
        failed: [],
      };
    }

    const rows = await agentSandboxesRepository.listAllRunningPoolEntries();
    const decision = decideRollout(rows, image);
    const replaced: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of decision.toReplace) {
      try {
        await this.creator.destroyPoolContainer(id);
        replaced.push(id);
      } catch (err) {
        // error-policy:J1 batch boundary — a per-row replace failure is recorded
        // in the structured `failed[]` result; the stale row stays and is retried
        // next pass. The failure surfaces; it never reads as replaced.
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    logger.info("[warm-pool] rollout", {
      decision,
      replaced: replaced.length,
      failed: failed.length,
    });
    return { decision, replaced, failed };
  }

  async rolloutStatus(image: string): Promise<ImageRolloutSummary> {
    const rows = containersEnv.warmPoolEnabled()
      ? await agentSandboxesRepository.listAllRunningPoolEntries()
      : [];
    return summarizeImageRollout({
      desiredImage: image,
      enabled: containersEnv.warmPoolEnabled(),
      rows: rows.map((r) => ({
        id: r.id,
        docker_image: r.docker_image,
        node_id: r.node_id,
        pool_ready_at: r.pool_ready_at,
        health_url: r.health_url,
      })),
    });
  }

  private async collectHourlyBuckets(windowHours: number): Promise<number[]> {
    return agentSandboxesRepository.countUserProvisionsByHour(windowHours);
  }

  /**
   * Repair the historical running-without-readiness crash shape and fence every
   * other unclaimable running generation before teardown. Probe results are
   * committed through generation CAS operations so stale network observations
   * cannot promote or destroy a replacement container.
   */
  private async reconcileUnclaimable(): Promise<WarmPoolReconciliationResult> {
    const candidates = await agentSandboxesRepository.listWarmPoolReconciliationCandidates(
      this.policy.stuckProvisioningMs,
    );
    const result = emptyReconciliation();
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      const row = candidate.sandbox;
      if (candidate.canPromote) {
        result.probed += 1;
        const alive = await this.creator.healthProbe(row.id);
        if (alive) {
          const promoted = await agentSandboxesRepository.promoteStrandedPoolEntryReady(row);
          if (promoted) result.promoted.push(row.id);
          else result.deferred.push(row.id);
          continue;
        }
      }

      const reason = candidate.canPromote
        ? "Warm-pool readiness probe failed during reconciliation"
        : "Warm-pool row is missing a required claim locator";
      const reserved = await agentSandboxesRepository.reserveUnclaimablePoolEntryForReap(
        row,
        reason,
      );
      if (!reserved) {
        result.deferred.push(row.id);
        continue;
      }
      try {
        await this.creator.destroyPoolContainer(row.id);
        result.reaped.push({ id: row.id, reason });
      } catch (error) {
        // error-policy:J6 best-effort teardown — the durable deletion_failed
        // fence prevents reuse, and the stuck sweep retries this exact row.
        result.failed.push({
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }
}

function emptyState(): PoolStateSnapshot {
  return {
    readyCount: 0,
    provisioningCount: 0,
    unclaimedRows: [],
    predictedRate: 0,
    targetPoolSize: 0,
  };
}

function emptyReconciliation(): WarmPoolReconciliationResult {
  return {
    scanned: 0,
    probed: 0,
    promoted: [],
    reaped: [],
    deferred: [],
    failed: [],
  };
}

export type { AgentSandbox };

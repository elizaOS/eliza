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

import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import type { AgentSandbox } from "@/db/schemas/agent-sandboxes";
import { containersEnv } from "@/lib/config/containers-env";
import {
  computeForecast,
  DEFAULT_WARM_POOL_POLICY,
  type WarmPoolPolicy,
} from "@/lib/services/containers/agent-warm-pool-forecast";
import { logger } from "@/lib/utils/logger";

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

export interface PoolContainerCreator {
  /**
   * Create a new pre-warmed agent container. Implementation lives in the
   * control-plane, where Hetzner SSH is available.
   *
   * Must:
   *   1. Insert a pool entry via `agentSandboxesRepository.createPoolEntry`
   *      with status='pending', `docker_image` set, `pool_status='unclaimed'`.
   *   2. Allocate a node and start the container.
   *   3. On health-check pass, call `markPoolEntryReady(id)`.
   *   4. On failure, mark status='error' (the stuck-reaper will delete it).
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
  removed: Array<{ id: string; reason: string }>;
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
  ) {}

  /**
   * Compute current pool state + forecast. Pure-ish: only reads.
   */
  async snapshot(image: string): Promise<PoolStateSnapshot> {
    const counts = await agentSandboxesRepository.countAllPoolEntries();
    const unclaimedRows = await agentSandboxesRepository.listUnclaimedPool();

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
      unclaimedRows: unclaimedRows
        .filter((r) => r.docker_image === image || r.docker_image === null)
        .map((r) => ({
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
        created: [],
        failed: [],
      };
    }

    const state = await this.snapshot(image);
    const decision = decideReplenish(state, this.policy);
    const created: Array<{ id: string; nodeId: string | null }> = [];
    const failed: Array<{ error: string }> = [];

    for (let i = 0; i < decision.toCreate; i++) {
      try {
        const result = await this.creator.createPoolContainer(image);
        created.push(result);
      } catch (err) {
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
    });
    return { decision, state, created, failed };
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
      return { probed: 0, alive: 0, removed: [] };
    }

    const rows = await agentSandboxesRepository.listUnclaimedPool();
    const removed: Array<{ id: string; reason: string }> = [];
    let alive = 0;

    for (const row of rows) {
      const ok = await this.creator.healthProbe(row.id).catch(() => false);
      if (ok) {
        alive++;
        continue;
      }
      try {
        await this.creator.destroyPoolContainer(row.id);
        removed.push({ id: row.id, reason: "health probe failed" });
      } catch (err) {
        removed.push({
          id: row.id,
          reason: `probe failed; destroy errored: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Also reap stuck-in-provisioning rows that never became ready.
    const stuck = await agentSandboxesRepository.findStuckPoolProvisioning(
      this.policy.stuckProvisioningMs,
    );
    for (const row of stuck) {
      try {
        await this.creator.destroyPoolContainer(row.id);
        removed.push({ id: row.id, reason: "stuck in provisioning past threshold" });
      } catch (err) {
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
    });
    return { probed: rows.length, alive, removed };
  }

  async rollout(image: string): Promise<RolloutResult> {
    if (!containersEnv.warmPoolEnabled()) {
      return {
        decision: { toReplace: [], reason: "WARM_POOL_ENABLED=false (no-op)" },
        replaced: [],
        failed: [],
      };
    }

    const rows = await agentSandboxesRepository.listUnclaimedPool();
    const decision = decideRollout(rows, image);
    const replaced: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of decision.toReplace) {
      try {
        await this.creator.destroyPoolContainer(id);
        replaced.push(id);
      } catch (err) {
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

  private async collectHourlyBuckets(windowHours: number): Promise<number[]> {
    return agentSandboxesRepository.countUserProvisionsByHour(windowHours);
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

export type { AgentSandbox };

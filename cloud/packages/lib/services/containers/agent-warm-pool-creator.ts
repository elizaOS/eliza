/**
 * Concrete `PoolContainerCreator` for the container-control-plane.
 *
 * Delegates the heavy lifting (node selection, SSH, docker run, Neon DB
 * branch, health check) to the existing `elizaSandboxService.provision`
 * flow — pool entries are just sandbox rows owned by the sentinel pool
 * org, so the same flow works.
 *
 * Trade-off: each pool entry consumes one Neon branch up-front. On claim,
 * the branch is transferred to the user's row, so cost is proportional
 * to pool size, not per-claim. We accept this for v1 — the alternative
 * (provision Neon at claim time) re-introduces the cold start we're
 * trying to hide.
 */

import { randomUUID } from "node:crypto";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { WARM_POOL_ORG_ID } from "@/db/schemas/agent-sandboxes";
import type { PoolContainerCreator } from "@/lib/services/containers/agent-warm-pool";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";

const HEALTH_PROBE_TIMEOUT_MS = 5_000;

export class HetznerPoolContainerCreator implements PoolContainerCreator {
  async createPoolContainer(image: string): Promise<{ id: string; nodeId: string | null }> {
    const row = await agentSandboxesRepository.createPoolEntry({
      agent_name: `pool-${randomUUID().slice(0, 8)}`,
      docker_image: image,
      status: "pending",
      database_status: "none",
      environment_vars: {},
    });

    try {
      const result = await elizaSandboxService.provision(row.id, WARM_POOL_ORG_ID);
      if (!result.success) {
        // Leave the row in 'error' state — health-check cron will reap it.
        await agentSandboxesRepository.update(row.id, {
          status: "error",
          error_message: result.error,
        });
        throw new Error(`pool provision failed: ${result.error}`);
      }
      const ready = await agentSandboxesRepository.markPoolEntryReady(row.id);
      logger.info("[warm-pool/creator] pool entry ready", {
        poolId: row.id,
        nodeId: ready?.node_id ?? null,
        bridgeUrl: ready?.bridge_url ?? null,
      });
      return { id: row.id, nodeId: ready?.node_id ?? result.sandboxRecord.node_id ?? null };
    } catch (err) {
      logger.warn("[warm-pool/creator] pool entry creation failed", {
        poolId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async destroyPoolContainer(poolId: string): Promise<void> {
    const row = await agentSandboxesRepository.findById(poolId);
    if (!row) return;
    if (row.organization_id !== WARM_POOL_ORG_ID) {
      throw new Error(
        `refusing to destroy non-pool sandbox ${poolId} (org ${row.organization_id})`,
      );
    }
    const result = await elizaSandboxService.deleteAgent(poolId, WARM_POOL_ORG_ID);
    if (!result.success && result.error !== "Agent not found") {
      throw new Error(`pool destroy failed: ${result.error}`);
    }
    // deleteAgent already removes the row, but if it short-circuited (e.g.
    // because the container was never started) the pool row may still exist.
    await agentSandboxesRepository.deletePoolEntry(poolId).catch(() => undefined);
  }

  async healthProbe(poolId: string): Promise<boolean> {
    const row = await agentSandboxesRepository.findById(poolId);
    if (!row?.health_url) return false;
    try {
      const r = await fetch(row.health_url, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      return r.ok;
    } catch {
      return false;
    }
  }
}

let cachedCreator: HetznerPoolContainerCreator | null = null;

export function getHetznerPoolContainerCreator(): HetznerPoolContainerCreator {
  if (!cachedCreator) cachedCreator = new HetznerPoolContainerCreator();
  return cachedCreator;
}

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
import { ElizaError } from "@elizaos/core";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { WARM_POOL_ORG_ID } from "../../../db/schemas/agent-sandboxes";
import { logger } from "../../utils/logger";
import { elizaSandboxService } from "../eliza-sandbox";
import type { PoolContainerCreator } from "./agent-warm-pool";

const HEALTH_PROBE_TIMEOUT_MS = 5_000;

export class HetznerPoolContainerCreator implements PoolContainerCreator {
  async createPoolContainer(
    configuredImage: string,
    targetDigest?: string,
  ): Promise<{ id: string; nodeId: string | null }> {
    const row = await agentSandboxesRepository.createPoolEntry({
      agent_name: `pool-${randomUUID().slice(0, 8)}`,
      // Keep the logical configured reference stable for the claim contract,
      // while `provision()` binds this warm generation to targetDigest for the
      // actual Docker pull. Persisting the digest before remote creation also
      // makes the in-flight row count against exact-digest capacity.
      docker_image: configuredImage,
      image_digest: targetDigest,
      status: "pending",
      database_status: "none",
      environment_vars: {},
    });

    const result = await elizaSandboxService.provision(row.id, WARM_POOL_ORG_ID);
    if (!result.success) {
      // The row stays available to the production reconciliation sweep, while
      // the explicit error state prevents it from contributing capacity.
      await agentSandboxesRepository.update(row.id, {
        status: "error",
        error_message: result.error,
      });
      throw new ElizaError(`Pool provision failed: ${result.error}`, {
        code: "WARM_POOL_PROVISION_FAILED",
        context: { poolId: row.id, image: configuredImage, targetDigest },
        severity: result.retryable ? "ephemeral" : "fatal",
      });
    }
    const ready = result.sandboxRecord;
    if (
      ready.status !== "running" ||
      ready.pool_ready_at === null ||
      ready.node_id === null ||
      ready.bridge_url === null
    ) {
      throw new ElizaError("Pool provision returned success without claimable readiness", {
        code: "WARM_POOL_READINESS_INVARIANT_BROKEN",
        context: {
          poolId: row.id,
          status: ready.status,
          hasReadyStamp: ready.pool_ready_at !== null,
          hasNodeId: ready.node_id !== null,
          hasBridgeUrl: ready.bridge_url !== null,
        },
        severity: "fatal",
      });
    }
    logger.info("[warm-pool/creator] pool entry ready", {
      poolId: row.id,
      nodeId: ready.node_id,
      bridgeUrl: ready.bridge_url,
    });
    return { id: row.id, nodeId: ready.node_id };
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
    // Unresolved remote teardown retains the row as a capacity-ownership
    // tombstone. Deleting it here would erase the orphan reaper's exactly-once
    // release claim, so only clean deletion may run the defensive no-op below.
    if (result.success && !result.rowDeleted) return;
    // deleteAgent already removes the row, but if it short-circuited (e.g.
    // because the container was never started) the pool row may still exist.
    // deletePoolEntry is a no-op (returns false) when the row is already gone,
    // so a genuine throw here is a real DB failure that must surface as a
    // destroy failure — never swallowed into a phantom leaked pool row.
    await agentSandboxesRepository.deletePoolEntry(poolId);
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
      // error-policy:J4 unreachable/timeout ⇒ unhealthy. This is a boolean
      // liveness probe whose contract is "true when alive, false when
      // unreachable"; a network/abort error is a distinguishable "dead" signal
      // that drives the caller to reap the entry — not a fabricated success.
      return false;
    }
  }
}

let cachedCreator: HetznerPoolContainerCreator | null = null;

export function getHetznerPoolContainerCreator(): HetznerPoolContainerCreator {
  if (!cachedCreator) cachedCreator = new HetznerPoolContainerCreator();
  return cachedCreator;
}

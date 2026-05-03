/**
 * POST /api/v1/admin/docker-nodes/sync
 * Reconcile allocated_count in docker_nodes with actual active sandboxes.
 * Requires super_admin role.
 *
 * Pure DB reconciliation — does not touch SSH, even though
 * `dockerNodeManager` is the same module that owns SSH-using methods.
 */
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { dockerNodeManager } from "@/lib/services/docker-node-manager";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const { role } = await requireAdmin(c);
    if (role !== "super_admin") {
      return c.json({ success: false, error: "Super admin access required" }, 403);
    }

    const changes = await dockerNodeManager.syncAllocatedCounts();
    const changesObj = Object.fromEntries(
      Array.from(changes.entries()).map(([nodeId, diff]) => [nodeId, diff]),
    );

    logger.info("[Admin Docker Sync] Allocated count sync completed", {
      nodesChanged: changes.size,
    });

    return c.json({
      success: true,
      data: {
        nodesChanged: changes.size,
        changes: changesObj,
        syncedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error("[Admin Docker Sync] Sync failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;

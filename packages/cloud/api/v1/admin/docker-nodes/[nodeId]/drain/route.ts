/** Handles the privileged Docker-node drain endpoint for the admin cloud API. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

/**
 * Admin: drain a Docker node.
 *
 * Disables the node so no new containers schedule to it. If the node is
 * already empty AND the JSON body sets `deprovision` to true, the underlying
 * autoscaler-provisioned Hetzner Cloud server is also deleted. Manually
 * registered auctioned/static boxes do not carry an `hcloudServerId`; those
 * are left disabled and must be removed explicitly if the operator wants to
 * unregister them.
 *
 * Stateful containers (volume_path != null) on the node block the
 * deprovision step until the operator migrates or deletes them. The
 * route returns 200 with `{ remaining: N }` in that case.
 */

import { dockerNodesRepository } from "@elizaos/cloud-shared/db/repositories/docker-nodes";
import { requireAdmin } from "@elizaos/cloud-shared/lib/auth";
import { HetznerCloudError } from "@elizaos/cloud-shared/lib/services/containers/hetzner-cloud-api";
import { getNodeAutoscaler } from "@elizaos/cloud-shared/lib/services/containers/node-autoscaler";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { z } from "zod";

const drainSchema = z.object({
  deprovision: z.boolean().optional().default(false),
});

async function __hono_POST(
  request: Request,
  context: { params: Promise<{ nodeId: string }> },
) {
  const { role } = await requireAdmin(request);
  if (role !== "super_admin") {
    return Response.json(
      { success: false, error: "Super admin access required" },
      { status: 403 },
    );
  }

  const { nodeId } = await context.params;
  if (!nodeId) {
    return Response.json(
      { success: false, error: "nodeId is required" },
      { status: 400 },
    );
  }

  let body: unknown = {};
  try {
    const rawBody = await request.text();
    if (rawBody.trim().length > 0) {
      body = JSON.parse(rawBody);
    }
  } catch {
    // error-policy:J3 A malformed or unreadable body must not become the
    // bodyless disable operation on this destructive administrative route.
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = drainSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        success: false,
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  try {
    await getNodeAutoscaler().drainNode(nodeId, {
      deprovision: parsed.data.deprovision,
    });
    const refreshed = await dockerNodesRepository.findByNodeId(nodeId);

    return Response.json({
      success: true,
      data: {
        nodeId,
        deprovisioned: refreshed === null,
        node: refreshed,
        message: refreshed
          ? "Node disabled. Containers still on it must be migrated or deleted before deprovision."
          : "Node deprovisioned successfully.",
      },
    });
  } catch (error) {
    if (error instanceof HetznerCloudError) {
      const statusByCode: Record<HetznerCloudError["code"], number> = {
        missing_token: 503,
        invalid_input: 400,
        not_found: 404,
        rate_limited: 429,
        quota_exceeded: 403,
        server_error: 502,
        transport_error: 502,
      };
      return Response.json(
        { success: false, error: error.message, code: error.code },
        { status: statusByCode[error.code] ?? 500 },
      );
    }

    logger.error("[admin/docker-nodes/drain] failed", {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to drain node",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, {
    params: Promise.resolve({ nodeId: c.req.param("nodeId")! }),
  }),
);
export default __hono_app;

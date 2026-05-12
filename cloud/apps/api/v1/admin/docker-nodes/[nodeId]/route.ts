import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Admin Docker Node Detail API
 *
 * GET    /api/v1/admin/docker-nodes/:nodeId — Get single node details
 * PATCH  /api/v1/admin/docker-nodes/:nodeId — Update node settings
 * DELETE /api/v1/admin/docker-nodes/:nodeId — Remove node (only if no containers)
 *
 * Requires admin role.
 */

import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { dbRead } from "@/db/helpers";
import { dockerNodesRepository } from "@/db/repositories/docker-nodes";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import { requireAdmin } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";

type RouteParams = { params: Promise<{ nodeId: string }> };

// ---------------------------------------------------------------------------
// GET — Get single node details
// ---------------------------------------------------------------------------

async function __hono_GET(request: Request, { params }: RouteParams) {
  try {
    const { role } = await requireAdmin(request);
    if (role !== "super_admin") {
      return Response.json(
        { success: false, error: "Super admin access required" },
        { status: 403 },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin access required";
    return Response.json({ success: false, error: message }, { status: 403 });
  }

  const { nodeId } = await params;

  try {
    const node = await dockerNodesRepository.findByNodeId(nodeId);
    if (!node) {
      return Response.json(
        { success: false, error: `Node '${nodeId}' not found` },
        { status: 404 },
      );
    }

    // Fetch containers on this node
    const containers = await dbRead
      .select({
        id: agentSandboxes.id,
        sandboxId: agentSandboxes.sandbox_id,
        containerName: agentSandboxes.container_name,
        agentName: agentSandboxes.agent_name,
        status: agentSandboxes.status,
        bridgePort: agentSandboxes.bridge_port,
        webUiPort: agentSandboxes.web_ui_port,
        headscaleIp: agentSandboxes.headscale_ip,
        createdAt: agentSandboxes.created_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.node_id, nodeId));

    return Response.json({
      success: true,
      data: {
        id: node.id,
        nodeId: node.node_id,
        hostname: node.hostname,
        sshPort: node.ssh_port,
        sshUser: node.ssh_user,
        capacity: node.capacity,
        allocatedCount: node.allocated_count,
        availableSlots: node.capacity - node.allocated_count,
        enabled: node.enabled,
        status: node.status,
        lastHealthCheck: node.last_health_check,
        metadata: node.metadata,
        createdAt: node.created_at,
        updatedAt: node.updated_at,
        containers,
      },
    });
  } catch (error) {
    logger.error("[Admin Docker Nodes] Failed to get node", {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ success: false, error: "Failed to get Docker node" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH — Update node settings
// ---------------------------------------------------------------------------

const updateNodeSchema = z
  .object({
    hostname: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    capacity: z.number().int().min(1).optional(),
    sshPort: z.number().int().min(1).max(65535).optional(),
    sshUser: z.string().min(1).optional(),
    hostKeyFingerprint: z.string().min(1).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "At least one field must be provided for update",
  });

async function __hono_PATCH(request: Request, { params }: RouteParams) {
  try {
    const { role } = await requireAdmin(request);
    if (role !== "super_admin") {
      return Response.json(
        { success: false, error: "Super admin access required" },
        { status: 403 },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin access required";
    return Response.json({ success: false, error: message }, { status: 403 });
  }

  const { nodeId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = updateNodeSchema.safeParse(body);
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
    const existing = await dockerNodesRepository.findByNodeId(nodeId);
    if (!existing) {
      return Response.json(
        { success: false, error: `Node '${nodeId}' not found` },
        { status: 404 },
      );
    }

    const { hostname, enabled, capacity, sshPort, sshUser, hostKeyFingerprint, metadata } =
      parsed.data;

    const updateData: Record<string, unknown> = {};
    if (hostname !== undefined) updateData.hostname = hostname;
    if (enabled !== undefined) updateData.enabled = enabled;
    if (capacity !== undefined) updateData.capacity = capacity;
    if (sshPort !== undefined) updateData.ssh_port = sshPort;
    if (sshUser !== undefined) updateData.ssh_user = sshUser;
    if (hostKeyFingerprint !== undefined) updateData.host_key_fingerprint = hostKeyFingerprint;
    if (metadata !== undefined) updateData.metadata = metadata;

    const updated = await dockerNodesRepository.update(existing.id, updateData);

    logger.info("[Admin Docker Nodes] Node updated", {
      nodeId,
      fields: Object.keys(parsed.data),
    });

    return Response.json({
      success: true,
      data: updated
        ? {
            id: updated.id,
            nodeId: updated.node_id,
            hostname: updated.hostname,
            sshPort: updated.ssh_port,
            sshUser: updated.ssh_user,
            capacity: updated.capacity,
            allocatedCount: updated.allocated_count,
            enabled: updated.enabled,
            status: updated.status,
            lastHealthCheck: updated.last_health_check,
            metadata: updated.metadata,
            updatedAt: updated.updated_at,
          }
        : null,
    });
  } catch (error) {
    logger.error("[Admin Docker Nodes] Failed to update node", {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: "Failed to update Docker node" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE — Remove node (only if no containers are running on it)
// ---------------------------------------------------------------------------

async function __hono_DELETE(request: Request, { params }: RouteParams) {
  try {
    const { role } = await requireAdmin(request);
    if (role !== "super_admin") {
      return Response.json(
        { success: false, error: "Super admin access required" },
        { status: 403 },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin access required";
    return Response.json({ success: false, error: message }, { status: 403 });
  }

  const { nodeId } = await params;

  try {
    const existing = await dockerNodesRepository.findByNodeId(nodeId);
    if (!existing) {
      return Response.json(
        { success: false, error: `Node '${nodeId}' not found` },
        { status: 404 },
      );
    }

    // Check for active containers on this node
    const activeContainers = await dbRead
      .select({ id: agentSandboxes.id })
      .from(agentSandboxes)
      .where(and(eq(agentSandboxes.node_id, nodeId), ne(agentSandboxes.status, "stopped")));

    if (activeContainers.length > 0) {
      return Response.json(
        {
          success: false,
          error: `Cannot remove node '${nodeId}': ${activeContainers.length} active container(s) still running. Stop or migrate them first.`,
        },
        { status: 409 },
      );
    }

    const deleted = await dockerNodesRepository.delete(existing.id);
    if (!deleted) {
      return Response.json(
        { success: false, error: "Failed to delete node record" },
        { status: 500 },
      );
    }

    logger.info("[Admin Docker Nodes] Node removed", { nodeId });

    return Response.json({
      success: true,
      data: { nodeId, deleted: true },
    });
  } catch (error) {
    logger.error("[Admin Docker Nodes] Failed to delete node", {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: "Failed to delete Docker node" },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ nodeId: c.req.param("nodeId")! }) }),
);
__hono_app.patch("/", async (c) =>
  __hono_PATCH(c.req.raw, { params: Promise.resolve({ nodeId: c.req.param("nodeId")! }) }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, { params: Promise.resolve({ nodeId: c.req.param("nodeId")! }) }),
);
export default __hono_app;

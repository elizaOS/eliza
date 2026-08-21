/**
 * Admin Docker Nodes API
 *
 * GET  /api/v1/admin/docker-nodes — List all Docker nodes with status & capacity
 * POST /api/v1/admin/docker-nodes — Register a new Docker node
 *
 * Requires super_admin role.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  dockerNodesRepository,
  stampDockerNodeEnvironmentMetadata,
} from "@/db/repositories/docker-nodes";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { containersEnv } from "@/lib/config/containers-env";
import { resolveNodeCapacity } from "@/lib/services/docker-node-manager";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// GET — List all Docker nodes
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  try {
    const { role } = await requireAdmin(c);
    if (role !== "super_admin") {
      return c.json(
        { success: false, error: "Super admin access required" },
        403,
      );
    }

    const nodes = await dockerNodesRepository.findAll();

    return c.json({
      success: true,
      data: {
        nodes: nodes.map((n) => ({
          id: n.id,
          nodeId: n.node_id,
          hostname: n.hostname,
          sshPort: n.ssh_port,
          sshUser: n.ssh_user,
          capacity: n.capacity,
          allocatedCount: n.allocated_count,
          availableSlots: n.capacity - n.allocated_count,
          enabled: n.enabled,
          status: n.status,
          lastHealthCheck: n.last_health_check,
          metadata: n.metadata,
          createdAt: n.created_at,
          updatedAt: n.updated_at,
        })),
        total: nodes.length,
      },
    });
  } catch (error) {
    logger.error("[Admin Docker Nodes] Failed to list nodes", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

// ---------------------------------------------------------------------------
// POST — Register a new Docker node
// ---------------------------------------------------------------------------

/**
 * Reject hostnames that resolve to private/reserved IP ranges.
 * Defense-in-depth — even though this is admin-only, it prevents accidental
 * registration of cloud metadata endpoints or loopback addresses.
 */
function isReservedAddress(hostname: string): boolean {
  const reserved = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^::1$/,
    /^localhost$/i,
    /^metadata\./i,
  ];
  return reserved.some((re) => re.test(hostname));
}

/** Only when the operator supplies neither a capacity nor the box's RAM. */
const DEFAULT_REGISTERED_CAPACITY = 8;

const createNodeSchema = z.object({
  nodeId: z.string().min(1, "nodeId is required"),
  hostname: z
    .string()
    .min(1, "hostname is required")
    .refine(
      (h) => !isReservedAddress(h),
      "Hostname cannot be a private/reserved IP address (loopback, RFC-1918, link-local, metadata)",
    ),
  sshPort: z.number().int().min(1).max(65535).optional().default(22),
  // No default and an explicit ceiling: absent means "derive from the machine",
  // and an operator can no longer register an unbounded slot count.
  capacity: z.number().int().min(1).max(1024).optional(),
  /** MemTotal of the box, in MiB, when the operator knows it. */
  memTotalMb: z.number().int().min(1).optional(),
  /** vCPU the node reports, from nproc. */
  vCpuCount: z.number().int().min(1).max(512).optional(),
  sshUser: z.string().min(1).optional().default("root"),
  hostKeyFingerprint: z.string().min(1),
});

app.post("/", async (c) => {
  try {
    const { role } = await requireAdmin(c);
    if (role !== "super_admin") {
      return c.json(
        { success: false, error: "Super admin access required" },
        403,
      );
    }

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;

    const parsed = createNodeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        },
        400,
      );
    }

    const {
      nodeId,
      hostname,
      sshPort,
      capacity,
      memTotalMb,
      vCpuCount,
      sshUser,
      hostKeyFingerprint,
    } = parsed.data;

    const existing = await dockerNodesRepository.findByNodeId(nodeId);
    if (existing) {
      return c.json(
        { success: false, error: `Node with id '${nodeId}' already exists` },
        409,
      );
    }

    const resolved = resolveNodeCapacity({
      requestedCapacity: capacity,
      memTotalMb,
      vCpuCount,
      agentMemoryLimitMb: containersEnv.agentContainerMemoryLimitMb(),
      fallbackCapacity: DEFAULT_REGISTERED_CAPACITY,
    });
    if (resolved.clampedFrom !== undefined) {
      logger.error(
        "[Admin Docker Nodes] requested capacity exceeds what this node's RAM can hold",
        {
          nodeId,
          requested: resolved.clampedFrom,
          capacity: resolved.capacity,
          memTotalMb,
        },
      );
    }

    const node = await dockerNodesRepository.create({
      node_id: nodeId,
      hostname,
      ssh_port: sshPort,
      capacity: resolved.capacity,
      ssh_user: sshUser,
      host_key_fingerprint: hostKeyFingerprint,
      metadata: stampDockerNodeEnvironmentMetadata({
        ...(memTotalMb === undefined ? {} : { memTotalMb }),
        ...(vCpuCount === undefined ? {} : { vCpuCount }),
        capacityBoundBy: resolved.boundBy,
        capacityDerivedFromMemory: resolved.derived,
      }),
    });

    logger.info("[Admin Docker Nodes] Node registered", {
      nodeId,
      hostname,
      capacity: resolved.capacity,
      derivedFromMemory: resolved.derived,
    });

    const responseData: {
      id: string;
      nodeId: string;
      hostname: string;
      sshPort: number;
      sshUser: string;
      capacity: number;
      allocatedCount: number;
      enabled: boolean;
      status: string;
      createdAt: Date;
    } = {
      id: node.id,
      nodeId: node.node_id,
      hostname: node.hostname,
      sshPort: node.ssh_port,
      sshUser: node.ssh_user,
      capacity: node.capacity,
      allocatedCount: node.allocated_count,
      enabled: node.enabled,
      status: node.status,
      createdAt: node.created_at,
    };

    return c.json(
      {
        success: true,
        data: responseData,
      },
      201,
    );
  } catch (error) {
    logger.error("[Admin Docker Nodes] Failed to register node", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;

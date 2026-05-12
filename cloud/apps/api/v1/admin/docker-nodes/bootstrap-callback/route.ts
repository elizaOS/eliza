import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Bootstrap callback: cloud-init on a fresh node POSTs here to self-
 * register into the docker_nodes table.
 *
 * Used for operator-provisioned servers (auctioned boxes, manually
 * bought VPS) — autoscaler-provisioned servers already have a row
 * created at provision time, so they only call this to confirm
 * liveness.
 *
 * Auth: shared secret via X-Bootstrap-Secret header. The secret is
 * specified in cloud-init at provision time and stored only in the
 * Hetzner server's user_data, so it leaks no further than that node.
 *
 * Required env: `CONTAINERS_BOOTSTRAP_SECRET`.
 */

import { z } from "zod";
import { dockerNodesRepository } from "@/db/repositories/docker-nodes";
import { logger } from "@/lib/utils/logger";

const callbackSchema = z.object({
  nodeId: z.string().min(1).max(64),
  hostname: z.string().min(1).max(255),
  capacity: z.number().int().min(1).max(64).optional().default(8),
  sshPort: z.number().int().min(1).max(65535).optional().default(22),
  sshUser: z.string().min(1).max(32).optional().default("root"),
  hostKeyFingerprint: z.string().min(1).max(128).optional(),
});

async function __hono_POST(request: Request) {
  const expected = process.env.CONTAINERS_BOOTSTRAP_SECRET;
  if (!expected) {
    return Response.json(
      {
        success: false,
        error:
          "Bootstrap callback is not configured. Set CONTAINERS_BOOTSTRAP_SECRET on the control plane.",
      },
      { status: 503 },
    );
  }

  const provided = request.headers.get("x-bootstrap-secret");
  if (!provided || !timingSafeEquals(provided, expected)) {
    logger.warn("[admin/docker-nodes/bootstrap-callback] rejected: bad or missing secret");
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = callbackSchema.safeParse(body);
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

  const { nodeId, hostname, capacity, sshPort, sshUser, hostKeyFingerprint } = parsed.data;

  try {
    const existing = await dockerNodesRepository.findByNodeId(nodeId);
    if (existing) {
      const updated = await dockerNodesRepository.update(existing.id, {
        hostname,
        ssh_port: sshPort,
        ssh_user: sshUser,
        capacity,
        host_key_fingerprint: hostKeyFingerprint ?? existing.host_key_fingerprint,
        status: "unknown",
        metadata: {
          ...((existing.metadata as Record<string, unknown>) ?? {}),
          lastBootstrapAt: new Date().toISOString(),
        },
      });
      logger.info("[admin/docker-nodes/bootstrap-callback] re-bootstrapped existing node", {
        nodeId,
        hostname,
      });
      return Response.json({
        success: true,
        data: { nodeId, hostname, action: "updated", node: updated },
      });
    }

    const created = await dockerNodesRepository.create({
      node_id: nodeId,
      hostname,
      ssh_port: sshPort,
      ssh_user: sshUser,
      capacity,
      enabled: true,
      status: "unknown",
      allocated_count: 0,
      host_key_fingerprint: hostKeyFingerprint,
      metadata: {
        provider: "operator-provisioned",
        bootstrappedAt: new Date().toISOString(),
      },
    });
    logger.info("[admin/docker-nodes/bootstrap-callback] registered new node", {
      nodeId,
      hostname,
    });
    return Response.json({
      success: true,
      data: { nodeId, hostname, action: "created", node: created },
    });
  } catch (error) {
    logger.error("[admin/docker-nodes/bootstrap-callback] failed", {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Bootstrap registration failed",
      },
      { status: 500 },
    );
  }
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) => __hono_POST(c.req.raw));
export default __hono_app;

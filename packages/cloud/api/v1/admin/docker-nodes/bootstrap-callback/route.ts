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
 * Because that secret sits in every node's user_data, any single node
 * compromise leaks it — so possession of the secret alone must not let a
 * caller re-point an existing node's SSH target (that would MITM the control
 * plane's SSH). The SSH identity (hostname/ssh_user/ssh_port) is therefore
 * immutable once a node is registered: only a fresh insert may set it, a
 * host_key_fingerprint is required on every call, and an already-pinned
 * fingerprint may not be swapped. That decision lives in the pure
 * `evaluateBootstrap` guard so it is unit-testable without a DB. (finding M2,
 * #12876 / #12227).
 *
 * Required env: `CONTAINERS_BOOTSTRAP_SECRET`.
 */

import { z } from "zod";
import {
  type DockerNode,
  dockerNodesRepository,
} from "@/db/repositories/docker-nodes";
import { logger } from "@/lib/utils/logger";

const callbackSchema = z.object({
  nodeId: z.string().min(1).max(64),
  hostname: z.string().min(1).max(255),
  capacity: z.number().int().min(1).max(64).optional().default(8),
  sshPort: z.number().int().min(1).max(65535).optional().default(22),
  sshUser: z.string().min(1).max(32).optional().default("root"),
  hostKeyFingerprint: z.string().min(1).max(128),
});

/** The client-supplied SSH identity a bootstrap call asserts for a node. */
export type BootstrapIdentity = {
  hostname: string;
  sshPort: number;
  sshUser: string;
  hostKeyFingerprint: string;
};

/** The subset of an existing node row the guard compares against. */
type ExistingNodeIdentity = Pick<
  DockerNode,
  "hostname" | "ssh_port" | "ssh_user" | "host_key_fingerprint"
>;

export type BootstrapDecision =
  | { action: "reject"; status: 400 | 409; error: string }
  | { action: "create" }
  | { action: "update" };

/**
 * Decide whether a bootstrap-callback POST may register a new node, refresh an
 * existing node's liveness, or must be rejected — the security core of the
 * route (finding M2). Pure so the SSH-target-immutability invariant can be
 * exercised without a live Worker or Postgres.
 *
 * Rejections: a missing fingerprint (400); any change to an existing node's
 * hostname/ssh_user/ssh_port (409); or a fingerprint that differs from an
 * already-pinned one (409). A never-pinned node (null fingerprint) may set it
 * on the next call as long as the SSH target is unchanged.
 */
export function evaluateBootstrap(
  existing: ExistingNodeIdentity | null,
  input: BootstrapIdentity,
): BootstrapDecision {
  if (!input.hostKeyFingerprint) {
    return {
      action: "reject",
      status: 400,
      error: "host_key_fingerprint is required",
    };
  }
  if (!existing) {
    return { action: "create" };
  }
  if (
    input.hostname !== existing.hostname ||
    input.sshUser !== existing.ssh_user ||
    input.sshPort !== existing.ssh_port
  ) {
    return {
      action: "reject",
      status: 409,
      error:
        "SSH target (hostname/ssh_user/ssh_port) of an existing node cannot be changed via bootstrap-callback",
    };
  }
  if (
    existing.host_key_fingerprint &&
    existing.host_key_fingerprint !== input.hostKeyFingerprint
  ) {
    return {
      action: "reject",
      status: 409,
      error:
        "host key fingerprint mismatch; refusing to re-pin an existing node",
    };
  }
  return { action: "update" };
}

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
    logger.warn(
      "[admin/docker-nodes/bootstrap-callback] rejected: bad or missing secret",
    );
    return Response.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
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

  const { nodeId, hostname, capacity, sshPort, sshUser, hostKeyFingerprint } =
    parsed.data;

  try {
    const existing = await dockerNodesRepository.findByNodeId(nodeId);
    const decision = evaluateBootstrap(existing, {
      hostname,
      sshPort,
      sshUser,
      hostKeyFingerprint,
    });

    if (decision.action === "reject") {
      logger.warn(
        "[admin/docker-nodes/bootstrap-callback] rejected node mutation",
        { nodeId, reason: decision.error },
      );
      return Response.json(
        { success: false, error: decision.error },
        { status: decision.status },
      );
    }

    if (existing) {
      // decision.action === "update": the guard proved the SSH target is
      // unchanged, so we refresh only liveness/capacity and never re-write
      // hostname/ssh_user/ssh_port.
      const updated = await dockerNodesRepository.update(existing.id, {
        capacity,
        host_key_fingerprint: hostKeyFingerprint,
        status: "unknown",
        metadata: {
          ...(existing.metadata ?? {}),
          lastBootstrapAt: new Date().toISOString(),
        },
      });
      logger.info(
        "[admin/docker-nodes/bootstrap-callback] re-bootstrapped existing node",
        { nodeId },
      );
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
        error:
          error instanceof Error
            ? error.message
            : "Bootstrap registration failed",
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

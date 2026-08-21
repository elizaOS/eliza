/**
 * Registers Docker node bootstrap callbacks from provisioned control-plane hosts.
 */
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
 * Because that secret is present on every node, it is a weak identity
 * proof for mutating an EXISTING node: a single node compromise would
 * let an attacker re-point another node's SSH target. So on re-bootstrap
 * the server-stored identity (hostname/ssh_user/ssh_port) is
 * authoritative; changing it requires presenting the pinned host key
 * fingerprint (#12876).
 *
 * Required env: `CONTAINERS_BOOTSTRAP_SECRET`.
 */

import { z } from "zod";
import {
  dockerNodesRepository,
  stampDockerNodeEnvironmentMetadata,
} from "@/db/repositories/docker-nodes";
import { containersEnv } from "@/lib/config/containers-env";
import {
  attestHetznerCloudNode,
  isTypedHetznerCloudNode,
} from "@/lib/services/containers/hetzner-node-attestation";
import { resolveNodeCapacity } from "@/lib/services/docker-node-manager";
import { logger } from "@/lib/utils/logger";

/**
 * Used only when the node reports neither a capacity nor its RAM. Preserves the
 * historical default rather than guessing, and the create path logs the skip.
 */
const DEFAULT_CALLBACK_CAPACITY = 8;
const MAX_CALLBACK_CAPACITY = 64;
/** 16 TiB in MiB: generous hardware headroom while remaining a bounded contract. */
const MAX_CALLBACK_MEM_TOTAL_MB = 16 * 1024 * 1024;

const callbackSchema = z.object({
  nodeId: z.string().min(1).max(64),
  hostname: z.string().min(1).max(255),
  // No default: an absent capacity means "derive it from the machine", which
  // is not the same request as an explicit 8.
  capacity: z.number().int().min(1).max(MAX_CALLBACK_CAPACITY).optional(),
  /** MemTotal reported by the node itself, in MiB. */
  memTotalMb: z.number().int().min(1).max(MAX_CALLBACK_MEM_TOTAL_MB).optional(),
  /** vCPU the node reports, from nproc. */
  vCpuCount: z.number().int().min(1).max(512).optional(),
  sshPort: z.number().int().min(1).max(65535).optional().default(22),
  sshUser: z.string().min(1).max(32).optional().default("root"),
  hostKeyFingerprint: z.string().min(1).max(128),
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

  const {
    nodeId,
    hostname,
    capacity,
    memTotalMb,
    vCpuCount,
    sshPort,
    sshUser,
    hostKeyFingerprint,
  } = parsed.data;

  try {
    const existing = await dockerNodesRepository.findByNodeId(nodeId);
    if (existing) {
      // Re-bootstrap identity guard (#12876). The bootstrap secret lives in
      // every node's cloud-init user_data, so a single node compromise leaks a
      // credential that can re-point ANY node by nodeId. Rewriting an existing
      // node's SSH target (hostname/ssh_user/ssh_port) would let that attacker
      // aim the control plane's SSH at a MITM host. Identity mutation is
      // therefore allowed only when the caller proves control of the node by
      // presenting the pinned host key fingerprint; otherwise the server-stored
      // identity is authoritative and the mutation is refused.
      const identityChanged =
        hostname !== existing.hostname ||
        sshUser !== existing.ssh_user ||
        sshPort !== existing.ssh_port;
      const pinned = existing.host_key_fingerprint;
      const hasPinnedFingerprint = pinned !== null;
      const fingerprintMatches =
        hasPinnedFingerprint && timingSafeEquals(hostKeyFingerprint, pinned);
      const fingerprintChanged =
        hasPinnedFingerprint && !timingSafeEquals(hostKeyFingerprint, pinned);

      if (identityChanged) {
        if (!fingerprintMatches) {
          logger.warn(
            "[admin/docker-nodes/bootstrap-callback] rejected node-identity mutation without matching host key fingerprint",
            { nodeId },
          );
          return Response.json(
            {
              success: false,
              error:
                "Node identity (hostname/ssh_user/ssh_port) cannot be changed on re-bootstrap without presenting the pinned host key fingerprint.",
            },
            { status: 409 },
          );
        }
      }
      if (fingerprintChanged) {
        logger.warn(
          "[admin/docker-nodes/bootstrap-callback] rejected host-key fingerprint mutation on existing node",
          { nodeId },
        );
        return Response.json(
          {
            success: false,
            error:
              "Host key fingerprint is required and must match the existing node pin; rotate it through an authenticated control-plane operation.",
          },
          { status: 409 },
        );
      }

      const existingMetadata = existing.metadata as Record<string, unknown>;
      if (existingMetadata.capacityProvisional === true) {
        const persistedRequest = existingMetadata.capacityRequested;
        if (
          persistedRequest !== null &&
          (typeof persistedRequest !== "number" ||
            !Number.isSafeInteger(persistedRequest) ||
            persistedRequest < 1 ||
            persistedRequest > MAX_CALLBACK_CAPACITY)
        ) {
          logger.error(
            "[admin/docker-nodes/bootstrap-callback] provisional capacity metadata is invalid",
            { nodeId },
          );
          return Response.json(
            {
              success: false,
              error: "Provisional capacity metadata is invalid.",
            },
            { status: 409 },
          );
        }
        const requestedCapacity =
          persistedRequest === null ? undefined : persistedRequest;
        if (capacity !== requestedCapacity) {
          return Response.json(
            {
              success: false,
              error:
                "Bootstrap capacity does not match the autoscaler request recorded for this node.",
            },
            { status: 409 },
          );
        }
        if (memTotalMb === undefined || vCpuCount === undefined) {
          return Response.json(
            {
              success: false,
              error:
                "A provisional autoscaled node must report both memTotalMb and vCpuCount before it can advertise capacity.",
            },
            { status: 422 },
          );
        }

        const resolved = resolveNodeCapacity({
          requestedCapacity,
          memTotalMb,
          vCpuCount,
          agentMemoryLimitMb: containersEnv.agentContainerMemoryLimitMb(),
          fallbackCapacity: DEFAULT_CALLBACK_CAPACITY,
        });
        if (resolved.capacity > MAX_CALLBACK_CAPACITY) {
          logger.error(
            "[admin/docker-nodes/bootstrap-callback] derived capacity exceeds callback contract",
            { nodeId, capacity: resolved.capacity, memTotalMb, vCpuCount },
          );
          return Response.json(
            {
              success: false,
              error: `Derived capacity exceeds the maximum of ${MAX_CALLBACK_CAPACITY}.`,
            },
            { status: 422 },
          );
        }

        if (isTypedHetznerCloudNode(existing)) {
          await attestHetznerCloudNode(existing);
        }

        if (!hasPinnedFingerprint) {
          await dockerNodesRepository.rotateNodeHostKeyFingerprint({
            id: existing.id,
            nodeId,
            expectedFingerprint: null,
            observedFingerprint: hostKeyFingerprint,
          });
        }

        const attestedAt = new Date().toISOString();
        const reconciled =
          await dockerNodesRepository.reconcileProvisionalCapacity(
            existing.id,
            {
              capacity: resolved.capacity,
              hostname: identityChanged ? hostname : existing.hostname,
              ssh_port: identityChanged ? sshPort : existing.ssh_port,
              ssh_user: identityChanged ? sshUser : existing.ssh_user,
              status: "unknown",
            },
            stampDockerNodeEnvironmentMetadata({
              memTotalMb,
              vCpuCount,
              capacityBoundBy: resolved.boundBy,
              capacityDerivedFromMemory: resolved.derived,
              capacityAttestedAt: attestedAt,
              lastBootstrapAt: attestedAt,
            }),
          );

        // A concurrent first callback may have consumed the marker after our
        // read. The repository predicate is the authority; re-read its result
        // instead of performing a second capacity write.
        const updated =
          reconciled ?? (await dockerNodesRepository.findByNodeId(nodeId));
        logger.info(
          "[admin/docker-nodes/bootstrap-callback] hardware-attested autoscaled node capacity",
          {
            nodeId,
            capacity: updated?.capacity ?? existing.capacity,
            reconciled: reconciled !== null,
          },
        );
        return Response.json({
          success: true,
          data: {
            nodeId,
            hostname: updated?.hostname ?? existing.hostname,
            action: "updated",
            node: updated,
          },
        });
      }

      // Identity fields are only ever taken from the request on a
      // fingerprint-proven re-bootstrap (identityChanged && verified above);
      // otherwise the server-stored values are preserved verbatim so an
      // unauthenticated re-bootstrap caller cannot silently rewrite them.
      //
      // `capacity` is deliberately NOT written here once the provisional
      // marker has been consumed: the slot count is then operator-owned (set
      // via the admin PATCH route or a direct DB tune). The callback default
      // is sized for the small cpx32-class box
      // it was born on, so re-writing it on every liveness re-bootstrap would
      // silently reset a hand-tuned value (e.g. a 252 GB robot at capacity=24
      // back to 8). Capacity is stamped only on the create path below.
      if (!hasPinnedFingerprint) {
        await dockerNodesRepository.rotateNodeHostKeyFingerprint({
          id: existing.id,
          nodeId,
          expectedFingerprint: null,
          observedFingerprint: hostKeyFingerprint,
        });
      }
      const updated = await dockerNodesRepository.update(existing.id, {
        hostname: identityChanged ? hostname : existing.hostname,
        ssh_port: identityChanged ? sshPort : existing.ssh_port,
        ssh_user: identityChanged ? sshUser : existing.ssh_user,
        status: "unknown",
        metadata: stampDockerNodeEnvironmentMetadata({
          ...((existing.metadata as Record<string, unknown>) ?? {}),
          lastBootstrapAt: new Date().toISOString(),
        }),
      });
      logger.info(
        "[admin/docker-nodes/bootstrap-callback] re-bootstrapped existing node",
        {
          nodeId,
          hostname: updated?.hostname ?? existing.hostname,
        },
      );
      return Response.json({
        success: true,
        data: {
          nodeId,
          hostname: updated?.hostname ?? existing.hostname,
          action: "updated",
          node: updated,
        },
      });
    }

    const resolved = resolveNodeCapacity({
      requestedCapacity: capacity,
      memTotalMb,
      vCpuCount,
      agentMemoryLimitMb: containersEnv.agentContainerMemoryLimitMb(),
      fallbackCapacity: DEFAULT_CALLBACK_CAPACITY,
    });
    if (resolved.capacity > MAX_CALLBACK_CAPACITY) {
      return Response.json(
        {
          success: false,
          error: `Derived capacity exceeds the maximum of ${MAX_CALLBACK_CAPACITY}.`,
        },
        { status: 422 },
      );
    }
    if (memTotalMb === undefined) {
      logger.warn(
        "[admin/docker-nodes/bootstrap-callback] node did not report its RAM; capacity not derived",
        { nodeId, capacity: resolved.capacity },
      );
    } else if (resolved.clampedFrom !== undefined) {
      logger.error(
        "[admin/docker-nodes/bootstrap-callback] requested capacity exceeds what this node's RAM can hold",
        {
          nodeId,
          requested: resolved.clampedFrom,
          capacity: resolved.capacity,
          memTotalMb,
        },
      );
    }

    const created = await dockerNodesRepository.create({
      node_id: nodeId,
      hostname,
      ssh_port: sshPort,
      ssh_user: sshUser,
      capacity: resolved.capacity,
      enabled: true,
      status: "unknown",
      allocated_count: 0,
      host_key_fingerprint: hostKeyFingerprint,
      metadata: stampDockerNodeEnvironmentMetadata({
        provider: "operator-provisioned",
        bootstrappedAt: new Date().toISOString(),
        ...(memTotalMb === undefined ? {} : { memTotalMb }),
        ...(vCpuCount === undefined ? {} : { vCpuCount }),
        capacityBoundBy: resolved.boundBy,
        capacityDerivedFromMemory: resolved.derived,
      }),
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

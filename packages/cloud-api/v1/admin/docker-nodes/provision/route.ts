import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Admin: provision a new Hetzner Cloud node into the Docker pool.
 *
 * Synchronously creates a Hetzner Cloud server with the cloud-init
 * bootstrap baked in, inserts a docker_nodes row, and returns the
 * resulting node id + IP. The next health-check tick flips status from
 * `unknown` to `healthy` once Docker is up.
 *
 * Requires super_admin. Requires `HCLOUD_TOKEN` and a control plane
 * SSH public key supplied at request time (so the operator can rotate
 * keys without redeploying the API).
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { HetznerCloudError } from "@/lib/services/containers/hetzner-cloud-api";
import { getNodeAutoscaler } from "@/lib/services/containers/node-autoscaler";
import { logger } from "@/lib/utils/logger";

const provisionSchema = z.object({
  /** Optional logical id; auto-generated if omitted. */
  nodeId: z.string().min(1).max(64).optional(),
  /** Hetzner server type — defaults to the autoscaler's policy default. */
  serverType: z.string().min(1).max(32).optional(),
  /** Datacenter shorthand (e.g. "fsn1", "nbg1", "hel1", "ash"). */
  location: z.string().min(1).max(16).optional(),
  /** Image name (e.g. "ubuntu-24.04"). */
  image: z.string().min(1).max(64).optional(),
  /** Per-node capacity (slot count) advertised to the scheduler. */
  capacity: z.number().int().min(1).max(64).optional(),
  /** Free-form labels to tag the Hetzner server with. */
  labels: z.record(z.string(), z.string()).optional(),
  /** Image references to pre-pull on the new node so first deploys are fast. */
  prePullImages: z.array(z.string().min(1)).optional(),
  /**
   * Public SSH key the cloud-init script writes into root's authorized_keys
   * so the control plane can SSH in. The matching private key must already
   * be loaded by the control plane (CONTAINERS_SSH_KEY / AGENT_SSH_KEY).
   */
  controlPlanePublicKey: z.string().min(1),
  /** Optional self-registration callback URL (typically the bootstrap-callback route). */
  registrationUrl: z.string().url().optional(),
  /** Shared secret for the registration callback. */
  registrationSecret: z.string().min(8).optional(),
});

async function __hono_POST(request: Request) {
  const { role } = await requireAdmin(request);
  if (role !== "super_admin") {
    return Response.json({ success: false, error: "Super admin access required" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = provisionSchema.safeParse(body);
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
    const result = await getNodeAutoscaler().provisionNode(
      {
        nodeId: parsed.data.nodeId,
        serverType: parsed.data.serverType,
        location: parsed.data.location,
        image: parsed.data.image,
        capacity: parsed.data.capacity,
        prePullImages: parsed.data.prePullImages,
        labels: parsed.data.labels,
      },
      {
        controlPlanePublicKey: parsed.data.controlPlanePublicKey,
        registrationUrl: parsed.data.registrationUrl,
        registrationSecret: parsed.data.registrationSecret,
      },
    );

    return Response.json({
      success: true,
      data: {
        nodeId: result.nodeId,
        hostname: result.hostname,
        hcloudServerId: result.hcloudServerId,
        rootPassword: result.rootPassword,
        message:
          "Node provisioned. Cloud-init is now installing Docker — first health-check tick will flip status from `unknown` to `healthy`.",
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
        {
          success: false,
          error: error.message,
          code: error.code,
        },
        { status: statusByCode[error.code] ?? 500 },
      );
    }

    logger.error("[admin/docker-nodes/provision] failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to provision node",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) => __hono_POST(c.req.raw));
export default __hono_app;

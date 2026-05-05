import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Node autoscale cron handler.
 *
 * Runs the autoscaler's capacity evaluation, provisions a new node if
 * the pool is below the free-slot buffer, and drains long-idle empty
 * nodes if any are eligible. Only one provision per tick — the cron
 * cadence (5 min recommended) gives enough opportunities for bursty
 * demand without runaway parallel provisions.
 *
 * Drain is bounded to one node per tick for the same reason.
 *
 * Required env (in addition to standard cron auth):
 *  - HCLOUD_TOKEN — Hetzner Cloud API token.
 *  - CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY — control plane SSH public key
 *    written into authorized_keys on every newly provisioned node.
 *  - CONTAINERS_BOOTSTRAP_CALLBACK_URL (optional) — full URL to the
 *    bootstrap-callback route so cloud-init can self-confirm.
 *  - CONTAINERS_BOOTSTRAP_SECRET (optional) — shared secret expected by
 *    the bootstrap-callback route.
 */

import { verifyCronSecret } from "@/lib/api/cron-auth";
import { isHetznerCloudConfigured } from "@/lib/services/containers/hetzner-cloud-api";
import { getNodeAutoscaler } from "@/lib/services/containers/node-autoscaler";
import { logger } from "@/lib/utils/logger";

async function handleAutoscale(request: Request, env?: AppEnv["Bindings"]) {
  const authError = verifyCronSecret(request, "[Node Autoscale]", env);
  if (authError) return authError;

  const autoscaler = getNodeAutoscaler();
  const decision = await autoscaler.evaluateCapacity();

  if (!decision.shouldScaleUp && decision.shouldScaleDownNodeIds.length === 0) {
    logger.info("[Node Autoscale] steady", decision);
    return Response.json({
      success: true,
      data: { ...decision, action: "noop" },
    });
  }

  const result: Record<string, unknown> = { ...decision, actions: [] as unknown[] };

  if (decision.shouldScaleUp) {
    if (!isHetznerCloudConfigured()) {
      logger.warn("[Node Autoscale] would scale up but HCLOUD_TOKEN is not set");
      (result.actions as unknown[]).push({
        type: "scale_up_skipped",
        reason: "HCLOUD_TOKEN not configured",
      });
    } else {
      const publicKey = process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY;
      if (!publicKey || publicKey.trim().length === 0) {
        logger.warn(
          "[Node Autoscale] would scale up but CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY is not set",
        );
        (result.actions as unknown[]).push({
          type: "scale_up_skipped",
          reason: "CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY not configured",
        });
      } else {
        try {
          const provisioned = await autoscaler.provisionNode(
            {},
            {
              controlPlanePublicKey: publicKey,
              registrationUrl: process.env.CONTAINERS_BOOTSTRAP_CALLBACK_URL,
              registrationSecret: process.env.CONTAINERS_BOOTSTRAP_SECRET,
            },
          );
          (result.actions as unknown[]).push({
            type: "provisioned",
            nodeId: provisioned.nodeId,
            hostname: provisioned.hostname,
            hcloudServerId: provisioned.hcloudServerId,
          });
        } catch (err) {
          logger.error("[Node Autoscale] provision failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          (result.actions as unknown[]).push({
            type: "scale_up_failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  if (decision.shouldScaleDownNodeIds.length > 0) {
    const target = decision.shouldScaleDownNodeIds[0]!;
    try {
      await autoscaler.drainNode(target, { deprovision: true });
      (result.actions as unknown[]).push({ type: "drained", nodeId: target });
    } catch (err) {
      logger.error("[Node Autoscale] drain failed", {
        nodeId: target,
        error: err instanceof Error ? err.message : String(err),
      });
      (result.actions as unknown[]).push({
        type: "drain_failed",
        nodeId: target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({ success: true, data: result });
}

async function __hono_GET(request: Request, env?: AppEnv["Bindings"]) {
  return handleAutoscale(request, env);
}

async function __hono_POST(request: Request, env?: AppEnv["Bindings"]) {
  return handleAutoscale(request, env);
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw, c.env));
__hono_app.post("/", async (c) => __hono_POST(c.req.raw, c.env));
export default __hono_app;

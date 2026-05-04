/**
 * GET /api/v1/containers/[id]/logs?tail=200
 *
 * `tailLogs` runs `docker logs --tail N` over SSH via the Hetzner-Docker
 * client (`ssh2`, Node-only). Workers forward this request to the Node
 * container control plane when configured.
 */

import { Hono } from "hono";

import { forwardToContainerControlPlane } from "../../../_container-control-plane-forward";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    return forwardToContainerControlPlane(c, user);
  } catch (error) {
    logger.error("[Containers API] logs forward error:", error);
    return failureResponse(c, error);
  }
});

export default app;

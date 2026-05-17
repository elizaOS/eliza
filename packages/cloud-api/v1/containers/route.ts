/**
 * Containers API
 *
 * GET  /api/v1/containers — list containers for the authed user's org (Workers-safe).
 * POST /api/v1/containers — create + deploy a container. The Hetzner-Docker
 *   client transitively imports `ssh2`, so Workers forward this mutation to
 *   the Node container control plane when configured.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { listContainers } from "@/lib/services/containers";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { forwardToContainerControlPlane } from "../_container-control-plane-forward";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const containers = await listContainers(user.organization_id);
    return c.json({ success: true, data: containers });
  } catch (error) {
    logger.error("[Containers API] list error:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    return forwardToContainerControlPlane(c, user);
  } catch (error) {
    logger.error("[Containers API] create forward error:", error);
    return failureResponse(c, error);
  }
});

export default app;

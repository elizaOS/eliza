/**
 * Containers API
 *
 * GET  /api/v1/containers — list containers for the authed user's org (Workers-safe).
 * POST /api/v1/containers — create + deploy a container. Stubbed at 501 on the
 *   Worker because the Hetzner-Docker client transitively imports `ssh2`,
 *   which is Node-only. The Node sidecar serves POST; see
 *   `cloud/CONTAINERS_MIGRATION.md`.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { listContainers } from "@/lib/services/containers";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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

app.post("/", (c) =>
  c.json(
    {
      success: false,
      error: "not_yet_migrated",
      reason: "node-only dep: ssh2 (Hetzner-Docker client). Sidecar serves this endpoint.",
    },
    501,
  ),
);

export default app;

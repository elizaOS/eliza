/**
 * GET /api/v1/admin/infrastructure
 *
 * Stubbed at 501 on the Worker. The original handler calls
 * `getAdminInfrastructureSnapshot`, which transitively imports `ssh2`
 * (Node-only) for live Docker-node SSH inspection. Sidecar handles this;
 * SPA gets a clear 501 instead of a 404.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.all("*", (c) =>
  c.json(
    {
      success: false,
      error: "not_yet_migrated",
      reason: "node-only dep: ssh2 (DockerSSHClient via admin-infrastructure snapshot).",
    },
    501,
  ),
);

export default app;

/**
 * GET /api/v1/admin/infrastructure
 *
 * Explicit 501 on the Worker. The original handler calls
 * `getAdminInfrastructureSnapshot`, which transitively imports `ssh2`
 * (Node-only) for live Docker-node SSH inspection. Sidecar handles this;
 * SPA gets a clear 501 instead of a 404.
 */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.all("*", (c) =>
  c.json(
    {
      success: false,
      error: "not_yet_migrated",
      reason:
        "node-only dep: ssh2 (DockerSSHClient via admin-infrastructure snapshot).",
    },
    501,
  ),
);

export default app;

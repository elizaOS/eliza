/**
 * Admin Docker Container Logs API
 *
 * Worker boundary: DockerSSHClient depends on `ssh2`, which workerd cannot
 * load. Logs remain on the Node sidecar / Docker control-plane path.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.all("/*", (c) =>
  c.json(
    {
      error: "not_yet_migrated",
      reason: "DockerSSHClient (ssh2) is Node-only; needs Node sidecar",
    },
    501,
  ),
);

export default app;

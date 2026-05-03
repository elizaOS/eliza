/**
 * Admin Docker Node Health Check API
 *
 * TODO(node-only): blocked from Workers due to `ssh2` (DockerSSHClient).
 * Health check SSHs into the node and runs `docker version`/`df`/`docker ps`.
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

/**
 * GET /api/v1/containers/[id]/logs?tail=200
 *
 * 501 on the Worker — `tailLogs` runs `docker logs --tail N` over SSH via
 * the Hetzner-Docker client (`ssh2`, Node-only). The Node sidecar serves
 * this endpoint; see `cloud/CONTAINERS_MIGRATION.md`.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json(
    {
      success: false,
      error: "not_yet_migrated",
      reason: "node-only dep: ssh2 (docker logs over SSH). Sidecar serves this endpoint.",
    },
    501,
  ),
);

export default app;

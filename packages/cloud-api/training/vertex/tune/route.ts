// Worker boundary: the Vertex tune handler depends on node:fs. Keep this
// mounted as an explicit 501 until the operation moves to a Node sidecar.

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.all("*", (c) =>
  c.json(
    {
      success: false,
      error: "not_yet_migrated",
      reason: "node-only dep: node:fs",
    },
    501,
  ),
);

export default app;

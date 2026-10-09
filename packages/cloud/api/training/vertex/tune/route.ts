// Worker boundary: the Vertex tune handler depends on node:fs. Keep this
// mounted as an explicit 501 until the operation moves to a Node sidecar.

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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

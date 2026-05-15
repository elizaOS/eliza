// TODO(node-only): blocked from Workers due to node:fs
// Original handler preserved in git history.

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

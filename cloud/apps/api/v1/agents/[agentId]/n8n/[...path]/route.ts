/**
 * Catch-all route for n8n workflow plugin routes.
 *
 * TODO(node-only): blocked from Workers due to `@elizaos/core` runtime
 * factory pulling Node-shaped plugin code. Move to a Node sidecar or split
 * the plugin runtime out of this binary before re-enabling.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const handler = (c: import("hono").Context<AppEnv>) =>
  c.json(
    {
      error: "not_yet_migrated",
      reason: "n8n plugin runtime imports @elizaos/core (Node-only)",
    },
    501,
  );

app.all("/", handler);
app.all("/*", handler);

export default app;

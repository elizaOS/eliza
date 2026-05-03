/**
 * /api/eliza-app/webhook/discord — stubbed (withInternalAuth + elizaOS runtime are not Workers-compatible).
 *
 * When implemented, OAuth enforcement must use elizaAppConfig.appUrl for the /get-started redirect
 * (not a hardcoded URL) so the app URL is configurable. Example: `${elizaAppConfig.appUrl}/get-started`
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.all("/*", (c) =>
  c.json(
    {
      error: "not_yet_migrated",
      reason: "withInternalAuth + elizaOS runtime are not Workers-compatible",
    },
    501,
  ),
);
export default app;

/**
 * GET /api/v1/oauth/providers
 *
 * List all available OAuth providers with their configuration status.
 * Public endpoint — no authentication required.
 */

import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { oauthService } from "@elizaos/cloud-shared/lib/services/oauth";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", (c) => {
  try {
    c.header(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=7200",
    );
    return c.json({ providers: oauthService.listProviders() });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

/**
 * GET /api/v1/oauth/providers
 *
 * List all available OAuth providers with their configuration status.
 * Public endpoint — no authentication required.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { oauthService } from "@/lib/services/oauth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", (c) => {
  try {
    c.header("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");
    return c.json({ providers: oauthService.listProviders() });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

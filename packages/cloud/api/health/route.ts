/**
 * Health Check
 *
 * Lightweight health check endpoint for load balancers and uptime checks.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json(
    {
      status: "ok",
      timestamp: Date.now(),
      region: (c.env as { CF_REGION?: string }).CF_REGION ?? "unknown",
      // Parity with the index.ts fast-path health beacon (that one answers
      // `/api/health` before the app boots, so this route is normally shadowed).
      // Kept identical so the two can never disagree on which env answered.
      environment: (c.env as { ENVIRONMENT?: string }).ENVIRONMENT ?? null,
    },
    200,
    { "Cache-Control": "no-store, max-age=0" },
  ),
);

export default app;

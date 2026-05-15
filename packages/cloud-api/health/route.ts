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
    },
    200,
    { "Cache-Control": "no-store, max-age=0" },
  ),
);

export default app;

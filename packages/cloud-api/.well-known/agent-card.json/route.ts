/**
 * GET /api/.well-known/agent-card.json
 * Platform A2A Agent Card discovery for Eliza Cloud.
 */

import { Hono } from "hono";
import { getPlatformAgentCard } from "@/lib/api/a2a/platform-cloud";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json(getPlatformAgentCard(c), 200, {
    "Cache-Control": "public, max-age=300",
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  }),
);

export default app;

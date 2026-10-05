/**
 * GET /api/.well-known/agent-card.json
 * Platform A2A Agent Card discovery for Eliza Cloud.
 */

import { getPlatformAgentCard } from "@elizaos/cloud-shared/lib/api/a2a/platform-cloud";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json(getPlatformAgentCard(c), 200, {
    "Cache-Control": "public, max-age=300",
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  }),
);

export default app;

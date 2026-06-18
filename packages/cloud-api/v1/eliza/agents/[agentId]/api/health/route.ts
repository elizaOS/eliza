import { Hono } from "hono";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { sharedRestHealth } from "@/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/v1/eliza/agents/[agentId]/api/health
 *
 * Health for a SHARED-runtime agent's REST surface. A shared agent runs
 * in-Worker (no agent server), so its reachable REST base is this cloud-api
 * adapter; the mobile/web chat client hits `<webUiUrl>/api/health` to confirm
 * the agent is up before loading chat. Auth-gated (the client sends Bearer).
 */
const CORS_METHODS = "GET, OPTIONS";

const app = new Hono<AppEnv>();

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.get("/", async (c) => {
  await requireUserOrApiKeyWithOrg(c);
  return applyCorsHeaders(Response.json(sharedRestHealth()), CORS_METHODS);
});

export default app;

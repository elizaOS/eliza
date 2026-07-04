// Handles v1 cloud API v1 eliza agents agentid api health route traffic with route-local auth expectations.
import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
import { sharedRestHealth } from "@/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/v1/eliza/agents/[agentId]/api/health
 *
 * Health for a SHARED-runtime agent's REST surface. A shared agent runs
 * in-Worker (no agent server), so its reachable REST base is this cloud-api
 * adapter; the mobile/web chat client hits `<webUiUrl>/api/health` to confirm
 * the agent is up before loading chat. Goes through the same `resolveSharedAgent`
 * gate as its sibling leaves, so it 404s for a foreign/non-shared agent instead
 * of reporting "ok" for any id.
 */
const CORS_METHODS = "GET, OPTIONS";

const app = new Hono<AppEnv>();

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.get("/", async (c) => {
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return applyCorsHeaders(
      Response.json({ success: false, error: r.error }, { status: r.status }),
      CORS_METHODS,
    );
  }
  return applyCorsHeaders(Response.json(sharedRestHealth()), CORS_METHODS);
});

export default app;

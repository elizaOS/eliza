/**
 * GET /api/auth/cli-session/[sessionId]
 * Get the status of a CLI authentication session. Public — used by the CLI to
 * poll for completion.
 */

import { Hono } from "hono";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";
import { getCorsHeaders } from "@/lib/utils/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.options("/", (c) => {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(c.req.header("origin") ?? null),
  });
});

app.get("/", async (c) => {
  const corsHeaders = getCorsHeaders(c.req.header("origin") ?? null);
  try {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) {
      return c.json({ error: "Session ID is required" }, 400, corsHeaders);
    }

    const session = await cliAuthSessionsService.getActiveSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found or expired" }, 404, corsHeaders);
    }

    if (session.status === "authenticated") {
      const apiKeyData = await cliAuthSessionsService.getAndClearApiKey(sessionId);
      if (!apiKeyData) {
        return c.json(
          { status: "authenticated", message: "API key already retrieved" },
          200,
          corsHeaders,
        );
      }
      return c.json(
        {
          status: "authenticated",
          apiKey: apiKeyData.apiKey,
          keyPrefix: apiKeyData.keyPrefix,
          expiresAt: apiKeyData.expiresAt,
        },
        200,
        corsHeaders,
      );
    }

    return c.json({ status: session.status }, 200, corsHeaders);
  } catch (error) {
    logger.error("[CLI Auth] Error getting CLI auth session", { error });
    return c.json({ error: "Failed to get session status" }, 500, corsHeaders);
  }
});

export default app;

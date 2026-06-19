/**
 * GET /api/v1/cli-auth/:session/token
 *
 * Single-use CLI API-key retrieval. The session id is created by
 * /api/auth/cli-session and completed by the authenticated browser flow.
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
    const sessionId = c.req.param("session");
    if (!sessionId) {
      return c.json({ error: "Session ID is required" }, 400, corsHeaders);
    }

    const session = await cliAuthSessionsService.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404, corsHeaders);
    }
    if (session.consumed_at) {
      return c.json({ error: "Token already retrieved" }, 410, corsHeaders);
    }
    if (session.status === "expired" || new Date() > session.expires_at) {
      return c.json({ error: "Session expired" }, 410, corsHeaders);
    }
    if (session.status !== "authenticated") {
      return c.json({ status: session.status }, 202, corsHeaders);
    }

    const apiKeyData =
      await cliAuthSessionsService.getAndClearApiKey(sessionId);
    if (!apiKeyData) {
      return c.json({ error: "Token unavailable" }, 410, corsHeaders);
    }

    return c.json(
      {
        apiKey: apiKeyData.apiKey,
        keyPrefix: apiKeyData.keyPrefix,
        expiresAt: apiKeyData.expiresAt,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    logger.error("[CLI Auth] Error retrieving CLI auth token", { error });
    return c.json({ error: "Failed to retrieve CLI token" }, 500, corsHeaders);
  }
});

export default app;

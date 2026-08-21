/**
 * GET /api/auth/cli-session/[sessionId]
 * Get the status of a CLI authentication session. Public — used by the CLI to
 * poll for completion.
 */

import { Hono } from "hono";
import {
  cliAuthSessionsService,
  looksLikeCliAuthSessionId,
} from "@/lib/services/cli-auth-sessions";
import { getCorsHeaders } from "@/lib/utils/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

function cliSessionCorsHeaders(origin: string | null): Record<string, string> {
  return {
    ...getCorsHeaders(origin),
    "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
  };
}

function bearerToken(authorization: string | undefined): string | null {
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
}

app.options("/", (c) => {
  return new Response(null, {
    status: 204,
    headers: cliSessionCorsHeaders(c.req.header("origin") ?? null),
  });
});

app.get("/", async (c) => {
  const corsHeaders = cliSessionCorsHeaders(c.req.header("origin") ?? null);
  try {
    const sessionId = c.req.param("sessionId");
    if (!sessionId || !looksLikeCliAuthSessionId(sessionId)) {
      return c.json({ error: "Invalid session ID format" }, 400, corsHeaders);
    }

    const session = await cliAuthSessionsService.getActiveSession(sessionId);
    if (!session) {
      return c.json(
        { error: "Session not found or expired" },
        404,
        corsHeaders,
      );
    }

    if (session.status === "authenticated") {
      const apiKeyData =
        await cliAuthSessionsService.getAndClearApiKey(sessionId);
      if (apiKeyData.status === "unavailable") {
        if (
          apiKeyData.reason === "consumed" ||
          apiKeyData.reason === "claim-lost"
        ) {
          return c.json(
            { status: "authenticated", message: "API key already retrieved" },
            200,
            corsHeaders,
          );
        }
        return c.json(
          { error: `API key unavailable: ${apiKeyData.reason}` },
          apiKeyData.reason === "not-found" ? 404 : 410,
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

app.delete("/", async (c) => {
  const corsHeaders = cliSessionCorsHeaders(c.req.header("origin") ?? null);
  try {
    const sessionId = c.req.param("sessionId");
    if (!sessionId || !looksLikeCliAuthSessionId(sessionId)) {
      return c.json({ error: "Invalid session ID format" }, 400, corsHeaders);
    }
    const token = bearerToken(c.req.header("authorization"));
    if (!token) {
      return c.json({ error: "Credential required" }, 401, corsHeaders);
    }
    const revoked = await cliAuthSessionsService.revokeConsumedCredential(
      sessionId,
      token,
    );
    if (!revoked) {
      return c.json(
        { error: "Credential does not match session" },
        403,
        corsHeaders,
      );
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  } catch (error) {
    // error-policy:J1 the HTTP boundary reports an unavailable revocation
    // rather than claiming that the presented credential was disabled.
    logger.error("[CLI Auth] Error revoking consumed session credential", {
      error,
    });
    return c.json(
      { error: "Failed to revoke session credential" },
      500,
      corsHeaders,
    );
  }
});

export default app;

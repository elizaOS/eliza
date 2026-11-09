/**
 * GET /api/auth/cli-session/[sessionId]
 * Get the status of a CLI authentication session. Public — used by the CLI to
 * poll for completion. The one reply that carries the API key also says whether
 * this sign-in made the account (`accountCreated`). A session created with a
 * verifier hash releases the key only when the poll sends the verifier in
 * `X-Cli-Session-Verifier`; otherwise it answers 403 and keeps the key.
 */

import {
  CLI_AUTH_SESSION_VERIFIER_HEADER,
  cliAuthSessionsService,
  looksLikeCliAuthSessionId,
} from "@elizaos/cloud-shared/lib/services/cli-auth-sessions";
import { getCorsHeaders } from "@elizaos/cloud-shared/lib/utils/cors";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
      const apiKeyData = await cliAuthSessionsService.getAndClearApiKey(
        sessionId,
        c.req.header(CLI_AUTH_SESSION_VERIFIER_HEADER) ?? null,
      );
      if (apiKeyData.status === "unavailable") {
        if (apiKeyData.reason === "verifier-mismatch") {
          return c.json(
            { error: "Session verifier required" },
            403,
            corsHeaders,
          );
        }
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
          // True when this sign-in made the account; false when it existed.
          accountCreated: apiKeyData.accountCreated,
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

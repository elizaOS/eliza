/**
 * POST /api/auth/cli-session/[sessionId]/complete
 * Completes a pending CLI login after an authenticated user approves it in
 * the web UI. Session and API-key authentication share the same ownership
 * checks so headless clients can exercise the production boundary too.
 *
 * CSRF posture: this route mints an org API key, so the cookie-authenticated
 * path must not be reachable by a cross-origin simple request. Requests
 * carrying programmatic credentials (Authorization / X-API-Key) are already
 * non-ambient — a browser cannot attach them cross-origin without a
 * preflight — and skip the origin gate so headless clients keep working.
 * Every other request must pass the exact-host Origin/Referer policy AND
 * carry a non-simple marker (the X-Eliza-CSRF custom header or a JSON
 * content type), which forces a preflight the first-party-only CORS layer
 * fails for user-content origins.
 */

import { Hono } from "hono";
import {
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import {
  checkElizaMutatingRequestOrigin,
  hasElizaNonSimpleRequestMarker,
} from "@/lib/auth/browser-origin-policy";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  cliAuthSessionsService,
  looksLikeCliAuthSessionId,
} from "@/lib/services/cli-auth-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    if (!sessionId || !looksLikeCliAuthSessionId(sessionId)) {
      return c.json({ error: "Invalid session ID format" }, 400);
    }

    const hasProgrammaticAuth = Boolean(
      c.req.header("authorization") || c.req.header("x-api-key"),
    );
    if (!hasProgrammaticAuth) {
      const originCheck = checkElizaMutatingRequestOrigin(
        c.req,
        c.env.NODE_ENV === "production",
      );
      if (!originCheck.ok) {
        logger.warn("[CLI Auth] rejected cross-origin complete", {
          detail: originCheck.reason,
        });
        return c.json({ error: "Forbidden", code: "forbidden_origin" }, 403);
      }
      if (!hasElizaNonSimpleRequestMarker(c.req)) {
        return c.json(
          { error: "Forbidden", code: "csrf_marker_required" },
          403,
        );
      }
    }

    const user = await requireUserOrApiKeyWithOrg(c);

    const result = await cliAuthSessionsService.completeAuthentication(
      sessionId,
      user.id,
      user.organization_id,
    );

    return c.json({
      success: true,
      keyPrefix: result.keyPrefix,
      expiresAt: result.expiresAt,
      // Idempotent completion: true when this call found the session already
      // authenticated by the same user (no new key minted). The browser treats
      // both cases as success; the CLI still reads plaintext via the poll
      // endpoint. See cli-auth-sessions.ts completeAuthentication.
      alreadyAuthenticated: result.alreadyAuthenticated,
    });
  } catch (error) {
    logger.error("Error completing CLI authentication:", error);

    if (
      error instanceof Error &&
      (error.message.includes("Invalid or expired session") ||
        error.message.includes("already authenticated"))
    ) {
      return failureResponse(c, ValidationError(error.message));
    }
    return failureResponse(c, error);
  }
});

export default app;

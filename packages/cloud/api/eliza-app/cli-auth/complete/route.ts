/**
 * POST /api/eliza-app/cli-auth/complete
 *
 * Web UI calls this after successful login to bind the CLI session to the
 * user. Body `{ session_id }`; auth via Bearer eliza-app session token.
 * Mints the CLI API key, which the CLI reads once via /poll.
 */

import {
  cliAuthSessionsService,
  looksLikeCliAuthSessionId,
} from "@elizaos/cloud-shared/lib/services/cli-auth-sessions";
import { elizaAppSessionService } from "@elizaos/cloud-shared/lib/services/eliza-app";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const authHeader = c.req.header("authorization");
    if (!authHeader) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const userSession =
      await elizaAppSessionService.validateAuthHeader(authHeader);
    if (!userSession) {
      return c.json({ success: false, error: "Invalid session" }, 401);
    }

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 untrusted CLI-auth complete body; syntax errors are
      // caller garbage, not a server fault that completes CLI login.
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const sessionIdRaw = (body as { session_id?: unknown }).session_id;
    const sessionId =
      typeof sessionIdRaw === "string" && sessionIdRaw
        ? sessionIdRaw
        : undefined;
    if (!sessionId) {
      return c.json({ success: false, error: "Missing session_id" }, 400);
    }

    // The shared completion mints the CLI API key and binds the session to
    // this user in one claim, exactly as POST /api/auth/cli-session/:id/complete
    // does. Without it the poll found no key and the CLI never signed in.
    if (!looksLikeCliAuthSessionId(sessionId)) {
      return c.json(
        { success: false, error: "Invalid or expired CLI session" },
        400,
      );
    }
    try {
      await cliAuthSessionsService.completeAuthentication(
        sessionId,
        userSession.userId,
        userSession.organizationId,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("Invalid or expired session") ||
          error.message.includes("already authenticated"))
      ) {
        // error-policy:J3 an unknown, expired or foreign CLI session is caller
        // input, not a server fault.
        return c.json(
          { success: false, error: "Invalid or expired CLI session" },
          400,
        );
      }
      throw error;
    }

    return c.json({ success: true });
  } catch (error) {
    logger.error("[CLI Auth Complete] Error", { error });
    return c.json(
      { success: false, error: "Failed to complete CLI auth" },
      500,
    );
  }
});

export default app;

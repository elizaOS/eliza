/**
 * POST /api/auth/cli-session/[sessionId]/complete
 * Complete CLI authentication for a session. Called by the web UI after
 * the user logs in.
 */

import { Hono } from "hono";
import {
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) {
      return c.json({ error: "Session ID is required" }, 400);
    }

    const user = await requireUserWithOrg(c);

    const result = await cliAuthSessionsService.completeAuthentication(
      sessionId,
      user.id,
      user.organization_id,
    );

    return c.json({
      success: true,
      apiKey: result.apiKey,
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

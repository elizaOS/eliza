/**
 * POST /api/auth/cli-session
 * Creates a new CLI authentication session for command-line tool authentication.
 */

import { Hono } from "hono";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}) as { sessionId?: string });
    const { sessionId } = body;

    if (!sessionId || typeof sessionId !== "string") {
      return c.json({ error: "Session ID is required" }, 400);
    }

    const session = await cliAuthSessionsService.createSession(sessionId);

    return c.json(
      {
        sessionId: session.session_id,
        status: session.status,
        expiresAt: session.expires_at,
      },
      201,
    );
  } catch (error) {
    logger.error("Error creating CLI auth session:", error);
    return c.json({ error: "Failed to create authentication session" }, 500);
  }
});

export default app;

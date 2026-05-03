/**
 * GET /api/auth/cli-session/[sessionId]
 * Get the status of a CLI authentication session. Public — used by the CLI to
 * poll for completion.
 */

import { Hono } from "hono";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) {
      return c.json({ error: "Session ID is required" }, 400);
    }

    const session = await cliAuthSessionsService.getActiveSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found or expired" }, 404);
    }

    if (session.status === "authenticated") {
      const apiKeyData = await cliAuthSessionsService.getAndClearApiKey(sessionId);
      if (!apiKeyData) {
        return c.json({ status: "authenticated", message: "API key already retrieved" });
      }
      return c.json({
        status: "authenticated",
        apiKey: apiKeyData.apiKey,
        keyPrefix: apiKeyData.keyPrefix,
        expiresAt: apiKeyData.expiresAt,
      });
    }

    return c.json({ status: session.status });
  } catch (error) {
    logger.error("[CLI Auth] Error getting CLI auth session", { error });
    return c.json({ error: "Failed to get session status" }, 500);
  }
});

export default app;

/**
 * GET /api/eliza-app/cli-auth/poll?session_id=...
 *
 * The CLI polls this endpoint to check whether the user has authenticated
 * in their browser. Once status === "authenticated", returns the token and
 * immediately invalidates the row to prevent replay.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "@/db/client";
import { cliAuthSessions } from "@/db/schemas/cli-auth-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const sessionId = c.req.query("session_id");
    if (!sessionId) {
      return c.json({ success: false, error: "Missing session_id" }, 400);
    }

    const [session] = await db
      .select()
      .from(cliAuthSessions)
      .where(eq(cliAuthSessions.session_id, sessionId))
      .limit(1);

    if (!session) {
      return c.json({ success: false, error: "Session not found" }, 404);
    }
    if (session.status === "expired" || new Date() > session.expires_at) {
      return c.json({ success: true, status: "expired" });
    }
    if (session.status === "authenticated") {
      // D-6: plaintext is no longer stored on the session row. Decrypt the
      // associated api_keys row in-memory, mark this session consumed +
      // expired so the plaintext is single-use, and return the token.
      const { cliAuthSessionsService } = await import(
        "@elizaos/cloud-shared/lib/services/cli-auth-sessions"
      );
      const retrieved =
        await cliAuthSessionsService.getAndClearApiKey(sessionId);
      await db
        .update(cliAuthSessions)
        .set({ status: "expired" })
        .where(eq(cliAuthSessions.session_id, sessionId));
      return c.json({
        success: true,
        status: "authenticated",
        token: retrieved?.apiKey ?? null,
      });
    }

    return c.json({ success: true, status: "pending" });
  } catch (error) {
    logger.error("[CLI Auth Poll] Error", { error });
    return c.json({ success: false, error: "Failed to poll session" }, 500);
  }
});

export default app;

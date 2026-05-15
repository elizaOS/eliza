/**
 * POST /api/eliza-app/cli-auth/complete
 *
 * Web UI calls this after successful login to bind the CLI session to the
 * user. Body `{ session_id }`; auth via Bearer eliza-app session token.
 * Stores the JWT in `api_key_plain` so the CLI can pick it up via /poll.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "@/db/client";
import { cliAuthSessions } from "@/db/schemas/cli-auth-sessions";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const authHeader = c.req.header("authorization");
    if (!authHeader) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const userSession = await elizaAppSessionService.validateAuthHeader(authHeader);
    if (!userSession) {
      return c.json({ success: false, error: "Invalid session" }, 401);
    }

    const body = (await c.req.json()) as { session_id?: string };
    const sessionId = body?.session_id;
    if (!sessionId) {
      return c.json({ success: false, error: "Missing session_id" }, 400);
    }

    const [cliSession] = await db
      .select()
      .from(cliAuthSessions)
      .where(eq(cliAuthSessions.session_id, sessionId))
      .limit(1);

    if (!cliSession || cliSession.status !== "pending" || new Date() > cliSession.expires_at) {
      return c.json({ success: false, error: "Invalid or expired CLI session" }, 400);
    }

    const tokenToPass = authHeader.split(" ")[1];

    await db
      .update(cliAuthSessions)
      .set({
        user_id: userSession.userId,
        status: "authenticated",
        authenticated_at: new Date(),
        api_key_plain: tokenToPass,
      })
      .where(eq(cliAuthSessions.session_id, sessionId));

    return c.json({ success: true });
  } catch (error) {
    console.error("[CLI Auth Complete] Error:", error);
    return c.json({ success: false, error: "Failed to complete CLI auth" }, 500);
  }
});

export default app;

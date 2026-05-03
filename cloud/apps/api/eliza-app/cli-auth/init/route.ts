/**
 * POST /api/eliza-app/cli-auth/init
 * Creates a new pending CLI auth session (15-minute TTL).
 */

import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { db } from "@/db/client";
import { cliAuthSessions } from "@/db/schemas/cli-auth-sessions";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const [session] = await db
      .insert(cliAuthSessions)
      .values({ session_id: sessionId, status: "pending", expires_at: expiresAt })
      .returning();

    return c.json({
      success: true,
      session_id: session.session_id,
      expires_at: session.expires_at,
    });
  } catch (error) {
    console.error("[CLI Auth Init] Error:", error);
    return c.json({ success: false, error: "Failed to initialize session" }, 500);
  }
});

export default app;

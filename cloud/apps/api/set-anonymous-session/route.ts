/**
 * POST /api/set-anonymous-session
 *
 * Sets the anonymous-session cookie when a user arrives with a session
 * token (e.g. via affiliate link). Public endpoint — no auth required.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { dbWrite } from "@/db/client";
import { anonymousSessions, users } from "@/db/schemas";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { usersService } from "@/lib/services/users";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ANON_SESSION_COOKIE = "eliza-anon-session";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.AGGRESSIVE));

app.post("/", async (c) => {
  logger.info("[Set Session] Received request to set anonymous session cookie");

  let body: { sessionToken?: string };
  try {
    body = await c.req.json();
  } catch (err) {
    logger.error("[Set Session] Failed to parse request body:", err);
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { sessionToken } = body;
  if (!sessionToken || typeof sessionToken !== "string") {
    return c.json({ error: "Session token is required" }, 400);
  }

  const session = await anonymousSessionsService.getByToken(sessionToken);
  if (!session) {
    return c.json({ error: "Invalid session token", code: "SESSION_NOT_FOUND" }, 404);
  }
  if (session.expires_at < new Date()) {
    return c.json({ error: "Session has expired", code: "SESSION_EXPIRED" }, 410);
  }

  let user = await usersService.getById(session.user_id);
  if (!user) {
    logger.info("[Set Session] User not found, creating anonymous user for session:", session.id);
    const [newUser] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `anonymous:${crypto.randomUUID()}`,
        is_anonymous: true,
        anonymous_session_id: sessionToken,
        organization_id: null,
        is_active: true,
        expires_at: session.expires_at,
        role: "member",
      })
      .returning();

    await dbWrite
      .update(anonymousSessions)
      .set({ user_id: newUser.id })
      .where(eq(anonymousSessions.id, session.id));

    user = newUser;
  }

  setCookie(c, ANON_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: c.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    expires: session.expires_at,
  });

  return c.json({
    success: true,
    message: "Session cookie set successfully",
    userId: user.id,
    sessionId: session.id,
  });
});

export default app;

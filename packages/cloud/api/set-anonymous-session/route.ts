/**
 * POST /api/set-anonymous-session
 *
 * Sets the anonymous-session cookie when a user arrives with a session
 * token (e.g. via affiliate link). Public endpoint — no auth required.
 *
 * The token is accepted only for a session the deployment itself minted
 * (DB lookup below), and the mutation is guarded like the other session
 * mutations: exact-host Origin policy plus a non-simple-request marker
 * (X-Eliza-CSRF header or JSON content type), so a cross-site form POST
 * cannot plant an attacker-known cookie into a victim's browser.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { dbWrite } from "@/db/client";
import { anonymousSessions, users } from "@/db/schemas";
import {
  checkElizaMutatingRequestOrigin,
  hasElizaNonSimpleRequestMarker,
} from "@/lib/auth/browser-origin-policy";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { usersService } from "@/lib/services/users";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ANON_SESSION_COOKIE = "eliza-anon-session";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.AGGRESSIVE));

app.post("/", async (c) => {
  logger.info("[Set Session] Received request to set anonymous session cookie");

  // A cross-site simple request (hidden form POST) cannot satisfy this gate,
  // so an attacker cannot plant a session cookie they know into a victim's
  // browser and later read or merge the victim's anonymous activity.
  const originCheck = checkElizaMutatingRequestOrigin(
    c.req,
    c.env.NODE_ENV === "production",
  );
  if (!originCheck.ok) {
    logger.warn("[Set Session] rejected cross-origin POST", {
      detail: originCheck.reason,
    });
    return c.json({ error: "Forbidden", code: "forbidden_origin" }, 403);
  }
  if (!hasElizaNonSimpleRequestMarker(c.req)) {
    return c.json({ error: "Forbidden", code: "csrf_marker_required" }, 403);
  }

  const decodedBody = await decodeRequestJson(c.req);
  if (!decodedBody.ok) {
    // error-policy:J3 malformed JSON is invalid request input.
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const body = decodedBody.value as { sessionToken?: string };

  const { sessionToken } = body;
  if (!sessionToken || typeof sessionToken !== "string") {
    return c.json({ error: "Session token is required" }, 400);
  }

  const session = await anonymousSessionsService.getByToken(sessionToken);
  if (!session) {
    return c.json(
      { error: "Invalid session token", code: "SESSION_NOT_FOUND" },
      404,
    );
  }
  if (session.expires_at < new Date()) {
    return c.json(
      { error: "Session has expired", code: "SESSION_EXPIRED" },
      410,
    );
  }

  let user = await usersService.getById(session.user_id);
  if (!user) {
    logger.info(
      "[Set Session] User not found, creating anonymous user for session:",
      session.id,
    );
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
    // Strict, matching the mint routes: the anonymous cookie is a first-party
    // session handle and is never needed on a cross-site request.
    sameSite: "Strict",
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

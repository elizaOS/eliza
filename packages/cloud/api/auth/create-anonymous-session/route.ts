/**
 * GET /api/auth/create-anonymous-session
 *
 * Public endpoint. Creates a brand-new anonymous user + session, sets the
 * cookie, and 302-redirects to the requested return URL.
 */

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import {
  MAX_ANONYMOUS_EXPIRY_DAYS,
  MAX_ANONYMOUS_MESSAGE_LIMIT,
  parseAnonymousPositiveIntEnv,
} from "@/api/auth/anonymous-session-config";
import {
  getIpKey,
  getRequestIp,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { createAnonymousUserAndSession } from "@/lib/services/anonymous-session-creator";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ANON_SESSION_COOKIE = "eliza-anon-session";

function isValidReturnUrl(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

const app = new Hono<AppEnv>();

// Anti-sybil: this endpoint mints a brand-new anonymous user + session (→ free
// metered inference) on every unauthenticated GET. Cap it tightly per source IP
// (CRITICAL preset: 5 mints / 5 min) so it can't be used to farm anon accounts.
// IP-keyed because there is no auth identity to key on. Enforced only when
// REDIS_RATE_LIMITING=true (falls open otherwise — see ops note in #9853).
app.use(
  "*",
  rateLimit({
    ...RateLimitPresets.CRITICAL,
    keyGenerator: (c) => `anon-mint:${getIpKey(c)}`,
  }),
);

app.get("/", async (c) => {
  try {
    const env = c.env as {
      ANON_SESSION_EXPIRY_DAYS?: string;
      ANON_MESSAGE_LIMIT?: string;
    };
    const expiryDays = parseAnonymousPositiveIntEnv(
      env.ANON_SESSION_EXPIRY_DAYS,
      7,
      "ANON_SESSION_EXPIRY_DAYS",
      MAX_ANONYMOUS_EXPIRY_DAYS,
      "create-anonymous-session",
    );
    const msgLimit = parseAnonymousPositiveIntEnv(
      env.ANON_MESSAGE_LIMIT,
      5,
      "ANON_MESSAGE_LIMIT",
      MAX_ANONYMOUS_MESSAGE_LIMIT,
      "create-anonymous-session",
    );

    const rawReturnUrl = c.req.query("returnUrl") || "/";
    const returnUrl = isValidReturnUrl(rawReturnUrl) ? rawReturnUrl : "/";

    const newSessionToken = nanoid(32);
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);
    // Persist the edge-verified request IP (cf-connecting-ip first), never a
    // client-spoofed x-real-ip / x-forwarded-for value — this row is the
    // abuse-investigation audit trail.
    const ipAddress = getRequestIp(c);
    const userAgent = c.req.header("user-agent") || undefined;

    const { newUser, newSession } = await createAnonymousUserAndSession({
      sessionToken: newSessionToken,
      expiresAt,
      ipAddress,
      userAgent,
      messagesLimit: msgLimit,
    });

    logger.info("[create-anonymous-session] Session created successfully", {
      userId: newUser.id,
      sessionId: newSession.id,
      expiresAt: expiresAt.toISOString(),
    });

    setCookie(c, ANON_SESSION_COOKIE, newSessionToken, {
      httpOnly: true,
      secure: c.env.NODE_ENV === "production",
      sameSite: "Strict",
      path: "/",
      expires: expiresAt,
    });

    return c.redirect(new URL(returnUrl, c.req.url).toString());
  } catch (error) {
    logger.error("[create-anonymous-session] Error creating session:", error);
    return c.redirect(
      new URL("/login?error=session_error", c.req.url).toString(),
    );
  }
});

export default app;

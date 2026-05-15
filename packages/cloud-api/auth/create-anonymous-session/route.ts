/**
 * GET /api/auth/create-anonymous-session
 *
 * Public endpoint. Creates a brand-new anonymous user + session, sets the
 * cookie, and 302-redirects to the requested return URL.
 */

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { createAnonymousUserAndSession } from "@/lib/services/anonymous-session-creator";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ANON_SESSION_COOKIE = "eliza-anon-session";

function parsePositiveIntEnv(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  const n = Number.parseInt(value || String(defaultValue), 10);
  if (Number.isNaN(n) || n <= 0) {
    logger.warn(`[create-anonymous-session] Invalid ${name}, using default: ${defaultValue}`);
    return defaultValue;
  }
  return n;
}

function isValidReturnUrl(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const env = c.env as { ANON_SESSION_EXPIRY_DAYS?: string; ANON_MESSAGE_LIMIT?: string };
    const expiryDays = parsePositiveIntEnv(
      env.ANON_SESSION_EXPIRY_DAYS,
      7,
      "ANON_SESSION_EXPIRY_DAYS",
    );
    const msgLimit = parsePositiveIntEnv(env.ANON_MESSAGE_LIMIT, 5, "ANON_MESSAGE_LIMIT");

    const rawReturnUrl = c.req.query("returnUrl") || "/";
    const returnUrl = isValidReturnUrl(rawReturnUrl) ? rawReturnUrl : "/";

    const newSessionToken = nanoid(32);
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);
    const ipAddress =
      c.req.header("x-real-ip")?.trim() ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      undefined;
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
    return c.redirect(new URL("/login?error=session_error", c.req.url).toString());
  }
});

export default app;

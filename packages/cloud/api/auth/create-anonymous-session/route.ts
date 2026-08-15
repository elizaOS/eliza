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
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { createAnonymousUserAndSession } from "@/lib/services/anonymous-session-creator";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ANON_SESSION_COOKIE = "eliza-anon-session";

// Operator-sane upper bounds for the spend-gate env vars. A configured value
// above these caps is treated as a typo and rejected in favour of the default,
// because `messages_limit` is the per-guest anonymous spend gate and directly
// bounds how much of the application owner's credit balance a guest can burn.
const MAX_EXPIRY_DAYS = 365;
const MAX_MESSAGE_LIMIT = 1000;

/**
 * Parse an operator-facing positive-integer env var with a strict canonical
 * grammar. Unlike `Number.parseInt`, this rejects trailing junk (`"5oops"`),
 * exponent notation (`"1e2"`), decimals (`"7.0"`), and leading zeros (`"05"`)
 * instead of silently truncating them — a silently mutated spend gate has
 * direct billing impact on the application owner.
 *
 * Unset or blank/whitespace-only values keep the default silently (matches the
 * prior behavior and the affiliate routes' convention). Any other invalid or
 * out-of-range value warns — naming the env var and the rejected value — and
 * returns the default.
 */
function parsePositiveIntEnv(
  value: string | undefined,
  defaultValue: number,
  name: string,
  max: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const raw = value.trim();
  if (raw === "") {
    return defaultValue;
  }
  // Canonical positive decimal integer only: `[1-9][0-9]*` excludes leading
  // zeros, signs, decimals, exponents, and any trailing junk.
  if (!/^[1-9][0-9]*$/.test(raw)) {
    logger.warn(
      `[create-anonymous-session] Invalid ${name} (expected canonical positive integer), using default ${defaultValue} (received: ${value})`,
    );
    return defaultValue;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) {
    logger.warn(
      `[create-anonymous-session] Invalid ${name} (expected 1..${max}), using default ${defaultValue} (received: ${value})`,
    );
    return defaultValue;
  }
  return n;
}

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
    const expiryDays = parsePositiveIntEnv(
      env.ANON_SESSION_EXPIRY_DAYS,
      7,
      "ANON_SESSION_EXPIRY_DAYS",
      MAX_EXPIRY_DAYS,
    );
    const msgLimit = parsePositiveIntEnv(
      env.ANON_MESSAGE_LIMIT,
      5,
      "ANON_MESSAGE_LIMIT",
      MAX_MESSAGE_LIMIT,
    );

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
    return c.redirect(
      new URL("/login?error=session_error", c.req.url).toString(),
    );
  }
});

export default app;

/**
 * POST /api/auth/anonymous-session
 *
 * JSON get-or-create endpoint for anonymous user sessions. Reads the
 * `eliza-anon-session` cookie; if it points to an active anonymous user,
 * returns that session. Otherwise creates a new anonymous user + session,
 * sets the cookie, and returns the new session.
 *
 * Mirrors `_legacy_actions/anonymous.ts → getOrCreateAnonymousUserAction`,
 * but rewritten for Workers (no `next/headers`).
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { dbRead } from "@/db/helpers";
import { userIdentities } from "@/db/schemas/user-identities";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { createAnonymousUserAndSession } from "@/lib/services/anonymous-session-creator";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { usersService } from "@/lib/services/users";
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
      `[anonymous-session] Invalid ${name} (expected canonical positive integer), using default ${defaultValue} (received: ${value})`,
    );
    return defaultValue;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) {
    logger.warn(
      `[anonymous-session] Invalid ${name} (expected 1..${max}), using default ${defaultValue} (received: ${value})`,
    );
    return defaultValue;
  }
  return n;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.AGGRESSIVE));

app.post("/", async (c) => {
  try {
    const env = c.env as {
      ANON_SESSION_EXPIRY_DAYS?: string;
      PUBLIC_CHAT_MESSAGE_LIMIT?: string;
      NODE_ENV?: string;
    };
    const expiryDays = parsePositiveIntEnv(
      env.ANON_SESSION_EXPIRY_DAYS,
      7,
      "ANON_SESSION_EXPIRY_DAYS",
      MAX_EXPIRY_DAYS,
    );
    const messagesLimit = parsePositiveIntEnv(
      env.PUBLIC_CHAT_MESSAGE_LIMIT,
      3,
      "PUBLIC_CHAT_MESSAGE_LIMIT",
      MAX_MESSAGE_LIMIT,
    );

    const cookieToken = getCookie(c, ANON_SESSION_COOKIE);
    if (cookieToken) {
      const session = await anonymousSessionsService.getByToken(cookieToken);
      if (session) {
        const user = await usersService.getById(session.user_id);
        if (user) {
          const identity = await dbRead.query.userIdentities.findFirst({
            where: eq(userIdentities.user_id, user.id),
          });
          if (identity?.is_anonymous) {
            return c.json({
              isNew: false,
              user: { ...user, organization_id: null, organization: null },
              session: {
                id: session.id,
                message_count: session.message_count,
                messages_limit: session.messages_limit,
                session_token: cookieToken,
                expires_at: session.expires_at,
                is_active: session.is_active,
              },
            });
          }
        }
      }
    }

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
      messagesLimit,
    });

    setCookie(c, ANON_SESSION_COOKIE, newSessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "Strict",
      path: "/",
      expires: expiresAt,
    });

    return c.json({
      isNew: true,
      user: { ...newUser, organization_id: null, organization: null },
      session: {
        id: newSession.id,
        message_count: newSession.message_count,
        messages_limit: newSession.messages_limit,
        session_token: newSessionToken,
        expires_at: expiresAt,
        is_active: newSession.is_active,
      },
    });
  } catch (error) {
    // error-policy:J1 route boundary for the auth/ dir — the outermost handler
    // catches here translate exceptions into a structured HTTP failure
    // (failureResponse → 5xx / typed status), never a fabricated success.
    logger.error("[anonymous-session] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;

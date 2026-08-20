/**
 * POST /api/affiliate/create-session
 * Creates an anonymous user + session for affiliate visitors and sets the
 * `eliza-anon-session` cookie. Public endpoint.
 */

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
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

function parsePositiveIntEnv(
  value: string | undefined,
  defaultValue: number,
  name: string,
  max: number,
): number {
  const raw = value ?? String(defaultValue);
  // Reject trailing junk, scientific notation, and non-decimal strings.
  if (!/^\d+$/.test(raw)) {
    logger.warn(
      `[affiliate/create-session] Invalid ${name} (expected positive integer), using default: ${defaultValue}`,
    );
    return defaultValue;
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0 || !Number.isSafeInteger(n)) {
    logger.warn(
      `[affiliate/create-session] Invalid ${name} (expected safe positive integer), using default: ${defaultValue}`,
    );
    return defaultValue;
  }
  if (n > max) {
    logger.warn(
      `[affiliate/create-session] ${name} exceeds maximum (${max}), clamping to: ${max}`,
    );
    return max;
  }
  return n;
}

const CreateSessionSchema = z.object({
  characterId: z.string().uuid(),
  source: z.string().optional(),
});

const app = new Hono<AppEnv>();

// Anti-sybil (#9853): this endpoint mints a brand-new anonymous user + session
// (→ free metered inference) the same way `auth/create-anonymous-session` does,
// but was uncapped. Cap it tightly per source IP (CRITICAL: 5 mints / 5 min) so
// it can't be used to farm anon accounts. Enforced only when
// REDIS_RATE_LIMITING=true (falls open otherwise — ops note in #9853).
app.use(
  "*",
  rateLimit({
    ...RateLimitPresets.CRITICAL,
    keyGenerator: (c) => `anon-mint:${getIpKey(c)}`,
  }),
);

app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const validationResult = CreateSessionSchema.safeParse(body);

    if (!validationResult.success) {
      logger.warn(
        "[Create Session] Invalid request body:",
        validationResult.error.format(),
      );
      return c.json(
        {
          success: false,
          error: "Invalid request body",
          details: validationResult.error.format(),
        },
        400,
      );
    }

    const { characterId, source } = validationResult.data;

    const expiryDays = parsePositiveIntEnv(
      c.env.ANON_SESSION_EXPIRY_DAYS as string | undefined,
      7,
      "ANON_SESSION_EXPIRY_DAYS",
      365,
    );
    const messagesLimit = parsePositiveIntEnv(
      c.env.ANON_MESSAGE_LIMIT as string | undefined,
      5,
      "ANON_MESSAGE_LIMIT",
      1000,
    );

    const sessionToken = nanoid(32);
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    // Persist the edge-verified request IP (cf-connecting-ip first), never a
    // client-spoofed x-real-ip / x-forwarded-for value — this row is the
    // abuse-investigation audit trail.
    const ipAddress = getRequestIp(c);
    const userAgent = c.req.header("user-agent") || undefined;

    const { newUser, newSession } = await createAnonymousUserAndSession({
      sessionToken,
      expiresAt,
      ipAddress,
      userAgent,
      messagesLimit,
    });

    logger.info(`[Create Session] Created anonymous user: ${newUser.id}`);

    setCookie(c, ANON_SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: c.env.NODE_ENV === "production",
      sameSite: "Strict",
      path: "/",
      expires: expiresAt,
    });

    logger.info(
      `[Create Session] Created anonymous session for character ${characterId}`,
      {
        userId: newUser.id,
        source,
      },
    );

    return c.json({
      success: true,
      sessionToken,
      userId: newSession.user_id ?? newUser.id,
    });
  } catch (error) {
    // error-policy:J1 outermost route boundary; anonymous user/session mint
    // failures translate to a structured failure response, never a fabricated
    // success with a phantom token.
    logger.error("[Create Session] Error creating session:", error);
    return failureResponse(c, error);
  }
});

export default app;

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
import { createAnonymousUserAndSession } from "@/lib/services/anonymous-session-creator";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ANON_SESSION_COOKIE = "eliza-anon-session";

const CreateSessionSchema = z.object({
  characterId: z.string().uuid(),
  source: z.string().optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const validationResult = CreateSessionSchema.safeParse(body);

    if (!validationResult.success) {
      logger.warn("[Create Session] Invalid request body:", validationResult.error.format());
      return c.json(
        { success: false, error: "Invalid request body", details: validationResult.error.format() },
        400,
      );
    }

    const { characterId, source } = validationResult.data;

    const expiryDays = Number.parseInt(
      (c.env.ANON_SESSION_EXPIRY_DAYS as string | undefined) || "7",
      10,
    );
    const messagesLimit = Number.parseInt(
      (c.env.ANON_MESSAGE_LIMIT as string | undefined) || "5",
      10,
    );

    const sessionToken = nanoid(32);
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    const realIp = c.req.header("x-real-ip")?.trim();
    const forwardedFor = c.req.header("x-forwarded-for");
    const ipAddress = realIp || forwardedFor?.split(",")[0]?.trim() || undefined;
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

    logger.info(`[Create Session] Created anonymous session for character ${characterId}`, {
      userId: newUser.id,
      source,
    });

    return c.json({
      success: true,
      sessionToken,
      userId: newSession.user_id ?? newUser.id,
    });
  } catch (error) {
    logger.error("[Create Session] Error creating session:", error);
    return failureResponse(c, error);
  }
});

export default app;

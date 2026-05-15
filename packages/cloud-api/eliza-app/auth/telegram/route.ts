/**
 * Eliza App - Telegram Login Authentication Endpoint
 *
 * Verifies Telegram Login Widget authentication data and creates/updates user accounts.
 * Returns a JWT session token for subsequent API calls.
 *
 * Requires phone_number to be provided by the frontend (entered by user before OAuth).
 * This enables cross-platform messaging (same account for Telegram + iMessage).
 *
 * POST /api/eliza-app/auth/telegram
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Organization } from "@/db/repositories/organizations";
import type { User } from "@/db/repositories/users";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  elizaAppSessionService,
  elizaAppUserService,
  type TelegramAuthData,
  telegramAuthService,
  type ValidatedSession,
} from "@/lib/services/eliza-app";
import { logger } from "@/lib/utils/logger";
import { isValidE164, normalizePhoneNumber } from "@/lib/utils/phone-normalization";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * E.164 phone number validation (after normalization)
 */
const phoneNumberSchema = z
  .string()
  .min(1, "Phone number is required")
  .transform((val, ctx) => {
    const normalized = normalizePhoneNumber(val);
    if (!isValidE164(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid phone number format. Please use international format (e.g., +1234567890)",
      });
      return z.NEVER;
    }
    return normalized;
  });

/**
 * Request body schema: Telegram Login Widget data + phone number from frontend + optional signup code
 */
const telegramAuthSchema = z.object({
  // Phone number entered by user in frontend modal (required for cross-platform)
  phone_number: phoneNumberSchema,
  // Telegram Login Widget data
  id: z.number().int().positive(),
  first_name: z.string().min(1).max(256),
  last_name: z.string().max(256).optional(),
  username: z.string().max(32).optional(),
  photo_url: z.string().url().max(2048).optional(),
  auth_date: z.number().int().positive(),
  hash: z.string().length(64), // SHA-256 hash is 64 hex characters
  // Optional signup code for bonus credits (new users only; one per org)
  signup_code: z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined),
});

/**
 * Success response type
 */
export interface AuthSuccessResponse {
  success: true;
  user: {
    id: string;
    telegram_id: string;
    telegram_username: string | null;
    phone_number: string;
    name: string | null;
    organization_id: string;
  };
  session: {
    token: string;
    expires_at: string;
  };
  is_new_user: boolean;
}

/**
 * Error response type
 */
export interface AuthErrorResponse {
  success: false;
  error: string;
  code: string;
}

async function handleTelegramAuth(request: Request): Promise<Response> {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body", code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  const parseResult = telegramAuthSchema.safeParse(body);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const errorMessage = firstIssue?.path.includes("phone_number")
      ? firstIssue.message
      : "Invalid request body";
    return Response.json(
      { success: false, error: errorMessage, code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const { phone_number: phoneNumber, signup_code: signupCode, ...telegramData } = parseResult.data;
  const authData: TelegramAuthData = telegramData;

  // Verify Telegram authentication data
  const isValid = telegramAuthService.verifyAuth(authData);

  if (!isValid) {
    logger.warn("[ElizaApp TelegramAuth] Authentication verification failed", {
      telegramId: authData.id,
      username: authData.username,
    });
    return Response.json(
      {
        success: false,
        error: "Invalid authentication data",
        code: "INVALID_AUTH",
      },
      { status: 401 },
    );
  }

  // Check for existing session (session-based linking: user already logged in via another platform)
  const authHeader = request.headers.get("authorization");
  let existingSession: ValidatedSession | null = null;
  if (authHeader) {
    existingSession = await elizaAppSessionService.validateAuthHeader(authHeader);
    if (existingSession) {
      logger.info("[ElizaApp TelegramAuth] Session-based linking detected", {
        existingUserId: existingSession.userId,
      });
    }
  }

  let user: User;
  let organization: Organization;
  let isNew: boolean;

  if (existingSession) {
    // ---- SESSION-BASED LINKING: Link Telegram + phone to existing user ----
    const linkTelegramResult = await elizaAppUserService.linkTelegramToUser(
      existingSession.userId,
      authData,
    );

    if (!linkTelegramResult.success) {
      return Response.json(
        {
          success: false,
          error:
            linkTelegramResult.error ||
            "This Telegram account is already linked to another account",
          code: "TELEGRAM_ALREADY_LINKED",
        },
        { status: 409 },
      );
    }

    // Also link phone number if the existing user doesn't have one
    const existingUser = await elizaAppUserService.getById(existingSession.userId);
    if (existingUser && !existingUser.phone_number) {
      const linkPhoneResult = await elizaAppUserService.linkPhoneToUser(
        existingSession.userId,
        phoneNumber,
      );
      if (!linkPhoneResult.success) {
        // Phone conflict is non-fatal for session linking — Telegram is linked, phone just couldn't be added
        logger.warn("[ElizaApp TelegramAuth] Phone link failed during session-based linking", {
          userId: existingSession.userId,
          error: linkPhoneResult.error,
        });
      }
    }

    // Fetch the updated user
    const updatedUser = await elizaAppUserService.getById(existingSession.userId);
    if (!updatedUser || !updatedUser.organization) {
      return Response.json(
        {
          success: false,
          error: "User not found after linking",
          code: "INTERNAL_ERROR",
        },
        { status: 500 },
      );
    }

    user = updatedUser;
    organization = updatedUser.organization;
    isNew = false;

    logger.info("[ElizaApp TelegramAuth] Session-based Telegram linking successful", {
      userId: user.id,
      telegramId: authData.id,
    });
  } else {
    // ---- STANDARD FLOW: Find or create user with both Telegram and phone number ----
    // Note: Conflict checks are handled in the service layer with database constraints
    // to avoid TOCTOU race conditions. The service returns proper error codes.
    let result;
    try {
      result = await elizaAppUserService.findOrCreateByTelegramWithPhone(
        authData,
        phoneNumber,
        signupCode,
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "PHONE_ALREADY_LINKED") {
          return Response.json(
            {
              success: false,
              error: "This phone number is already linked to a different account",
              code: "PHONE_ALREADY_LINKED",
            },
            { status: 409 },
          );
        }
        if (error.message === "PHONE_MISMATCH") {
          return Response.json(
            {
              success: false,
              error: "Your Telegram account is already linked to a different phone number",
              code: "PHONE_MISMATCH",
            },
            { status: 409 },
          );
        }
        if (error.message === "TELEGRAM_ALREADY_LINKED") {
          return Response.json(
            {
              success: false,
              error: "This Telegram account is already linked to another user",
              code: "TELEGRAM_ALREADY_LINKED",
            },
            { status: 409 },
          );
        }
        if (error.message === "OAUTH_ACCOUNT_ALREADY_LINKED") {
          return Response.json(
            {
              success: false,
              error: "This OAuth account is already linked to another user",
              code: "OAUTH_ACCOUNT_ALREADY_LINKED",
            },
            { status: 409 },
          );
        }
      }
      // Log unexpected errors and return generic 500
      logger.error("[ElizaApp TelegramAuth] Unexpected error during authentication", {
        error: error instanceof Error ? error.message : String(error),
        telegramId: authData.id,
      });
      return Response.json(
        {
          success: false,
          error: "An unexpected error occurred",
          code: "INTERNAL_ERROR",
        },
        { status: 500 },
      );
    }

    user = result.user;
    organization = result.organization;
    isNew = result.isNew;
  }

  logger.info("[ElizaApp TelegramAuth] Authentication successful", {
    userId: user.id,
    telegramId: authData.id,
    username: authData.username,
    phoneNumber: `***${phoneNumber.slice(-4)}`,
    isNewUser: isNew,
    sessionBased: !!existingSession,
    hasSignupCode: !!signupCode,
  });

  // Create session (new session includes all known identities)
  const session = await elizaAppSessionService.createSession(user.id, organization.id, {
    telegramId: String(authData.id),
    phoneNumber: user.phone_number || phoneNumber,
    ...(user.discord_id && { discordId: user.discord_id }),
    ...(user.whatsapp_id && { whatsappId: user.whatsapp_id }),
  });

  return Response.json({
    success: true,
    user: {
      id: user.id,
      telegram_id: user.telegram_id!,
      telegram_username: user.telegram_username,
      phone_number: user.phone_number!,
      name: user.name,
      organization_id: organization.id,
    },
    session: {
      token: session.token,
      expires_at: session.expiresAt.toISOString(),
    },
    is_new_user: isNew,
  });
}

async function __next_GET(): Promise<Response> {
  return Response.json({
    status: "ok",
    service: "eliza-app-telegram-auth",
    timestamp: new Date().toISOString(),
  });
}

const honoRouter = new Hono<AppEnv>();
honoRouter.get("/", async () => __next_GET());
honoRouter.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handleTelegramAuth(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;

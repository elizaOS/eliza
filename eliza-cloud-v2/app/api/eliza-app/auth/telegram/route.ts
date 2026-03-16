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

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/utils/logger";
import { RateLimitPresets, withRateLimit } from "@/lib/middleware/rate-limit";
import {
  telegramAuthService,
  elizaAppUserService,
  elizaAppSessionService,
  type TelegramAuthData,
} from "@/lib/services/eliza-app";
import { normalizePhoneNumber, isValidE164 } from "@/lib/utils/phone-normalization";

/**
 * E.164 phone number validation (after normalization)
 */
const phoneNumberSchema = z.string().min(1, "Phone number is required").transform((val, ctx) => {
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
 * Request body schema: Telegram Login Widget data + phone number from frontend
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
});

/**
 * Success response type
 */
interface AuthSuccessResponse {
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
interface AuthErrorResponse {
  success: false;
  error: string;
  code: string;
}

async function handleTelegramAuth(
  request: NextRequest,
): Promise<NextResponse<AuthSuccessResponse | AuthErrorResponse>> {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
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
    return NextResponse.json(
      { success: false, error: errorMessage, code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const { phone_number: phoneNumber, ...telegramData } = parseResult.data;
  const authData: TelegramAuthData = telegramData;

  // Verify Telegram authentication data
  const isValid = telegramAuthService.verifyAuth(authData);

  if (!isValid) {
    logger.warn("[ElizaApp TelegramAuth] Authentication verification failed", {
      telegramId: authData.id,
      username: authData.username,
    });
    return NextResponse.json(
      {
        success: false,
        error: "Invalid authentication data",
        code: "INVALID_AUTH",
      },
      { status: 401 },
    );
  }

  // Find or create user with both Telegram and phone number
  // Note: Conflict checks are handled in the service layer with database constraints
  // to avoid TOCTOU race conditions. The service returns proper error codes.
  let result;
  try {
    result = await elizaAppUserService.findOrCreateByTelegramWithPhone(authData, phoneNumber);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "PHONE_ALREADY_LINKED") {
        return NextResponse.json(
          {
            success: false,
            error: "This phone number is already linked to a different account",
            code: "PHONE_ALREADY_LINKED",
          },
          { status: 409 },
        );
      }
      if (error.message === "PHONE_MISMATCH") {
        return NextResponse.json(
          {
            success: false,
            error: "Your Telegram account is already linked to a different phone number",
            code: "PHONE_MISMATCH",
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
    return NextResponse.json(
      {
        success: false,
        error: "An unexpected error occurred",
        code: "INTERNAL_ERROR",
      },
      { status: 500 },
    );
  }
  const { user, organization, isNew } = result;

  logger.info("[ElizaApp TelegramAuth] Authentication successful", {
    userId: user.id,
    telegramId: authData.id,
    username: authData.username,
    phoneNumber: `***${phoneNumber.slice(-4)}`,
    isNewUser: isNew,
  });

  // Create session
  const session = await elizaAppSessionService.createSession(
    user.id,
    organization.id,
    { telegramId: String(authData.id), phoneNumber },
  );

  return NextResponse.json({
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

// Export with rate limiting (60 requests/min per API key)
export const POST = withRateLimit(handleTelegramAuth, RateLimitPresets.STANDARD);

// Health check
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: "ok",
    service: "eliza-app-telegram-auth",
    timestamp: new Date().toISOString(),
  });
}

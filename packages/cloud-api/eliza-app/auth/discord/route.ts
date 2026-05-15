/**
 * Eliza App - Discord OAuth2 Authentication Endpoint
 *
 * Exchanges a Discord OAuth2 authorization code for user data,
 * creates/updates user accounts, and returns a JWT session token.
 *
 * Phone number is optional (unlike Telegram where it's required).
 * If provided, it enables cross-platform linking with iMessage.
 *
 * POST /api/eliza-app/auth/discord
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Organization } from "@/db/repositories/organizations";
import type { User } from "@/db/repositories/users";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  discordAuthService,
  elizaAppSessionService,
  elizaAppUserService,
  type ValidatedSession,
} from "@/lib/services/eliza-app";
import { logger } from "@/lib/utils/logger";
import { isValidE164, normalizePhoneNumber } from "@/lib/utils/phone-normalization";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Optional E.164 phone number validation (after normalization)
 */
const optionalPhoneSchema = z
  .string()
  .optional()
  .transform((val, ctx) => {
    if (!val || val.trim() === "") return undefined;
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
 * Request body schema: Discord OAuth2 code + redirect_uri + state (CSRF) + optional phone + optional signup code
 */
const discordAuthSchema = z.object({
  // OAuth2 authorization code from Discord redirect
  code: z.string().min(1, "Authorization code is required"),
  // The redirect_uri used in the original authorization request (must match exactly)
  redirect_uri: z.string().url("Invalid redirect URI"),
  // OAuth2 state parameter for CSRF protection (must be a 64-char hex string)
  state: z
    .string()
    .min(1, "State parameter is required for CSRF protection")
    .regex(/^[0-9a-f]{64}$/, "Invalid state parameter format"),
  // Optional phone number for cross-platform linking
  phone_number: optionalPhoneSchema,
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
    discord_id: string;
    discord_username: string | null;
    discord_global_name: string | null;
    phone_number: string | null;
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

async function handleDiscordAuth(request: Request): Promise<Response> {
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

  const parseResult = discordAuthSchema.safeParse(body);
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

  const {
    code,
    redirect_uri: redirectUri,
    state,
    phone_number: phoneNumber,
    signup_code: signupCode,
  } = parseResult.data;

  logger.info("[ElizaApp DiscordAuth] Processing OAuth2 callback", {
    redirectUri,
    statePrefix: state.slice(0, 8) + "...",
    hasPhone: !!phoneNumber,
    hasSignupCode: !!signupCode,
  });

  // Check for existing session (session-based linking: user already logged in via another platform)
  const authHeader = request.headers.get("authorization");
  let existingSession: ValidatedSession | null = null;
  if (authHeader) {
    existingSession = await elizaAppSessionService.validateAuthHeader(authHeader);
    if (existingSession) {
      logger.info("[ElizaApp DiscordAuth] Session-based linking detected", {
        existingUserId: existingSession.userId,
      });
    }
  }

  // Exchange OAuth2 code for Discord user data
  const discordUser = await discordAuthService.verifyOAuthCode(code, redirectUri);

  if (!discordUser) {
    logger.warn("[ElizaApp DiscordAuth] OAuth2 verification failed");
    return Response.json(
      {
        success: false,
        error: "Invalid or expired authorization code",
        code: "INVALID_AUTH",
      },
      { status: 401 },
    );
  }

  // Build avatar URL
  const avatarUrl = discordAuthService.getAvatarUrl(discordUser.id, discordUser.avatar);

  let user: User;
  let organization: Organization;
  let isNew: boolean;

  if (existingSession) {
    // ---- SESSION-BASED LINKING: Link Discord to existing user ----
    const linkResult = await elizaAppUserService.linkDiscordToUser(existingSession.userId, {
      discordId: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name,
      avatarUrl,
    });

    if (!linkResult.success) {
      return Response.json(
        {
          success: false,
          error: linkResult.error || "This Discord account is already linked to another account",
          code: "DISCORD_ALREADY_LINKED",
        },
        { status: 409 },
      );
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

    logger.info("[ElizaApp DiscordAuth] Session-based Discord linking successful", {
      userId: user.id,
      discordId: discordUser.id,
    });
  } else {
    // ---- STANDARD FLOW: Find or create user by Discord ID (with optional phone cross-linking) ----
    let result;
    try {
      result = await elizaAppUserService.findOrCreateByDiscordId(
        discordUser.id,
        {
          username: discordUser.username,
          globalName: discordUser.global_name,
          avatarUrl,
        },
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
        if (error.message === "DISCORD_ALREADY_LINKED") {
          return Response.json(
            {
              success: false,
              error: "This Discord account is already linked to another user",
              code: "DISCORD_ALREADY_LINKED",
            },
            { status: 409 },
          );
        }
      }
      logger.error("[ElizaApp DiscordAuth] Unexpected error during user creation", {
        error: error instanceof Error ? error.message : String(error),
        discordId: discordUser.id,
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

    // If phone was provided but not linked during findOrCreate (e.g., user already existed without phone),
    // attempt to link it separately
    if (phoneNumber && !user.phone_number) {
      const linkResult = await elizaAppUserService.linkPhoneToUser(user.id, phoneNumber);
      if (!linkResult.success) {
        return Response.json(
          {
            success: false,
            error: linkResult.error || "This phone number is already linked to a different account",
            code: "PHONE_ALREADY_LINKED",
          },
          { status: 409 },
        );
      }
      // Refetch user to reflect the newly linked phone number in the response
      const updatedUser = await elizaAppUserService.getByDiscordId(discordUser.id);
      if (updatedUser) {
        user = updatedUser;
      }
    }
  }

  logger.info("[ElizaApp DiscordAuth] Authentication successful", {
    userId: user.id,
    discordId: discordUser.id,
    username: discordUser.username,
    phoneNumber: phoneNumber ? `***${phoneNumber.slice(-4)}` : "not provided",
    isNewUser: isNew,
    sessionBased: !!existingSession,
  });

  // Create session (new session includes discord identity)
  const session = await elizaAppSessionService.createSession(user.id, organization.id, {
    discordId: discordUser.id,
    ...(user.phone_number && { phoneNumber: user.phone_number }),
    ...(user.telegram_id && { telegramId: user.telegram_id }),
    ...(user.whatsapp_id && { whatsappId: user.whatsapp_id }),
  });

  return Response.json({
    success: true,
    user: {
      id: user.id,
      discord_id: discordUser.id,
      discord_username: user.discord_username,
      discord_global_name: user.discord_global_name,
      phone_number: user.phone_number,
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
    service: "eliza-app-discord-auth",
    timestamp: new Date().toISOString(),
  });
}

const honoRouter = new Hono<AppEnv>();
honoRouter.get("/", async () => __next_GET());
honoRouter.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handleDiscordAuth(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;

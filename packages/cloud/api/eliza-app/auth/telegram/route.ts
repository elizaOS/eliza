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
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  elizaAppSessionService,
  elizaAppUserService,
  type TelegramAuthData,
  telegramAuthService,
  type ValidatedSession,
} from "@/lib/services/eliza-app";
import {
  claimTelegramOnboardingContinuation,
  completeTelegramOnboardingContinuationClaim,
  runOnboardingChat,
  type TelegramOnboardingContinuationClaim,
} from "@/lib/services/eliza-app/onboarding-chat";
import { invalidatePersonalDeliveryProjection } from "@/lib/services/eliza-app/personal-delivery-projection-contract";
import { logger } from "@/lib/utils/logger";
import {
  isValidE164,
  normalizePhoneNumber,
} from "@/lib/utils/phone-normalization";
import type {
  AppEnv,
  RuntimeDurableObjectNamespace,
} from "@/types/cloud-worker-env";

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
        message:
          "Invalid phone number format. Please use international format (e.g., +1234567890)",
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
  // Opaque token issued by the trusted Telegram gateway onboarding session.
  onboarding_session: z.string().min(8).max(180).optional(),
});

export interface TelegramAuthDependencies {
  verifyAuth: typeof telegramAuthService.verifyAuth;
  validateAuthHeader: typeof elizaAppSessionService.validateAuthHeader;
  createSession: typeof elizaAppSessionService.createSession;
  getById: typeof elizaAppUserService.getById;
  getByIdForWrite: typeof elizaAppUserService.getByIdForWrite;
  getByTelegramId: typeof elizaAppUserService.getByTelegramId;
  getByPhoneNumber: typeof elizaAppUserService.getByPhoneNumber;
  linkTelegramAndPhoneToUser: typeof elizaAppUserService.linkTelegramAndPhoneToUser;
  findOrCreateByTelegramWithPhone: typeof elizaAppUserService.findOrCreateByTelegramWithPhone;
  claimContinuation: typeof claimTelegramOnboardingContinuation;
  completeContinuationClaim: typeof completeTelegramOnboardingContinuationClaim;
  redeemContinuation: typeof runOnboardingChat;
}

const defaultDependencies: TelegramAuthDependencies = {
  verifyAuth: (data) => telegramAuthService.verifyAuth(data),
  validateAuthHeader: (header) =>
    elizaAppSessionService.validateAuthHeader(header),
  createSession: (...args) => elizaAppSessionService.createSession(...args),
  getById: (id) => elizaAppUserService.getById(id),
  getByIdForWrite: (id) => elizaAppUserService.getByIdForWrite(id),
  getByTelegramId: (id) => elizaAppUserService.getByTelegramId(id),
  getByPhoneNumber: (phone) => elizaAppUserService.getByPhoneNumber(phone),
  linkTelegramAndPhoneToUser: (...args) =>
    elizaAppUserService.linkTelegramAndPhoneToUser(...args),
  findOrCreateByTelegramWithPhone: (...args) =>
    elizaAppUserService.findOrCreateByTelegramWithPhone(...args),
  claimContinuation: (input) => claimTelegramOnboardingContinuation(input),
  completeContinuationClaim: (input) =>
    completeTelegramOnboardingContinuationClaim(input),
  redeemContinuation: (input) => runOnboardingChat(input),
};

/**
 * Deterministic id for one continuation attempt lineage. Account ids are
 * deliberately excluded: the first anonymous attempt may create the account,
 * and the identical signed retry must hash to the same lineage to resume the
 * claim it already holds. Account binding lives in the claim record itself.
 */
async function createContinuationClaimId(input: {
  continuationToken: string;
  telegramId: string;
  phoneNumber: string;
}): Promise<string> {
  const material = JSON.stringify([
    input.continuationToken,
    input.telegramId,
    input.phoneNumber,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Rejects the request when the target account's phone bindings conflict with
 * the phone in this signed attempt. Runs BEFORE any durable identity link so
 * a rejected request cannot leave a half-linked identity behind.
 */
async function phoneBindingConflict(
  dependencies: TelegramAuthDependencies,
  account: { userId: string; organizationId: string },
  phoneNumber: string,
): Promise<Response | null> {
  const [user, phoneOwner] = await Promise.all([
    dependencies.getById(account.userId),
    dependencies.getByPhoneNumber(phoneNumber),
  ]);
  if (
    !user?.organization ||
    user.organization.id !== account.organizationId ||
    (user.phone_number && user.phone_number !== phoneNumber) ||
    (phoneOwner && phoneOwner.id !== account.userId)
  ) {
    return Response.json(
      {
        success: false,
        error: "This phone number is already linked to a different account",
        code: "PHONE_ALREADY_LINKED",
      },
      { status: 409 },
    );
  }
  return null;
}

function isTelegramContinuationClaim(
  value: unknown,
): value is TelegramOnboardingContinuationClaim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Record<string, unknown>;
  if (typeof claim.sessionId !== "string" || !claim.sessionId) return false;
  if (claim.status === "acquired") return true;
  return (
    claim.status === "completed" &&
    typeof claim.userId === "string" &&
    Boolean(claim.userId) &&
    typeof claim.organizationId === "string" &&
    Boolean(claim.organizationId)
  );
}

export async function handleTelegramAuth(
  request: Request,
  dependencies: TelegramAuthDependencies = defaultDependencies,
  personalDeliveryProjections?: RuntimeDurableObjectNamespace,
): Promise<Response> {
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

  const {
    phone_number: phoneNumber,
    signup_code: signupCode,
    onboarding_session: onboardingSession,
    ...telegramData
  } = parseResult.data;
  const authData: TelegramAuthData = telegramData;

  // Verify Telegram authentication data
  const isValid = dependencies.verifyAuth(authData);

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
    existingSession = await dependencies.validateAuthHeader(authHeader);
    if (existingSession) {
      logger.info("[ElizaApp TelegramAuth] Session-based linking detected", {
        existingUserId: existingSession.userId,
      });
    }
  }

  // A bot continuation is a credential, not a convenience query parameter.
  // Claim it in the token Durable Object before any durable identity mutation.
  // The claim serializes concurrent requests and binds the signed Telegram ID,
  // phone, user, and organization for the lifetime of the attempt.
  let continuationClaimId: string | undefined;
  let continuationClaim: TelegramOnboardingContinuationClaim | undefined;
  if (onboardingSession) {
    let prospectiveAccount:
      | { userId: string; organizationId: string }
      | undefined;
    if (existingSession) {
      const existingUser = await dependencies.getById(existingSession.userId);
      if (
        !existingUser?.organization ||
        existingUser.organization.id !== existingSession.organizationId
      ) {
        return Response.json(
          {
            success: false,
            error: "Invalid or stale authenticated session",
            code: "INVALID_SESSION_SCOPE",
          },
          { status: 403 },
        );
      }
      prospectiveAccount = {
        userId: existingUser.id,
        organizationId: existingUser.organization.id,
      };
    } else {
      const existingUser =
        (await dependencies.getByTelegramId(String(authData.id))) ??
        (await dependencies.getByPhoneNumber(phoneNumber));
      if (existingUser?.organization) {
        prospectiveAccount = {
          userId: existingUser.id,
          organizationId: existingUser.organization.id,
        };
      }
    }

    if (prospectiveAccount) {
      const conflict = await phoneBindingConflict(
        dependencies,
        prospectiveAccount,
        phoneNumber,
      );
      if (conflict) return conflict;
    }

    continuationClaimId = await createContinuationClaimId({
      continuationToken: onboardingSession,
      telegramId: String(authData.id),
      phoneNumber,
    });

    try {
      const claimed = await dependencies.claimContinuation({
        continuationToken: onboardingSession,
        claimId: continuationClaimId,
        telegramId: String(authData.id),
        phoneNumber,
        authenticatedAccount: prospectiveAccount,
      });
      if (!isTelegramContinuationClaim(claimed)) {
        throw new Error("Malformed Telegram continuation claim response");
      }
      continuationClaim = claimed;
    } catch (error) {
      logger.warn("[ElizaApp TelegramAuth] Bot continuation rejected", {
        telegramId: authData.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json(
        {
          success: false,
          error: "Invalid, expired, or already active Telegram onboarding link",
          code: "INVALID_ONBOARDING_CONTINUATION",
        },
        { status: 403 },
      );
    }
  }

  let user: User;
  let organization: Organization;
  let isNew: boolean;

  if (continuationClaim?.status === "completed") {
    const completedUser = continuationClaim.userId
      ? await dependencies.getById(continuationClaim.userId)
      : undefined;
    if (
      !completedUser?.organization ||
      completedUser.organization.id !== continuationClaim.organizationId ||
      completedUser.telegram_id !== String(authData.id) ||
      completedUser.phone_number !== phoneNumber
    ) {
      return Response.json(
        {
          success: false,
          error: "Completed continuation account no longer matches",
          code: "ONBOARDING_ACCOUNT_MISMATCH",
        },
        { status: 409 },
      );
    }
    user = completedUser;
    organization = completedUser.organization;
    isNew = false;
  } else if (existingSession) {
    // ---- SESSION-BASED LINKING: Link Telegram + phone to existing user ----
    // The continuation path validated phone bindings before claiming; the
    // plain linking path must do the same before the durable Telegram link,
    // or the strict identity check below would reject a request whose
    // mutation already happened.
    if (!onboardingSession) {
      const conflict = await phoneBindingConflict(
        dependencies,
        existingSession,
        phoneNumber,
      );
      if (conflict) return conflict;
    }
    const linkIdentityResult = await dependencies.linkTelegramAndPhoneToUser(
      existingSession.userId,
      authData,
      phoneNumber,
    );

    if (!linkIdentityResult.success) {
      return Response.json(
        {
          success: false,
          error:
            linkIdentityResult.error ||
            "This Telegram account or phone number could not be linked",
          code: "IDENTITY_LINK_FAILED",
        },
        { status: 409 },
      );
    }

    // Fetch the updated user
    const updatedUser = await dependencies.getByIdForWrite(
      existingSession.userId,
    );
    if (
      !updatedUser?.organization ||
      updatedUser.telegram_id !== String(authData.id) ||
      updatedUser.phone_number !== phoneNumber
    ) {
      return Response.json(
        {
          success: false,
          error: "User identity bindings do not match after linking",
          code: "IDENTITY_LINK_MISMATCH",
        },
        { status: 409 },
      );
    }

    user = updatedUser;
    organization = updatedUser.organization;
    isNew = false;

    logger.info(
      "[ElizaApp TelegramAuth] Session-based Telegram linking successful",
      {
        userId: user.id,
        telegramId: authData.id,
      },
    );
  } else {
    // ---- STANDARD FLOW: Find or create user with both Telegram and phone number ----
    // Note: Conflict checks are handled in the service layer with database constraints
    // to avoid TOCTOU race conditions. The service returns proper error codes.
    let result: Awaited<
      ReturnType<typeof elizaAppUserService.findOrCreateByTelegramWithPhone>
    >;
    try {
      result = await dependencies.findOrCreateByTelegramWithPhone(
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
              error:
                "This phone number is already linked to a different account",
              code: "PHONE_ALREADY_LINKED",
            },
            { status: 409 },
          );
        }
        if (error.message === "PHONE_MISMATCH") {
          return Response.json(
            {
              success: false,
              error:
                "Your Telegram account is already linked to a different phone number",
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
      logger.error(
        "[ElizaApp TelegramAuth] Unexpected error during authentication",
        {
          error: error instanceof Error ? error.message : String(error),
          telegramId: authData.id,
        },
      );
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

  if (
    user.telegram_id !== String(authData.id) ||
    user.phone_number !== phoneNumber
  ) {
    return Response.json(
      {
        success: false,
        error: "Authenticated identity bindings do not match",
        code: "IDENTITY_LINK_MISMATCH",
      },
      { status: 409 },
    );
  }

  await invalidatePersonalDeliveryProjection(
    personalDeliveryProjections,
    "telegram",
    String(authData.id),
  );

  logger.info("[ElizaApp TelegramAuth] Authentication successful", {
    userId: user.id,
    telegramId: authData.id,
    username: authData.username,
    phoneNumber: `***${phoneNumber.slice(-4)}`,
    isNewUser: isNew,
    sessionBased: !!existingSession,
    hasSignupCode: !!signupCode,
  });

  if (
    onboardingSession &&
    continuationClaimId &&
    continuationClaim?.status === "acquired"
  ) {
    try {
      await dependencies.redeemContinuation({
        sessionId: onboardingSession,
        platform: "telegram",
        continuationMode: "trusted-telegram",
        authenticatedUser: {
          userId: user.id,
          organizationId: organization.id,
          telegramId: String(authData.id),
        },
        trustedPlatformIdentity: false,
        // The token scopes the key: a later, different continuation for the
        // same Telegram user must not replay this redemption's result.
        idempotencyKey: `telegram-auth-continuation:${authData.id}:${onboardingSession}`,
      });
      await dependencies.completeContinuationClaim({
        continuationToken: onboardingSession,
        claimId: continuationClaimId,
        telegramId: String(authData.id),
        phoneNumber,
        userId: user.id,
        organizationId: organization.id,
      });
    } catch (error) {
      logger.error(
        "[ElizaApp TelegramAuth] Bot continuation redemption failed",
        {
          userId: user.id,
          telegramId: authData.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return Response.json(
        {
          success: false,
          error:
            "Telegram was verified, but onboarding could not be completed. Please retry.",
          code: "ONBOARDING_CONTINUATION_FAILED",
        },
        { status: 503 },
      );
    }
  }

  // Create session (new session includes all known identities)
  const session = await dependencies.createSession(user.id, organization.id, {
    telegramId: String(authData.id),
    phoneNumber: user.phone_number,
    ...(user.discord_id && { discordId: user.discord_id }),
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
    ...(onboardingSession && { continuation_redeemed: true }),
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
    return await handleTelegramAuth(
      c.req.raw,
      defaultDependencies,
      c.env.PERSONAL_DELIVERY_PROJECTIONS,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;

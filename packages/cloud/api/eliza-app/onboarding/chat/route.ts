/**
 * POST /api/eliza-app/onboarding/chat
 *
 * Public chat-first onboarding endpoint. Anonymous users get a persistent
 * onboarding session and login action; authenticated users trigger agent
 * provisioning and handoff memory copy.
 */

import { isElizaError } from "@elizaos/core/edge";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { providerForPlatform, usersRepository } from "@/db/repositories/users";
import {
  ApiError,
  ForbiddenError,
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import {
  inspectOnboardingContinuation,
  type OnboardingContinuationPreview,
  type OnboardingPlatform,
  previewTelegramPersonalAccountClaimContinuation,
  runOnboardingChat,
} from "@/lib/services/eliza-app/onboarding-chat";
import { publicElizaAppProvisioningPayload } from "@/lib/services/eliza-app/provisioning";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../internal/_auth";

const app = new Hono<AppEnv>();

const platformSchema = z.enum([
  "web",
  "telegram",
  "discord",
  "whatsapp",
  "twilio",
  "blooio",
]);

/**
 * A steward session JWT on the Authorization header: three non-empty dot-parts.
 * The internal gateway secret is a flat string and eliza-app JWTs are already
 * consumed above, so this gates exactly the steward branch — and, critically,
 * keeps `getCurrentUser`'s cookie fallback out of this route (see the CSRF
 * rationale at the call site).
 */
function looksLikeStewardBearer(authHeader: string): boolean {
  if (!authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7).trim();
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

const chatSchema = z.object({
  sessionId: z.string().trim().min(8).max(180).optional(),
  message: z.string().trim().max(4000).optional(),
  platform: platformSchema.optional(),
  platformUserId: z.string().trim().max(256).optional(),
  platformDisplayName: z.string().trim().max(120).optional(),
  platformReplyAddress: z.string().trim().max(256).optional(),
  statusOnly: z.boolean().optional(),
  confirmPlatformLink: z.boolean().optional(),
});

app.get("/", async (c) => {
  try {
    const token = c.req.query("sessionId")?.trim();
    if (!token) throw ValidationError("Missing onboarding session");
    const caller = await resolveCaller(c, {});
    if (!caller.authenticatedUser || caller.trustedPlatformIdentity) {
      throw ForbiddenError("Browser authentication required");
    }
    let preview: OnboardingContinuationPreview;
    try {
      preview = await inspectOnboardingContinuation(
        token,
        caller.authenticatedUser,
      );
    } catch (error) {
      // A Telegram account-claim session is bound to the DM-created account
      // it lets the caller claim, so the account-bound preview rejects it.
      // Fall back to the read-only claim preview so the landing can name the
      // Telegram identity before the user confirms; any other failure — or an
      // invalid claim continuation — keeps the original fail-closed response.
      if (
        !isElizaError(error) ||
        error.code !== "ONBOARDING_TRUSTED_CONTINUATION_INVALID"
      ) {
        throw error;
      }
      preview = await previewTelegramPersonalAccountClaimContinuation(token);
    }
    return c.json({ success: true, data: preview });
  } catch (error) {
    if (
      isElizaError(error) &&
      (error.code === "ONBOARDING_PLATFORM_IDENTITY_MISMATCH" ||
        error.code === "ONBOARDING_TRUSTED_CONTINUATION_INVALID")
    ) {
      return failureResponse(
        c,
        ForbiddenError(
          error.code === "ONBOARDING_PLATFORM_IDENTITY_MISMATCH"
            ? "Authenticate with the same messaging account that started this onboarding session"
            : "This connection link is invalid or expired",
        ),
      );
    }
    return failureResponse(c, error);
  }
});

/**
 * Identifies the caller and, for a trusted platform gateway, the cloud account
 * behind the platform identity it attests.
 *
 * The gateway proves only "this message came from telegram user X"; it never
 * names the account. The account is resolved here, server-side, from the
 * platform id — the same direction the Discord router already takes. Accepting
 * a caller-supplied userId/organizationId would let any holder of the flat
 * internal secret provision into, and receive an agent credential for, an
 * organization it does not own.
 */
async function resolveCaller(
  c: Context<AppEnv>,
  platformIdentity: { platform?: string; platformUserId?: string },
): Promise<{
  authenticatedUser: {
    userId: string;
    organizationId: string;
    telegramId?: string;
    discordId?: string;
  } | null;
  trustedPlatformIdentity: boolean;
}> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return { authenticatedUser: null, trustedPlatformIdentity: false };
  }

  const session = await elizaAppSessionService.validateAuthHeader(authHeader);
  if (session) {
    return {
      authenticatedUser: {
        userId: session.userId,
        organizationId: session.organizationId,
        telegramId: session.telegramId,
        discordId: session.discordId,
      },
      trustedPlatformIdentity: false,
    };
  }

  // Steward session — the branded email/OAuth login on the eliza.app hosts —
  // accepted by BEARER ONLY, never the steward-token cookie: this POST binds
  // sessions, links identities and starts provisioning, and Hono's
  // `req.json()` parses a cross-site text/plain simple request, so a
  // cookie-authenticated call would be a CSRF surface (an attacker holding
  // their own Discord continuation token could drive a victim's browser into
  // binding the attacker's messaging identity to the victim's account). The
  // SPA transport always attaches the localStorage bearer, which no other
  // origin can send.
  //
  // A steward caller is a browser continuation, NEVER a trusted platform
  // transport: trustedPlatformIdentity stays false, so it cannot mint
  // platform-scoped sessions or claim platform identities from the request
  // body. Identity linking still happens because the SESSION carries
  // platformIdentityTrusted from the gateway turn that created it, and the
  // opaque continuation token proves ownership.
  if (looksLikeStewardBearer(authHeader)) {
    const stewardUser = await getCurrentUser(c);
    if (stewardUser) {
      if (stewardUser.is_active === false) {
        throw ForbiddenError("User account is inactive");
      }
      if (stewardUser.organization_id) {
        if (!stewardUser.organization) {
          throw ForbiddenError("Organization membership is unavailable");
        }
        if (stewardUser.organization.is_active === false) {
          throw ForbiddenError("Organization is inactive");
        }
        return {
          authenticatedUser: {
            userId: stewardUser.id,
            organizationId: stewardUser.organization_id,
          },
          trustedPlatformIdentity: false,
        };
      }
      // A steward user without an organization has nothing to provision into;
      // treat as unauthenticated rather than falling through to internal auth
      // (which would reject their valid-but-orgless session as a bad header).
      return { authenticatedUser: null, trustedPlatformIdentity: false };
    }
  }

  const internal = await requireInternalAuth(c);
  if (internal instanceof Response) {
    throw ValidationError("Invalid Authorization header");
  }

  return {
    authenticatedUser: await resolvePlatformAccount(platformIdentity),
    trustedPlatformIdentity: true,
  };
}

/**
 * Resolves the cloud account owning a platform identity, or null when there is
 * none to resolve. A user without an organization counts as unresolved — the
 * same call has nothing to provision into, which is why
 * `internal/identity/resolve` answers 404 for it.
 *
 * The provider is required, not optional: `resolveIdentity` without one falls
 * back to sniffing the identifier's shape and would happily match a UUID, an
 * email or a wallet address, which is a wider claim than "this is telegram user
 * X" — the only claim a gateway can actually make.
 */
async function resolvePlatformAccount(identity: {
  platform?: string;
  platformUserId?: string;
}): Promise<{ userId: string; organizationId: string } | null> {
  const provider = providerForPlatform(identity.platform);
  if (!provider || !identity.platformUserId) return null;

  const resolved = await usersRepository.resolveIdentity(
    identity.platformUserId,
    provider,
  );
  const organizationId = resolved?.user.organization_id;
  if (!resolved || !organizationId) return null;

  return { userId: resolved.user.id, organizationId };
}

app.post("/", async (c) => {
  try {
    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      throw ValidationError("Invalid JSON body");
    }
    const body = decodedBody.value;
    const parsed = chatSchema.safeParse(body);
    if (!parsed.success) {
      throw ValidationError("Invalid request data", {
        issues: parsed.error.issues,
      });
    }

    const caller = await resolveCaller(c, parsed.data);
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    const result = await runOnboardingChat({
      sessionId: parsed.data.sessionId,
      message: parsed.data.message,
      platform: parsed.data.platform as OnboardingPlatform | undefined,
      platformUserId: parsed.data.platformUserId,
      platformDisplayName: parsed.data.platformDisplayName,
      platformReplyAddress: caller.trustedPlatformIdentity
        ? parsed.data.platformReplyAddress
        : undefined,
      authenticatedUser: caller.authenticatedUser,
      trustedPlatformIdentity: caller.trustedPlatformIdentity,
      idempotencyKey: idempotencyKey || undefined,
      statusOnly: parsed.data.statusOnly ?? false,
      confirmPlatformLink: parsed.data.confirmPlatformLink,
    });

    // A platform gateway relays a reply back over the connector; it reads
    // nothing else. `launchUrl` carries a cloudLaunchSession that redeems for
    // the agent's bearer token with no authentication, `loginUrl` carries the
    // session-continuation token, and `messages` is the full transcript — none
    // belongs on a response addressed to a service that only speaks for a
    // platform identity. When the user genuinely needs the login link, it is
    // already inside `reply`, which is the field the gateway delivers.
    const browserOnly = caller.trustedPlatformIdentity
      ? {}
      : {
          loginUrl: result.loginUrl,
          controlPanelUrl: result.controlPanelUrl,
          launchUrl: result.launchUrl,
          messages: result.session.history,
        };

    return c.json({
      success: true,
      data: {
        sessionId: result.session.id,
        reply: result.reply,
        requiresLogin: result.requiresLogin,
        handoffComplete: result.handoffComplete,
        provisioning: publicElizaAppProvisioningPayload(result.provisioning),
        ...browserOnly,
      },
    });
  } catch (error) {
    if (
      isElizaError(error) &&
      (error.code === "ONBOARDING_PLATFORM_IDENTITY_MISMATCH" ||
        error.code === "ONBOARDING_TRUSTED_CONTINUATION_INVALID")
    ) {
      // error-policy:J1 translate fail-closed continuation rejection into one
      // stable authorization response without disclosing session existence.
      logger.warn("[eliza-app onboarding/chat] Continuation rejected", {
        context: error.context,
      });
      return failureResponse(
        c,
        ForbiddenError(
          "Authenticate with the same messaging account that started this onboarding session",
        ),
      );
    }
    if (
      isElizaError(error) &&
      error.code === "ONBOARDING_PLATFORM_LINK_CONFIRMATION_REQUIRED"
    ) {
      return failureResponse(
        c,
        new ApiError(
          409,
          "session_not_ready",
          "Confirm the messaging account before connecting it",
        ),
      );
    }
    if (
      isElizaError(error) &&
      error.code === "ONBOARDING_PLATFORM_IDENTITY_CONFLICT"
    ) {
      return failureResponse(
        c,
        new ApiError(
          409,
          "identity_conflict",
          "This messaging account is already linked to another account",
        ),
      );
    }
    logger.error("[eliza-app onboarding/chat] Error", { error });
    return failureResponse(c, error);
  }
});

export default app;

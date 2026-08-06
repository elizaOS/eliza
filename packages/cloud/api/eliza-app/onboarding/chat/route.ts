/**
 * POST /api/eliza-app/onboarding/chat
 *
 * Public chat-first onboarding endpoint. Anonymous users get a persistent
 * onboarding session and login action; authenticated users trigger agent
 * provisioning and handoff memory copy.
 */

import { type Context, Hono } from "hono";
import { z } from "zod";
import { providerForPlatform, usersRepository } from "@/db/repositories/users";
import {
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import {
  type OnboardingPlatform,
  runOnboardingChat,
} from "@/lib/services/eliza-app/onboarding-chat";
import { publicElizaAppProvisioningPayload } from "@/lib/services/eliza-app/provisioning";
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

const chatSchema = z.object({
  sessionId: z.string().trim().min(8).max(180).optional(),
  message: z.string().trim().max(4000).optional(),
  platform: platformSchema.optional(),
  platformUserId: z.string().trim().max(256).optional(),
  platformDisplayName: z.string().trim().max(120).optional(),
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
  authenticatedUser: { userId: string; organizationId: string } | null;
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
      },
      trustedPlatformIdentity: false,
    };
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
    const body = await c.req.json().catch(() => {
      throw ValidationError("Invalid JSON body");
    });
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
      authenticatedUser: caller.authenticatedUser,
      trustedPlatformIdentity: caller.trustedPlatformIdentity,
      idempotencyKey: idempotencyKey || undefined,
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
    logger.error("[eliza-app onboarding/chat] Error", { error });
    return failureResponse(c, error);
  }
});

export default app;

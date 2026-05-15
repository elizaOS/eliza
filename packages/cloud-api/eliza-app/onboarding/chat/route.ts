/**
 * POST /api/eliza-app/onboarding/chat
 *
 * Public chat-first onboarding endpoint. Anonymous users get a persistent
 * onboarding session and login action; authenticated users trigger agent
 * provisioning and handoff memory copy.
 */

import { type Context, Hono } from "hono";
import { z } from "zod";
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

async function resolveCaller(c: Context<AppEnv>): Promise<{
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

  return { authenticatedUser: null, trustedPlatformIdentity: true };
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

    const caller = await resolveCaller(c);
    const result = await runOnboardingChat({
      sessionId: parsed.data.sessionId,
      message: parsed.data.message,
      platform: parsed.data.platform as OnboardingPlatform | undefined,
      platformUserId: parsed.data.platformUserId,
      platformDisplayName: parsed.data.platformDisplayName,
      authenticatedUser: caller.authenticatedUser,
      trustedPlatformIdentity: caller.trustedPlatformIdentity,
    });

    return c.json({
      success: true,
      data: {
        sessionId: result.session.id,
        reply: result.reply,
        requiresLogin: result.requiresLogin,
        loginUrl: result.loginUrl,
        controlPanelUrl: result.controlPanelUrl,
        launchUrl: result.launchUrl,
        handoffComplete: result.handoffComplete,
        provisioning: publicElizaAppProvisioningPayload(result.provisioning),
        messages: result.session.history,
      },
    });
  } catch (error) {
    logger.error("[eliza-app onboarding/chat] Error", { error });
    return failureResponse(c, error);
  }
});

export default app;

// Handles v1 cloud API v1 apps id telegram automation post route traffic with route-local auth expectations.

import type { RouteContext } from "@elizaos/cloud-shared/lib/api/hono-next-style-params";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

/**
 * App Telegram Post API
 *
 * Manually trigger an announcement for an app.
 */

import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { deferredCredentialAdmissionGuard } from "@elizaos/cloud-shared/lib/services/deferred-credential-admission-guard";
import {
  type GenerativeOperationContext,
  isGenerativeOperationAdmissionError,
} from "@elizaos/cloud-shared/lib/services/generative-operation";
import { telegramAppAutomationService } from "@elizaos/cloud-shared/lib/services/telegram-automation/app-automation";
import { decodeOptionalRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { z } from "zod";
import {
  asGenerativeCacheApiError,
  getGenerativeOperationContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";

const postSchema = z.object({
  text: z.string().max(4000).optional(),
  channelId: z.string().optional(),
  groupId: z.string().optional(),
});

async function __hono_POST(
  request: Request,
  { params }: RouteContext<{ id: string }>,
  caller: Awaited<ReturnType<typeof requireGenerativeRouteCaller>>,
  operationContext: GenerativeOperationContext,
): Promise<Response> {
  const { user } = caller;
  const { id: appId } = await params;
  if (caller.appScopeId && caller.appScopeId !== appId) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  // Without text the service posts a generated announcement, so a
  // malformed body must be rejected rather than read as "no text".
  const decodedBody = await decodeOptionalRequestJson(request);
  if (!decodedBody.ok) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(decodedBody.value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "Validation failed", details: error.flatten() },
        { status: 400 },
      );
    }
    throw error;
  }

  try {
    const chatIdOverride = body.channelId || body.groupId;
    const result = await telegramAppAutomationService.postAnnouncement(
      user.organization_id,
      appId,
      body.text,
      chatIdOverride,
      operationContext,
    );

    if (!result.success) {
      return Response.json(
        { error: result.error || "Failed to post" },
        { status: 400 },
      );
    }

    logger.info("[Telegram Post] Announcement posted", {
      appId,
      organizationId: user.organization_id,
      messageId: result.messageId,
      chatId: result.chatId,
    });

    return Response.json({
      success: true,
      messageId: result.messageId,
      chatId: result.chatId,
    });
  } catch (error) {
    if (isGenerativeOperationAdmissionError(error)) throw error;
    if (error instanceof Error && error.message === "App not found") {
      return Response.json({ error: "App not found" }, { status: 404 });
    }
    logger.error("[Telegram Post] Failed to post", {
      appId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return Response.json({ error: "Failed to post" }, { status: 500 });
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) => {
  try {
    const caller = await requireGenerativeRouteCaller(c, {
      rateLimitEndpoint: "strict",
      deferStrongCredentialCheck: true,
    });
    await using credentialGuard = deferredCredentialAdmissionGuard({
      organizationId: () => caller.user.organization_id,
      credential: () => caller.credential,
    });
    return await __hono_POST(
      c.req.raw,
      { params: Promise.resolve({ id: c.req.param("id")! }) },
      caller,
      getGenerativeOperationContext(c, caller, {
        credentialForAdmission: () => credentialGuard.credentialForAdmission(),
      }),
    );
  } catch (error) {
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});
export default __hono_app;

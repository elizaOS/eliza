import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * App Telegram Post API
 *
 * Manually trigger an announcement for an app.
 */

import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { telegramAppAutomationService } from "@/lib/services/telegram-automation/app-automation";
import { logger } from "@/lib/utils/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const postSchema = z.object({
  text: z.string().max(4000).optional(),
  channelId: z.string().optional(),
  groupId: z.string().optional(),
});

async function __hono_POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id: appId } = await params;

  let body: z.infer<typeof postSchema>;
  try {
    const rawBody = await request.json().catch(() => ({}));
    body = postSchema.parse(rawBody);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "Validation failed", details: error.flatten() },
        { status: 400 },
      );
    }
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const chatIdOverride = body.channelId || body.groupId;
    const result = await telegramAppAutomationService.postAnnouncement(
      user.organization_id,
      appId,
      body.text,
      chatIdOverride,
    );

    if (!result.success) {
      return Response.json({ error: result.error || "Failed to post" }, { status: 400 });
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
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;

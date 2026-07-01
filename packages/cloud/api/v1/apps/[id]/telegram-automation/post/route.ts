import { Hono } from "hono";
import type { RouteContext } from "@/lib/api/hono-next-style-params";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * App Telegram Post API
 *
 * Manually trigger an announcement for an app.
 */

import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { telegramAppAutomationService } from "@/lib/services/telegram-automation/app-automation";
import { logger } from "@/lib/utils/logger";

const postSchema = z.object({
  text: z.string().max(4000).optional(),
  channelId: z.string().optional(),
  groupId: z.string().optional(),
});

async function __hono_POST(
  request: Request,
  { params }: RouteContext<{ id: string }>,
): Promise<Response> {
  const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);
  const { id: appId } = await params;

  // A per-app API key may only act on its own app, never a sibling (#10852).
  if (await appsService.isApiKeyScopedToOtherApp(apiKey?.id, appId)) {
    return Response.json(
      { success: false, error: "This API key is scoped to a different app" },
      { status: 403 },
    );
  }

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
  __hono_POST(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
export default __hono_app;

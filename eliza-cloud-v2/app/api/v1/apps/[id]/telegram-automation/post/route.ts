/**
 * App Telegram Post API
 *
 * Manually trigger an announcement for an app.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { telegramAppAutomationService } from "@/lib/services/telegram-automation";
import { logger } from "@/lib/utils/logger";

export const maxDuration = 60;

interface RouteParams {
  params: Promise<{ id: string }>;
}

const postSchema = z.object({
  text: z.string().max(4000).optional(),
  channelId: z.string().optional(),
  groupId: z.string().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id: appId } = await params;

  let body: z.infer<typeof postSchema>;
  try {
    const rawBody = await request.json().catch(() => ({}));
    body = postSchema.parse(rawBody);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.flatten() },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
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
      return NextResponse.json(
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

    return NextResponse.json({
      success: true,
      messageId: result.messageId,
      chatId: result.chatId,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "App not found") {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }
    logger.error("[Telegram Post] Failed to post", {
      appId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json({ error: "Failed to post" }, { status: 500 });
  }
}

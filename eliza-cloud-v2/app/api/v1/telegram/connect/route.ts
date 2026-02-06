/**
 * Telegram Connect API
 *
 * Validates a bot token and stores credentials for the organization.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { telegramAutomationService } from "@/lib/services/telegram-automation";
import { logger } from "@/lib/utils/logger";

export const maxDuration = 60;

const connectSchema = z.object({
  botToken: z.string().min(30, "Invalid bot token"),
  channelId: z.string().optional(),
  groupId: z.string().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  let body: z.infer<typeof connectSchema>;
  try {
    const rawBody = await request.json();
    body = connectSchema.parse(rawBody);
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

  const validation = await telegramAutomationService.validateBotToken(
    body.botToken,
  );
  if (!validation.valid || !validation.botInfo) {
    return NextResponse.json(
      { error: validation.error || "Invalid bot token" },
      { status: 400 },
    );
  }

  try {
    await telegramAutomationService.storeCredentials(
      user.organization_id,
      user.id,
      {
        botToken: body.botToken,
        botUsername: validation.botInfo.botUsername,
        botId: validation.botInfo.botId,
      },
    );
  } catch (error) {
    logger.error("[Telegram Connect] Failed to store credentials", {
      organizationId: user.organization_id,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Failed to store credentials" },
      { status: 500 },
    );
  }

  const webhookResult = await telegramAutomationService.setWebhook(
    user.organization_id,
  );
  if (!webhookResult.success) {
    logger.warn("[Telegram Connect] Webhook setup failed", {
      organizationId: user.organization_id,
      error: webhookResult.error,
    });
  }

  logger.info("[Telegram Connect] Bot connected successfully", {
    organizationId: user.organization_id,
    botUsername: validation.botInfo.botUsername,
    webhookSet: webhookResult.success,
  });

  return NextResponse.json({
    success: true,
    botUsername: validation.botInfo.botUsername,
    botId: validation.botInfo.botId,
    firstName: validation.botInfo.firstName,
    webhookSet: webhookResult.success,
    canJoinGroups: validation.botInfo.canJoinGroups,
    canReadAllGroupMessages: validation.botInfo.canReadAllGroupMessages,
  });
}

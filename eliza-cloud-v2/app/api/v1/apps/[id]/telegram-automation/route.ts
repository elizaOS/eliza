/**
 * App Telegram Automation API
 *
 * GET - Get automation status for an app
 * POST - Enable/update automation for an app
 * DELETE - Disable automation for an app
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { telegramAppAutomationService } from "@/lib/services/telegram-automation";
import { logger } from "@/lib/utils/logger";

export const maxDuration = 30;

interface RouteParams {
  params: Promise<{ id: string }>;
}

const automationConfigSchema = z.object({
  enabled: z.boolean().optional(),
  channelId: z.string().optional(),
  groupId: z.string().optional(),
  autoReply: z.boolean().optional(),
  autoAnnounce: z.boolean().optional(),
  announceIntervalMin: z.number().min(30).max(1440).optional(),
  announceIntervalMax: z.number().min(30).max(1440).optional(),
  welcomeMessage: z.string().max(500).optional(),
  vibeStyle: z.string().max(100).optional(),
  agentCharacterId: z.string().uuid().optional(), // Character voice for posts
});

export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id: appId } = await params;

  try {
    const status = await telegramAppAutomationService.getAutomationStatus(
      user.organization_id,
      appId,
    );
    return NextResponse.json(status);
  } catch (error) {
    if (error instanceof Error && error.message === "App not found") {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }
    logger.error("[Telegram Automation] Failed to get status", {
      appId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Failed to get automation status" },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id: appId } = await params;

  let body: z.infer<typeof automationConfigSchema>;
  try {
    const rawBody = await request.json();
    body = automationConfigSchema.parse(rawBody);
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

  // Validate interval range - defaults are min=120, max=240
  const DEFAULT_INTERVAL_MIN = 120;
  const DEFAULT_INTERVAL_MAX = 240;

  if (body.announceIntervalMin && body.announceIntervalMax) {
    if (body.announceIntervalMin > body.announceIntervalMax) {
      return NextResponse.json(
        { error: "announceIntervalMin must be less than announceIntervalMax" },
        { status: 400 },
      );
    }
  } else if (body.announceIntervalMax && !body.announceIntervalMin) {
    if (body.announceIntervalMax < DEFAULT_INTERVAL_MIN) {
      return NextResponse.json(
        {
          error: `announceIntervalMax must be >= ${DEFAULT_INTERVAL_MIN} (default min)`,
        },
        { status: 400 },
      );
    }
  } else if (body.announceIntervalMin && !body.announceIntervalMax) {
    if (body.announceIntervalMin > DEFAULT_INTERVAL_MAX) {
      return NextResponse.json(
        {
          error: `announceIntervalMin must be <= ${DEFAULT_INTERVAL_MAX} (default max)`,
        },
        { status: 400 },
      );
    }
  }

  try {
    const app = await telegramAppAutomationService.enableAutomation(
      user.organization_id,
      appId,
      body,
    );

    logger.info("[Telegram Automation] Automation enabled", {
      appId,
      organizationId: user.organization_id,
    });

    return NextResponse.json({
      success: true,
      telegram_automation: app.telegram_automation,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "App not found") {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }
    if (
      error instanceof Error &&
      error.message.includes("Telegram bot not connected")
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logger.error("[Telegram Automation] Failed to enable", {
      appId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Failed to enable automation" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id: appId } = await params;

  try {
    await telegramAppAutomationService.disableAutomation(
      user.organization_id,
      appId,
    );

    logger.info("[Telegram Automation] Automation disabled", {
      appId,
      organizationId: user.organization_id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "App not found") {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }
    logger.error("[Telegram Automation] Failed to disable", {
      appId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Failed to disable automation" },
      { status: 500 },
    );
  }
}

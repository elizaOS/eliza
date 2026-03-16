/**
 * Telegram Disconnect API
 *
 * Removes bot credentials and webhook for the organization.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { telegramAutomationService } from "@/lib/services/telegram-automation";
import { logger } from "@/lib/utils/logger";

export const maxDuration = 30;

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  try {
    await telegramAutomationService.removeCredentials(
      user.organization_id,
      user.id,
    );

    logger.info("[Telegram Disconnect] Bot disconnected successfully", {
      organizationId: user.organization_id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("[Telegram Disconnect] Failed to disconnect", {
      organizationId: user.organization_id,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Failed to disconnect" },
      { status: 500 },
    );
  }
}

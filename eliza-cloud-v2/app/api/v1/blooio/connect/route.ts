/**
 * Blooio Connect Route
 *
 * Stores Blooio API credentials for an organization.
 * Unlike OAuth providers, Blooio uses API key authentication.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { blooioAutomationService } from "@/lib/services/blooio-automation";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  try {
    const body = await request.json();
    // Frontend sends `phoneNumber`, map to internal `fromNumber`
    const { apiKey, webhookSecret, phoneNumber } = body;
    const fromNumber = phoneNumber;

    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 400 },
      );
    }

    // Validate the API key
    const validation = await blooioAutomationService.validateApiKey(apiKey);

    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error || "Invalid API key" },
        { status: 400 },
      );
    }

    // Store credentials
    await blooioAutomationService.storeCredentials(
      user.organization_id,
      user.id,
      {
        apiKey,
        webhookSecret,
        fromNumber,
      },
    );

    // Get the webhook URL to display to user
    const webhookUrl = blooioAutomationService.getWebhookUrl(
      user.organization_id,
    );

    logger.info("[Blooio Connect] Credentials stored", {
      organizationId: user.organization_id,
      userId: user.id,
      hasFromNumber: !!fromNumber,
    });

    return NextResponse.json({
      success: true,
      message: "Blooio connected successfully",
      webhookUrl,
      instructions:
        "Configure this webhook URL in your Blooio dashboard to receive inbound messages.",
    });
  } catch (error) {
    logger.error("[Blooio Connect] Failed to connect", {
      error: error instanceof Error ? error.message : String(error),
      organizationId: user.organization_id,
    });
    return NextResponse.json(
      { error: "Failed to connect Blooio" },
      { status: 500 },
    );
  }
}

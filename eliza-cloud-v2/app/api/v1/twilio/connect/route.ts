/**
 * Twilio Connect Route
 *
 * Stores Twilio credentials for an organization.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { logger } from "@/lib/utils/logger";
import { isE164PhoneNumber } from "@/lib/utils/twilio-api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  try {
    const body = await request.json();
    const { accountSid, authToken, phoneNumber } = body;

    if (!accountSid || !authToken || !phoneNumber) {
      return NextResponse.json(
        { error: "Account SID, Auth Token, and Phone Number are required" },
        { status: 400 },
      );
    }

    // Validate phone number format
    if (!isE164PhoneNumber(phoneNumber)) {
      return NextResponse.json(
        { error: "Phone number must be in E.164 format (e.g., +15551234567)" },
        { status: 400 },
      );
    }

    // Validate the credentials
    const validation = await twilioAutomationService.validateCredentials(
      accountSid,
      authToken,
    );

    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error || "Invalid Twilio credentials" },
        { status: 400 },
      );
    }

    // Store credentials
    await twilioAutomationService.storeCredentials(
      user.organization_id,
      user.id,
      {
        accountSid,
        authToken,
        phoneNumber,
      },
    );

    // Get the webhook URL to display to user
    const webhookUrl = twilioAutomationService.getWebhookUrl(
      user.organization_id,
    );

    logger.info("[Twilio Connect] Credentials stored", {
      organizationId: user.organization_id,
      userId: user.id,
      phoneNumber,
      accountName: validation.accountName,
    });

    return NextResponse.json({
      success: true,
      message: "Twilio connected successfully",
      accountName: validation.accountName,
      phoneNumber,
      webhookUrl,
      instructions:
        "Configure this webhook URL in your Twilio phone number settings to receive inbound SMS.",
    });
  } catch (error) {
    logger.error("[Twilio Connect] Failed to connect", {
      error: error instanceof Error ? error.message : String(error),
      organizationId: user.organization_id,
    });
    return NextResponse.json(
      { error: "Failed to connect Twilio" },
      { status: 500 },
    );
  }
}

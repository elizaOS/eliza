/**
 * Twilio Status Route
 *
 * Returns the current Twilio connection status for the organization.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  try {
    const [status, accountSid] = await Promise.all([
      twilioAutomationService.getConnectionStatus(user.organization_id),
      twilioAutomationService.getAccountSid(user.organization_id),
    ]);

    // Include webhook URL for reference
    const webhookUrl = twilioAutomationService.getWebhookUrl(
      user.organization_id,
    );

    // Map properties for frontend compatibility:
    // - `configured` -> `webhookConfigured`
    // - Include `accountSid` for UI display
    const { configured, ...restStatus } = status;
    return NextResponse.json({
      ...restStatus,
      webhookConfigured: configured,
      webhookUrl,
      accountSid: accountSid || undefined,
    });
  } catch (error) {
    logger.error("[Twilio Status] Failed to get status", {
      error: error instanceof Error ? error.message : String(error),
      organizationId: user.organization_id,
    });
    return NextResponse.json(
      { error: "Failed to get Twilio status" },
      { status: 500 },
    );
  }
}

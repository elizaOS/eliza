/**
 * Blooio Status Route
 *
 * Returns the current Blooio connection status for the organization.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { blooioAutomationService } from "@/lib/services/blooio-automation";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const orgId = user.organization_id;

  try {
    // Fetch status and webhook secret in parallel
    const [status, webhookSecret] = await Promise.all([
      blooioAutomationService.getConnectionStatus(orgId),
      blooioAutomationService.getWebhookSecret(orgId),
    ]);

    const { fromNumber, configured, ...restStatus } = status;
    return NextResponse.json({
      ...restStatus,
      phoneNumber: fromNumber,
      webhookConfigured: configured,
      webhookUrl: blooioAutomationService.getWebhookUrl(orgId),
      hasWebhookSecret: Boolean(webhookSecret),
    });
  } catch (error) {
    logger.error("[Blooio Status] Failed to get status", {
      error: error instanceof Error ? error.message : String(error),
      orgId,
    });
    return NextResponse.json(
      { error: "Failed to get Blooio status" },
      { status: 500 },
    );
  }
}

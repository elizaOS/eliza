/**
 * Blooio Webhook Secret Route
 *
 * Stores the webhook signing secret after initial connection.
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
  const orgId = user.organization_id;

  try {
    const { webhookSecret } = await request.json();

    if (!webhookSecret || typeof webhookSecret !== "string") {
      return NextResponse.json(
        { error: "Webhook secret is required" },
        { status: 400 },
      );
    }

    if (!webhookSecret.startsWith("whsec_")) {
      return NextResponse.json(
        { error: "Invalid format. Secret should start with 'whsec_'" },
        { status: 400 },
      );
    }

    // Fetch existing credentials in parallel
    const [apiKey, fromNumber] = await Promise.all([
      blooioAutomationService.getApiKey(orgId),
      blooioAutomationService.getFromNumber(orgId),
    ]);

    if (!apiKey) {
      return NextResponse.json(
        { error: "Please connect Blooio first" },
        { status: 400 },
      );
    }

    await blooioAutomationService.storeCredentials(orgId, user.id, {
      apiKey,
      webhookSecret,
      fromNumber: fromNumber || undefined,
    });

    logger.info("[Blooio] Webhook secret stored", { orgId });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("[Blooio] Failed to save webhook secret", {
      error: error instanceof Error ? error.message : String(error),
      orgId,
    });
    return NextResponse.json(
      { error: "Failed to save webhook secret" },
      { status: 500 },
    );
  }
}

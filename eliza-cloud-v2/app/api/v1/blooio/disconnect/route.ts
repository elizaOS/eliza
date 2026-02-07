/**
 * Blooio Disconnect Route
 *
 * Removes Blooio credentials for an organization.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { blooioAutomationService } from "@/lib/services/blooio-automation";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function handleDisconnect(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  try {
    await blooioAutomationService.removeCredentials(
      user.organization_id,
      user.id,
    );

    logger.info("[Blooio Disconnect] Credentials removed", {
      organizationId: user.organization_id,
      userId: user.id,
    });

    return NextResponse.json({
      success: true,
      message: "Blooio disconnected successfully",
    });
  } catch (error) {
    logger.error("[Blooio Disconnect] Failed to disconnect", {
      error: error instanceof Error ? error.message : String(error),
      organizationId: user.organization_id,
    });
    return NextResponse.json(
      { error: "Failed to disconnect Blooio" },
      { status: 500 },
    );
  }
}

// Support both POST and DELETE methods for disconnect
export const POST = handleDisconnect;
export const DELETE = handleDisconnect;

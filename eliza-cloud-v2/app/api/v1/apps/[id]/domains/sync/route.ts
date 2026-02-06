/**
 * Domain Sync API
 *
 * Syncs domain status from Vercel to the local database.
 * Use this to refresh verification status and SSL certificate info.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { vercelDomainsService } from "@/lib/services/vercel-domains";
import { logger } from "@/lib/utils/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/v1/apps/:id/domains/sync
 * Sync all domain statuses from Vercel
 */
export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const user = await requireAuthWithOrg();
  const { id: appId } = await params;

  const app = await appsService.getById(appId);
  if (!app || app.organization_id !== user.organization_id) {
    return NextResponse.json(
      { success: false, error: "App not found" },
      { status: 404 },
    );
  }

  logger.info("[Domains API] Syncing domain status", {
    appId,
    userId: user.id,
  });

  await vercelDomainsService.syncDomainStatus(appId);
  const domains = await vercelDomainsService.getDomainsForApp(appId);

  return NextResponse.json({
    success: true,
    domains,
    syncedAt: new Date().toISOString(),
  });
}

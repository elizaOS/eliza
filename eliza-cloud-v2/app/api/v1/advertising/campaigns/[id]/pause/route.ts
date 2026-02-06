import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { advertisingService } from "@/lib/services/advertising";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/v1/advertising/campaigns/[id]/pause
 * Pauses a campaign.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const campaign = await advertisingService.pauseCampaign(
    id,
    user.organization_id!,
  );

  logger.info("[Advertising API] Campaign paused", { campaignId: id });

  return NextResponse.json({
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    updatedAt: campaign.updated_at.toISOString(),
  });
}

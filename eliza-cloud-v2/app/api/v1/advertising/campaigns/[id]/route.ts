import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { advertisingService } from "@/lib/services/advertising";
import { UpdateCampaignSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/v1/advertising/campaigns/[id]
 * Gets a specific campaign with details.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const campaign = await advertisingService.getCampaign(id);

  if (!campaign || campaign.organization_id !== user.organization_id) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: campaign.id,
    adAccountId: campaign.ad_account_id,
    externalCampaignId: campaign.external_campaign_id,
    name: campaign.name,
    platform: campaign.platform,
    objective: campaign.objective,
    status: campaign.status,
    budgetType: campaign.budget_type,
    budgetAmount: campaign.budget_amount,
    budgetCurrency: campaign.budget_currency,
    creditsAllocated: campaign.credits_allocated,
    creditsSpent: campaign.credits_spent,
    startDate: campaign.start_date?.toISOString(),
    endDate: campaign.end_date?.toISOString(),
    targeting: campaign.targeting,
    totalSpend: campaign.total_spend,
    totalImpressions: campaign.total_impressions,
    totalClicks: campaign.total_clicks,
    totalConversions: campaign.total_conversions,
    appId: campaign.app_id,
    metadata: campaign.metadata,
    createdAt: campaign.created_at.toISOString(),
    updatedAt: campaign.updated_at.toISOString(),
  });
}

/**
 * PATCH /api/v1/advertising/campaigns/[id]
 * Updates a campaign.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const body = await request.json();
  const parsed = UpdateCampaignSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const campaign = await advertisingService.updateCampaign(
    id,
    user.organization_id!,
    {
      name: parsed.data.name,
      budgetAmount: parsed.data.budgetAmount,
      startDate: parsed.data.startDate
        ? new Date(parsed.data.startDate)
        : undefined,
      endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
      targeting: parsed.data.targeting,
    },
  );

  logger.info("[Advertising API] Campaign updated", { campaignId: id });

  return NextResponse.json({
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    updatedAt: campaign.updated_at.toISOString(),
  });
}

/**
 * DELETE /api/v1/advertising/campaigns/[id]
 * Deletes a campaign.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  await advertisingService.deleteCampaign(id, user.organization_id!);

  logger.info("[Advertising API] Campaign deleted", { campaignId: id });

  return NextResponse.json({ success: true });
}

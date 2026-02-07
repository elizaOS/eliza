import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  advertisingService,
  type AdPlatform,
} from "@/lib/services/advertising";
import { CreateCampaignSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/advertising/campaigns
 * Lists campaigns for the organization.
 */
export async function GET(request: NextRequest) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const searchParams = request.nextUrl.searchParams;
  const adAccountId = searchParams.get("adAccountId");
  const platform = searchParams.get("platform") as AdPlatform | null;
  const status = searchParams.get("status");
  const appId = searchParams.get("appId");

  const campaigns = await advertisingService.listCampaigns(
    user.organization_id!,
    {
      adAccountId: adAccountId || undefined,
      platform: platform || undefined,
      status: status || undefined,
      appId: appId || undefined,
    },
  );

  return NextResponse.json({
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      platform: c.platform,
      objective: c.objective,
      status: c.status,
      budgetType: c.budget_type,
      budgetAmount: c.budget_amount,
      budgetCurrency: c.budget_currency,
      creditsAllocated: c.credits_allocated,
      creditsSpent: c.credits_spent,
      startDate: c.start_date?.toISOString(),
      endDate: c.end_date?.toISOString(),
      totalSpend: c.total_spend,
      totalImpressions: c.total_impressions,
      totalClicks: c.total_clicks,
      appId: c.app_id,
      createdAt: c.created_at.toISOString(),
    })),
    count: campaigns.length,
  });
}

/**
 * POST /api/v1/advertising/campaigns
 * Creates a new campaign.
 */
export async function POST(request: NextRequest) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const body = await request.json();
  const parsed = CreateCampaignSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const campaign = await advertisingService.createCampaign({
    organizationId: user.organization_id!,
    adAccountId: parsed.data.adAccountId,
    name: parsed.data.name,
    objective: parsed.data.objective,
    budgetType: parsed.data.budgetType,
    budgetAmount: parsed.data.budgetAmount,
    budgetCurrency: parsed.data.budgetCurrency,
    startDate: parsed.data.startDate
      ? new Date(parsed.data.startDate)
      : undefined,
    endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
    targeting: parsed.data.targeting,
    appId: parsed.data.appId,
  });

  logger.info("[Advertising API] Campaign created", {
    campaignId: campaign.id,
    name: campaign.name,
  });

  return NextResponse.json(
    {
      id: campaign.id,
      name: campaign.name,
      platform: campaign.platform,
      objective: campaign.objective,
      status: campaign.status,
      budgetType: campaign.budget_type,
      budgetAmount: campaign.budget_amount,
      creditsAllocated: campaign.credits_allocated,
      createdAt: campaign.created_at.toISOString(),
    },
    { status: 201 },
  );
}

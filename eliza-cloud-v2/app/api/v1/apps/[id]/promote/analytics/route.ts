import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { advertisingService } from "@/lib/services/advertising";
import { conversionTrackingService } from "@/lib/services/conversion-tracking";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const app = await appsService.getById(id);
    if (!app || app.organization_id !== user.organization_id) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get("days") || "30");
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const campaigns = await advertisingService.listCampaigns(
      user.organization_id!,
      { appId: id },
    );

    const totals = campaigns.reduce(
      (acc, c) => ({
        spend: acc.spend + parseFloat(c.total_spend),
        impressions: acc.impressions + c.total_impressions,
        clicks: acc.clicks + c.total_clicks,
        conversions: acc.conversions + c.total_conversions,
      }),
      { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
    );

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const safeDiv = (a: number, b: number, mult = 1) =>
      b > 0 ? (a / b) * mult : 0;

    const attribution = await conversionTrackingService.getCampaignAttribution(
      user.organization_id!,
      { appId: id },
    );

    return NextResponse.json({
      summary: {
        totalCampaigns: campaigns.length,
        activeCampaigns: campaigns.filter((c) => c.status === "active").length,
        totalSpend: totals.spend,
        totalImpressions: totals.impressions,
        totalClicks: totals.clicks,
        totalConversions: totals.conversions,
        ctr: round2(safeDiv(totals.clicks, totals.impressions, 100)),
        cpc: round2(safeDiv(totals.spend, totals.clicks)),
        cpm: round2(safeDiv(totals.spend, totals.impressions, 1000)),
        conversionRate: round2(safeDiv(totals.conversions, totals.clicks, 100)),
      },
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        platform: c.platform,
        status: c.status,
        spend: parseFloat(c.total_spend),
        impressions: c.total_impressions,
        clicks: c.total_clicks,
        conversions: c.total_conversions,
      })),
      attribution: attribution.map((a) => ({
        campaignId: a.campaignId,
        campaignName: a.campaignName,
        platform: a.platform,
        signups: a.signups,
        conversions: a.conversions,
        cost: round2(a.cost),
      })),
      dateRange: {
        start: startDate.toISOString(),
        end: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    let status = 500;
    if (
      message.includes("Authentication") ||
      message.includes("Unauthorized")
    ) {
      status = 401;
    } else if (
      message.includes("Forbidden") ||
      message.includes("Access denied")
    ) {
      status = 403;
    }
    return NextResponse.json({ error: message }, { status });
  }
}

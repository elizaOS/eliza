// Handles v1 cloud API v1 apps id promote analytics route traffic with route-local auth expectations.
import { parsePositiveInteger } from "@elizaos/shared/utils/number-parsing";
import { Hono } from "hono";
import { nextJsonFromCaughtError } from "@/lib/api/errors";
import type { RouteContext } from "@/lib/api/hono-next-style-params";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { advertisingService } from "@/lib/services/advertising";
import { appsService } from "@/lib/services/apps";
import { conversionTrackingService } from "@/lib/services/conversion-tracking";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_ANALYTICS_DAYS = 90;

async function __hono_GET(
  request: Request,
  { params }: RouteContext<{ id: string }>,
) {
  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await params;

    const app = await appsService.getById(id);
    if (!app || app.organization_id !== user.organization_id) {
      return Response.json({ error: "App not found" }, { status: 404 });
    }
    if (await isAppKeyOutOfScope(apiKey?.id, id)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    const url = new URL(request.url);
    const rawDays = url.searchParams.get("days");
    let days = 30;
    if (rawDays !== null) {
      const parsed = parsePositiveInteger(rawDays);
      if (
        parsed === undefined ||
        rawDays !== String(parsed) ||
        parsed > MAX_ANALYTICS_DAYS
      ) {
        return Response.json({ error: "Invalid days" }, { status: 400 });
      }
      days = parsed;
    }
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

    return Response.json({
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
    return nextJsonFromCaughtError(error);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
export default __hono_app;

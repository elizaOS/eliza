/**
 * GET  /api/v1/advertising/campaigns — list campaigns.
 * POST /api/v1/advertising/campaigns — create a campaign.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { type AdPlatform, advertisingService } from "@/lib/services/advertising";
import { CreateCampaignSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const adAccountId = c.req.query("adAccountId");
    const platform = c.req.query("platform") as AdPlatform | undefined;
    const status = c.req.query("status");
    const appId = c.req.query("appId");

    const campaigns = await advertisingService.listCampaigns(user.organization_id, {
      adAccountId: adAccountId || undefined,
      platform: platform || undefined,
      status: status || undefined,
      appId: appId || undefined,
    });

    return c.json({
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
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json();
    const parsed = CreateCampaignSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    const campaign = await advertisingService.createCampaign({
      organizationId: user.organization_id,
      adAccountId: parsed.data.adAccountId,
      name: parsed.data.name,
      objective: parsed.data.objective,
      budgetType: parsed.data.budgetType,
      budgetAmount: parsed.data.budgetAmount,
      budgetCurrency: parsed.data.budgetCurrency,
      startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : undefined,
      endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
      targeting: parsed.data.targeting,
      appId: parsed.data.appId,
    });

    logger.info("[Advertising API] Campaign created", {
      campaignId: campaign.id,
      name: campaign.name,
    });

    return c.json(
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
      201,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

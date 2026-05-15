/**
 * GET    /api/v1/advertising/campaigns/[id] — get a campaign.
 * PATCH  /api/v1/advertising/campaigns/[id] — update a campaign.
 * DELETE /api/v1/advertising/campaigns/[id] — delete a campaign.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { UpdateCampaignSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    const campaign = await advertisingService.getCampaign(id);

    if (!campaign || campaign.organization_id !== user.organization_id) {
      return c.json({ error: "Campaign not found" }, 404);
    }

    return c.json({
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
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    const body = await c.req.json();
    const parsed = UpdateCampaignSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    const campaign = await advertisingService.updateCampaign(id, user.organization_id, {
      name: parsed.data.name,
      budgetAmount: parsed.data.budgetAmount,
      startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : undefined,
      endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
      targeting: parsed.data.targeting,
    });

    logger.info("[Advertising API] Campaign updated", { campaignId: id });

    return c.json({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      updatedAt: campaign.updated_at.toISOString(),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    await advertisingService.deleteCampaign(id, user.organization_id);

    logger.info("[Advertising API] Campaign deleted", { campaignId: id });

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

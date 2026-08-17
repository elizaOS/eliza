/**
 * GET  /api/v1/advertising/campaigns — list campaigns.
 * POST /api/v1/advertising/campaigns — create a campaign.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  type AdPlatform,
  advertisingService,
} from "@/lib/services/advertising";
import { CreateCampaignSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

type CampaignRecord = NonNullable<
  Awaited<ReturnType<typeof advertisingService.getCampaign>>
>;

function serializeTargeting(targeting: CampaignRecord["targeting"]) {
  return {
    locations: targeting.locations,
    ageMin: targeting.age_min,
    ageMax: targeting.age_max,
    genders: targeting.genders,
    interests: targeting.interests,
    behaviors: targeting.behaviors,
    customAudiences: targeting.custom_audiences,
    excludedAudiences: targeting.excluded_audiences,
    placements: targeting.placements,
    languages: targeting.languages,
  };
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    // Ad-campaign catalog identity, not leftover tax on promote-assets
    // platform (Twitter card sizes) or admin redemption status. The
    // prior `as AdPlatform` cast passed META / facebook / foo into
    // eq(adCampaigns.platform), so operators asking for Meta received
    // an empty catalog. Same for status=ACTIVE. Missing / empty still
    // means unfiltered. Garbage 400s before listCampaigns.
    const AD_PLATFORMS = [
      "meta",
      "google",
      "tiktok",
      "snap",
      "x-twitter",
      "reddit",
      "linkedin",
      "programmatic-dsp",
    ] as const;
    const CAMPAIGN_STATUSES = [
      "draft",
      "pending",
      "active",
      "paused",
      "completed",
      "failed",
      "archived",
    ] as const;
    const requestedPlatform = c.req.query("platform");
    if (
      requestedPlatform != null &&
      requestedPlatform !== "" &&
      !AD_PLATFORMS.includes(
        requestedPlatform as (typeof AD_PLATFORMS)[number],
      )
    ) {
      return c.json(
        {
          error: "invalid_platform",
          message:
            'platform must be "meta", "google", "tiktok", "snap", "x-twitter", "reddit", "linkedin", or "programmatic-dsp".',
        },
        400,
      );
    }
    const requestedStatus = c.req.query("status");
    if (
      requestedStatus != null &&
      requestedStatus !== "" &&
      !CAMPAIGN_STATUSES.includes(
        requestedStatus as (typeof CAMPAIGN_STATUSES)[number],
      )
    ) {
      return c.json(
        {
          error: "invalid_status",
          message:
            'status must be "draft", "pending", "active", "paused", "completed", "failed", or "archived".',
        },
        400,
      );
    }

    const adAccountId = c.req.query("adAccountId");
    const appId = c.req.query("appId");

    const campaigns = await advertisingService.listCampaigns(
      user.organization_id,
      {
        adAccountId: adAccountId || undefined,
        platform: (requestedPlatform || undefined) as AdPlatform | undefined,
        status: requestedStatus || undefined,
        appId: appId || undefined,
      },
    );

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
        spendCapCredits: c.spend_cap_credits,
        bidStrategy: c.metadata.bid_strategy,
        optimizationGoal: c.metadata.optimization_goal,
        creditsAllocated: c.credits_allocated,
        creditsSpent: c.credits_spent,
        startDate: c.start_date?.toISOString(),
        endDate: c.end_date?.toISOString(),
        dayparting: c.metadata.dayparting ?? null,
        targeting: serializeTargeting(c.targeting),
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
      return c.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        400,
      );
    }

    const campaign = await advertisingService.createCampaign({
      organizationId: user.organization_id,
      adAccountId: parsed.data.adAccountId,
      name: parsed.data.name,
      objective: parsed.data.objective,
      budgetType: parsed.data.budgetType,
      budgetAmount: parsed.data.budgetAmount,
      budgetCurrency: parsed.data.budgetCurrency,
      spendCapCredits: parsed.data.spendCapCredits,
      bidStrategy: parsed.data.bidStrategy,
      optimizationGoal: parsed.data.optimizationGoal,
      startDate: parsed.data.startDate
        ? new Date(parsed.data.startDate)
        : undefined,
      endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
      targeting: parsed.data.targeting,
      dayparting: parsed.data.dayparting,
      audienceSegmentId: parsed.data.audienceSegmentId,
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
        spendCapCredits: campaign.spend_cap_credits,
        bidStrategy: campaign.metadata.bid_strategy,
        optimizationGoal: campaign.metadata.optimization_goal,
        creditsAllocated: campaign.credits_allocated,
        dayparting: campaign.metadata.dayparting ?? null,
        targeting: serializeTargeting(campaign.targeting),
        createdAt: campaign.created_at.toISOString(),
      },
      201,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

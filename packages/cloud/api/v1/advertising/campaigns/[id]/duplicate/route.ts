/**
 * POST /api/v1/advertising/campaigns/[id]/duplicate — copy campaign config.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { DuplicateCampaignSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: "Campaign id is required" }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = DuplicateCampaignSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        400,
      );
    }

    const { campaign, creativesCopied } =
      await advertisingService.duplicateCampaign(
        id,
        user.organization_id,
        parsed.data,
      );

    logger.info("[Advertising API] Campaign duplicated", {
      sourceCampaignId: id,
      campaignId: campaign.id,
      creativesCopied,
    });

    return c.json(
      {
        success: true,
        campaign: {
          id: campaign.id,
          name: campaign.name,
          platform: campaign.platform,
          objective: campaign.objective,
          status: campaign.status,
          budgetType: campaign.budget_type,
          budgetAmount: campaign.budget_amount,
          budgetCurrency: campaign.budget_currency,
          creditsAllocated: campaign.credits_allocated,
          externalCampaignId: campaign.external_campaign_id,
          dayparting: campaign.metadata.dayparting ?? null,
          sourceCampaignId: campaign.metadata.source_campaign_id ?? null,
          createdAt: campaign.created_at.toISOString(),
        },
        creativesCopied,
      },
      201,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

/**
 * POST /api/v1/advertising/audience-segments/[id]/apply — apply a segment to a campaign.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { ApplyAudienceSegmentSchema } from "@/lib/services/advertising/schemas";
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

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const body = await c.req.json();
    const parsed = ApplyAudienceSegmentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        400,
      );
    }

    const campaign = await advertisingService.applyAudienceSegmentToCampaign(
      id,
      parsed.data.campaignId,
      user.organization_id,
    );

    logger.info("[Advertising API] Audience segment applied", {
      segmentId: id,
      campaignId: campaign.id,
    });

    return c.json({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      targeting: serializeTargeting(campaign.targeting),
      updatedAt: campaign.updated_at.toISOString(),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

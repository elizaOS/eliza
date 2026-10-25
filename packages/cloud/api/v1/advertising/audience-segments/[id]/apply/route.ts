/**
 * POST /api/v1/advertising/audience-segments/[id]/apply — apply a segment to a campaign.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  advertisingService,
  serializeCampaignTargeting,
} from "@elizaos/cloud-shared/lib/services/advertising";
import { ApplyAudienceSegmentSchema } from "@elizaos/cloud-shared/lib/services/advertising/schemas";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

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
      targeting: serializeCampaignTargeting(campaign.targeting),
      updatedAt: campaign.updated_at.toISOString(),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

/**
 * GET /api/v1/advertising/campaigns/[id]/dayparting — read schedule.
 * PUT /api/v1/advertising/campaigns/[id]/dayparting — replace/clear schedule.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { DaypartingScheduleSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: "Campaign id is required" }, 400);
    }
    const dayparting = await advertisingService.getCampaignDayparting(
      id,
      user.organization_id,
    );
    return c.json({ success: true, campaignId: id, dayparting });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.put("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: "Campaign id is required" }, 400);
    }
    const body = (await c.req.json()) as { dayparting?: unknown };

    const parsed =
      body.dayparting === null
        ? { success: true as const, data: null }
        : DaypartingScheduleSchema.safeParse(body.dayparting);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        400,
      );
    }

    const campaign = await advertisingService.updateCampaignDayparting(
      id,
      user.organization_id,
      parsed.data,
    );

    logger.info("[Advertising API] Campaign dayparting updated", {
      campaignId: id,
    });

    return c.json({
      success: true,
      campaignId: campaign.id,
      status: campaign.status,
      dayparting: campaign.metadata.dayparting ?? null,
      updatedAt: campaign.updated_at.toISOString(),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

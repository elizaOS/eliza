/**
 * GET    /api/v1/advertising/creatives/[id] — get a creative.
 * PATCH  /api/v1/advertising/creatives/[id] — update a creative.
 * DELETE /api/v1/advertising/creatives/[id] — delete a creative.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { UpdateCreativeSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const creative = await advertisingService.getCreative(id, user.organization_id);

    return c.json({
      id: creative.id,
      campaignId: creative.campaign_id,
      externalCreativeId: creative.external_creative_id,
      name: creative.name,
      type: creative.type,
      status: creative.status,
      headline: creative.headline,
      primaryText: creative.primary_text,
      description: creative.description,
      callToAction: creative.call_to_action,
      destinationUrl: creative.destination_url,
      media: creative.media,
      metadata: creative.metadata,
      createdAt: creative.created_at.toISOString(),
      updatedAt: creative.updated_at.toISOString(),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const parsed = UpdateCreativeSchema.safeParse(await c.req.json());

    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    const creative = await advertisingService.updateCreative(id, user.organization_id, {
      name: parsed.data.name,
      headline: parsed.data.headline,
      primaryText: parsed.data.primaryText,
      description: parsed.data.description,
      callToAction: parsed.data.callToAction,
      destinationUrl: parsed.data.destinationUrl,
      media: parsed.data.media,
    });

    logger.info("[Advertising API] Creative updated", { creativeId: id });

    return c.json({
      id: creative.id,
      name: creative.name,
      status: creative.status,
      updatedAt: creative.updated_at.toISOString(),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    await advertisingService.deleteCreative(id, user.organization_id);

    logger.info("[Advertising API] Creative deleted", { creativeId: id });

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

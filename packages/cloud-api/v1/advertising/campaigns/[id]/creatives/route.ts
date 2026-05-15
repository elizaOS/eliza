/**
 * GET  /api/v1/advertising/campaigns/[id]/creatives — list creatives.
 * POST /api/v1/advertising/campaigns/[id]/creatives — create a creative.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { CreateCreativeSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    const creatives = await advertisingService.listCreatives(id, user.organization_id);

    return c.json({
      creatives: creatives.map((cv) => ({
        id: cv.id,
        name: cv.name,
        type: cv.type,
        status: cv.status,
        headline: cv.headline,
        primaryText: cv.primary_text,
        description: cv.description,
        callToAction: cv.call_to_action,
        destinationUrl: cv.destination_url,
        media: cv.media,
        createdAt: cv.created_at.toISOString(),
      })),
      count: creatives.length,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    const body = await c.req.json();
    const parsed = CreateCreativeSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    const creative = await advertisingService.createCreative(user.organization_id, {
      campaignId: id,
      name: parsed.data.name,
      type: parsed.data.type,
      headline: parsed.data.headline,
      primaryText: parsed.data.primaryText,
      description: parsed.data.description,
      callToAction: parsed.data.callToAction,
      destinationUrl: parsed.data.destinationUrl,
      media: parsed.data.media,
      pageId: parsed.data.pageId,
      instagramActorId: parsed.data.instagramActorId,
      tiktokIdentityId: parsed.data.tiktokIdentityId,
      tiktokIdentityType: parsed.data.tiktokIdentityType,
    });

    logger.info("[Advertising API] Creative created", {
      creativeId: creative.id,
      campaignId: id,
    });

    return c.json(
      {
        id: creative.id,
        name: creative.name,
        type: creative.type,
        status: creative.status,
        createdAt: creative.created_at.toISOString(),
      },
      201,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

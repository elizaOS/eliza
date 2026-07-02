/**
 * GET    /api/v1/advertising/audience-segments/[id] — get a saved segment.
 * PATCH  /api/v1/advertising/audience-segments/[id] — update a saved segment.
 * DELETE /api/v1/advertising/audience-segments/[id] — delete a saved segment.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { UpdateAudienceSegmentSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const segment = await advertisingService.getAudienceSegment(
      id,
      user.organization_id,
    );
    if (!segment) {
      return c.json({ error: "Audience segment not found" }, 404);
    }
    return c.json({ segment });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const body = await c.req.json();
    const parsed = UpdateAudienceSegmentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        400,
      );
    }

    const segment = await advertisingService.updateAudienceSegment(
      id,
      user.organization_id,
      {
        name: parsed.data.name,
        description: parsed.data.description,
        targeting: parsed.data.targeting,
      },
    );
    logger.info("[Advertising API] Audience segment updated", {
      segmentId: id,
    });
    return c.json({ segment });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    await advertisingService.deleteAudienceSegment(id, user.organization_id);
    logger.info("[Advertising API] Audience segment deleted", {
      segmentId: id,
    });
    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

/**
 * GET  /api/v1/advertising/audience-segments — list saved segments.
 * POST /api/v1/advertising/audience-segments — create a saved segment.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { CreateAudienceSegmentSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const segments = await advertisingService.listAudienceSegments(
      user.organization_id,
    );
    return c.json({ segments, count: segments.length });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json();
    const parsed = CreateAudienceSegmentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        400,
      );
    }

    const segment = await advertisingService.createAudienceSegment({
      organizationId: user.organization_id,
      userId: user.id,
      name: parsed.data.name,
      description: parsed.data.description,
      targeting: parsed.data.targeting,
    });

    logger.info("[Advertising API] Audience segment created", {
      segmentId: segment.id,
    });
    return c.json({ segment }, 201);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

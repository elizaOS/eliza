/**
 * PR / press release workflow (#11819).
 *
 * GET  /api/v1/marketing/pr - list org press releases
 * POST /api/v1/marketing/pr - create a draft press release
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { pressReleaseService } from "@/lib/services/press-releases";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  authenticatedOrg,
  invalidRequest,
  PressReleaseDraftSchema,
  parseOptionalDate,
} from "./common";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const auth = await authenticatedOrg(c);
    const releases = await pressReleaseService.listReleases(
      auth.organizationId,
    );
    return c.json({ success: true, releases });
  } catch (error) {
    logger.error("[Press Release API] list failed:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const auth = await authenticatedOrg(c);
    const parsed = PressReleaseDraftSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());

    const result = await pressReleaseService.createRelease({
      organizationId: auth.organizationId,
      userId: auth.userId,
      title: parsed.data.title,
      body: parsed.data.body,
      summary: parsed.data.summary,
      boilerplate: parsed.data.boilerplate,
      targetAudience: parsed.data.targetAudience,
      targetRegions: parsed.data.targetRegions,
      assets: parsed.data.assets,
      embargoAt: parseOptionalDate(parsed.data.embargoAt),
      idempotencyKey: parsed.data.idempotencyKey,
      metadata: parsed.data.metadata,
    });
    if (!result.ok) {
      return c.json({ success: false, error: result.error }, 400);
    }
    return c.json({ success: true, release: result.release }, 201);
  } catch (error) {
    logger.error("[Press Release API] create failed:", error);
    return failureResponse(c, error);
  }
});

export default app;

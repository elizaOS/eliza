/**
 * PR / press release detail (#11819).
 *
 * GET   /api/v1/marketing/pr/:releaseId - fetch one release
 * PATCH /api/v1/marketing/pr/:releaseId - update a draft
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { pressReleaseService } from "@/lib/services/press-releases";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  invalidRequest,
  loadPressReleaseForOrg,
  PressReleaseUpdateSchema,
  parseOptionalDate,
} from "../common";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const { release, error } = await loadPressReleaseForOrg(c);
    if (error) return error;
    return c.json({ success: true, release });
  } catch (error) {
    logger.error("[Press Release API] get failed:", error);
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const { auth, releaseId, error } = await loadPressReleaseForOrg(c);
    if (error) return error;
    const parsed = PressReleaseUpdateSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());

    const result = await pressReleaseService.updateDraft(
      releaseId,
      auth.organizationId,
      {
        title: parsed.data.title,
        body: parsed.data.body,
        summary: parsed.data.summary,
        boilerplate: parsed.data.boilerplate,
        targetAudience: parsed.data.targetAudience,
        targetRegions: parsed.data.targetRegions,
        assets: parsed.data.assets,
        embargoAt: parseOptionalDate(parsed.data.embargoAt),
        metadata: parsed.data.metadata,
      },
    );
    if (!result.ok) {
      return c.json({ success: false, error: result.error }, 409);
    }
    return c.json({ success: true, release: result.release });
  } catch (error) {
    logger.error("[Press Release API] update failed:", error);
    return failureResponse(c, error);
  }
});

export default app;

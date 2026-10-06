/**
 * Marketing PR coverage (#11819).
 *
 * GET /api/v1/marketing/pr/:releaseId/coverage — list coverage artifacts for
 * one press release.
 */

import { Hono } from "hono";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { pressReleaseService } from "@elizaos/cloud-shared/lib/services/press-releases";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const releaseId = c.req.param("releaseId");
    if (!releaseId) {
      return c.json({ success: false, error: "Press release id is required" }, 400);
    }
    const release = await pressReleaseService.getRelease(
      releaseId,
      user.organization_id,
    );
    if (!release) {
      return c.json({ success: false, error: "Press release not found" }, 404);
    }
    const coverage = await pressReleaseService.listCoverage(
      release.id,
      user.organization_id,
    );
    return c.json({ success: true, releaseId: release.id, coverage });
  } catch (error) {
    logger.error("[Press Release API] list coverage failed:", error);
    return failureResponse(c, error);
  }
});

export default app;

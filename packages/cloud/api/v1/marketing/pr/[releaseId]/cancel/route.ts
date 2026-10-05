/**
 * Marketing PR cancel (#11819).
 *
 * POST /api/v1/marketing/pr/:releaseId/cancel — cancel a draft/ready release.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { pressReleaseService } from "@elizaos/cloud-shared/lib/services/press-releases";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { statusForPressReleaseError } from "../../common";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const releaseId = c.req.param("releaseId");
    if (!releaseId) {
      return c.json(
        { success: false, error: "Press release id is required" },
        400,
      );
    }
    const result = await pressReleaseService.cancelRelease(
      releaseId,
      user.organization_id,
    );
    if (!result.ok || !result.release) {
      return c.json(
        {
          success: false,
          error: result.error ?? "Press release could not be cancelled",
        },
        statusForPressReleaseError(result.error),
      );
    }
    return c.json({ success: true, release: result.release });
  } catch (error) {
    logger.error("[Press Release API] cancel failed:", error);
    return failureResponse(c, error);
  }
});

export default app;

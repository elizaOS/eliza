/** POST /api/v1/marketing/pr/:releaseId/ready - mark a draft ready for distribution (#11819). */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { pressReleaseService } from "@/lib/services/press-releases";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { loadPressReleaseForOrg } from "../../common";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const { auth, releaseId, error } = await loadPressReleaseForOrg(c);
    if (error) return error;
    const result = await pressReleaseService.markReady(
      releaseId,
      auth.organizationId,
    );
    if (!result.ok) {
      return c.json({ success: false, error: result.error }, 409);
    }
    return c.json({ success: true, release: result.release });
  } catch (error) {
    logger.error("[Press Release API] mark ready failed:", error);
    return failureResponse(c, error);
  }
});

export default app;

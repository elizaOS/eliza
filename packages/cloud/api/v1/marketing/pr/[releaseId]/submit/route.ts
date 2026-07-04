/**
 * Marketing PR submit guard (#11819).
 *
 * POST /api/v1/marketing/pr/:releaseId/submit — fail closed until a real
 * press distribution provider exists.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { pressReleaseService } from "@/lib/services/press-releases";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { providerNotConfiguredResponse } from "../../common";

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
    const release = await pressReleaseService.getRelease(
      releaseId,
      user.organization_id,
    );
    if (!release) {
      return c.json({ success: false, error: "Press release not found" }, 404);
    }
    if (release.status === "cancelled") {
      return c.json(
        {
          success: false,
          error: "Cancelled press releases cannot be submitted",
        },
        400,
      );
    }

    logger.warn("[Press Release API] submit blocked: provider not configured", {
      releaseId: release.id,
      organizationId: user.organization_id,
    });
    return c.json(providerNotConfiguredResponse, 503);
  } catch (error) {
    logger.error("[Press Release API] submit failed:", error);
    return failureResponse(c, error);
  }
});

export default app;

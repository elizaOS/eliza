/**
 * Marketing PR / press release detail (#11819).
 *
 * GET   /api/v1/marketing/pr/:releaseId — read one press release
 * PATCH /api/v1/marketing/pr/:releaseId — update a draft press release
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { pressReleaseService } from "@/lib/services/press-releases";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  dateFromPayload,
  invalidRequestBody,
  statusForPressReleaseError,
  UpdatePressReleaseSchema,
} from "../common";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
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
    return c.json({ success: true, release });
  } catch (error) {
    logger.error("[Press Release API] get failed:", error);
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const releaseId = c.req.param("releaseId");
    if (!releaseId) {
      return c.json(
        { success: false, error: "Press release id is required" },
        400,
      );
    }
    const parsed = UpdatePressReleaseSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error.flatten()), 400);
    }

    const result = await pressReleaseService.updateDraft(
      releaseId,
      user.organization_id,
      {
        title: parsed.data.title,
        body: parsed.data.body,
        summary: parsed.data.summary,
        boilerplate: parsed.data.boilerplate,
        targetAudience: parsed.data.targetAudience,
        targetRegions: parsed.data.targetRegions,
        assets: parsed.data.assets,
        embargoAt: dateFromPayload(parsed.data.embargoAt),
        metadata: parsed.data.metadata,
      },
    );
    if (!result.ok || !result.release) {
      return c.json(
        {
          success: false,
          error: result.error ?? "Press release could not be updated",
        },
        statusForPressReleaseError(result.error),
      );
    }

    return c.json({ success: true, release: result.release });
  } catch (error) {
    logger.error("[Press Release API] update failed:", error);
    return failureResponse(c, error);
  }
});

export default app;

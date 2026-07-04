/**
 * Marketing PR / press releases (#11819).
 *
 * GET  /api/v1/marketing/pr — list the org's press releases
 * POST /api/v1/marketing/pr — create a draft press release
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { pressReleaseService } from "@/lib/services/press-releases";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  CreatePressReleaseSchema,
  dateFromPayload,
  invalidRequestBody,
  statusForPressReleaseError,
} from "./common";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const releases = await pressReleaseService.listReleases(
      user.organization_id,
    );
    return c.json({ success: true, releases });
  } catch (error) {
    logger.error("[Press Release API] list failed:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = CreatePressReleaseSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error.flatten()), 400);
    }

    const result = await pressReleaseService.createRelease({
      organizationId: user.organization_id,
      userId: user.id,
      title: parsed.data.title,
      body: parsed.data.body,
      summary: parsed.data.summary,
      boilerplate: parsed.data.boilerplate,
      targetAudience: parsed.data.targetAudience,
      targetRegions: parsed.data.targetRegions,
      assets: parsed.data.assets,
      embargoAt: dateFromPayload(parsed.data.embargoAt),
      idempotencyKey: parsed.data.idempotencyKey,
      metadata: parsed.data.metadata,
    });
    if (!result.ok || !result.release) {
      return c.json(
        {
          success: false,
          error: result.error ?? "Press release could not be created",
        },
        statusForPressReleaseError(result.error),
      );
    }

    logger.info("[Press Release API] created draft", {
      releaseId: result.release.id,
      organizationId: user.organization_id,
    });
    return c.json({ success: true, release: result.release }, 201);
  } catch (error) {
    logger.error("[Press Release API] create failed:", error);
    return failureResponse(c, error);
  }
});

export default app;

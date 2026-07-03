/**
 * App compliance review (#10732).
 *
 * POST /api/v1/apps/[id]/review   — submit the app for automated review. Runs
 *   the binary allow/ban classifier synchronously and returns the disposition.
 * GET  /api/v1/apps/[id]/review   — current review status + latest decision.
 *
 * The review outcome gates monetization and paid charges (see
 * `isAppMonetizationApproved`). Owners can edit + resubmit after a rejection.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getLatestAppReview, runAppReview } from "@/lib/services/app-review";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

// CRITICAL: submission runs a synchronous LLM classification — without a
// limiter an org member could spam it to burn model spend (same preset as
// the redemptions POST).
app.post("/", rateLimit(RateLimitPresets.CRITICAL), async (c) => {
  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(c.req.raw);
    const appId = c.req.param("id");
    if (!appId) return c.json({ success: false, error: "Missing app id" }, 400);

    const appRow = await appsService.getById(appId);
    if (!appRow) return c.json({ success: false, error: "App not found" }, 404);
    if (appRow.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    // An app-scoped API key may only act on its own app, never a sibling (#10852).
    if (await isAppKeyOutOfScope(apiKey?.id, appId)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const review = await runAppReview({
      app: appRow,
      triggeredByUserId: user.id,
    });

    logger.info("[AppReview API] Submitted app for review", {
      appId,
      userId: user.id,
      disposition: review.disposition,
    });

    return c.json({
      success: true,
      review: {
        disposition: review.disposition,
        review_status: review.disposition === "allow" ? "approved" : "rejected",
        matched_categories: review.matched_categories,
        rationale: review.rationale,
        rubric_version: review.rubric_version,
        model: review.model,
        created_at: review.created_at,
      },
    });
  } catch (error) {
    logger.error("[AppReview API] Review submission failed", { error });
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(c.req.raw);
    const appId = c.req.param("id");
    if (!appId) return c.json({ success: false, error: "Missing app id" }, 400);

    const appRow = await appsService.getById(appId);
    if (!appRow) return c.json({ success: false, error: "App not found" }, 404);
    if (appRow.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    // An app-scoped API key may only act on its own app, never a sibling (#10852).
    if (await isAppKeyOutOfScope(apiKey?.id, appId)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const latest = await getLatestAppReview(appId);

    return c.json({
      success: true,
      review_status: appRow.review_status,
      reviewed_at: appRow.reviewed_at,
      latest: latest
        ? {
            disposition: latest.disposition,
            matched_categories: latest.matched_categories,
            rationale: latest.rationale,
            rubric_version: latest.rubric_version,
            pre_filter_matched: latest.pre_filter_matched,
            model: latest.model,
            created_at: latest.created_at,
          }
        : null,
    });
  } catch (error) {
    logger.error("[AppReview API] Failed to read review status", { error });
    return failureResponse(c, error);
  }
});

export default app;

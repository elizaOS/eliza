/**
 * POST /api/signup-code/redeem
 * Redeem a signup code for the current user's organization (one-time bonus credits).
 * Auth: session only (no API key) — see proxy session-only path list.
 */

import { requireUserWithOrg } from "@elizaos/cloud-shared/auth";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  ERRORS,
  redeemSignupCode,
} from "@elizaos/cloud-shared/lib/services/signup-code";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
} as const;

const bodySchema = z.object({ code: z.string().min(1).trim() });

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.CRITICAL));

app.post("/", async (c) => {
  try {
    let user: Awaited<ReturnType<typeof requireUserWithOrg>>;
    try {
      user = await requireUserWithOrg(c);
    } catch (error) {
      // requireUserWithOrg rejects with typed ApiErrors: 401 only when no
      // caller is authenticated, 403 for an inactive user, an inactive
      // organization, or an account without an organization. Keep that
      // status instead of reporting every rejection as 401, like the other
      // requireUserWithOrg routes do through failureResponse. Anything that
      // is not an ApiError (for example a database failure during auth) is
      // not an auth rejection: rethrow it so the outer handler answers 500.
      if (error instanceof ApiError) {
        return c.json({ error: error.message }, error.status, NO_CACHE_HEADERS);
      }
      throw error;
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: "Invalid JSON in request body" },
        400,
        NO_CACHE_HEADERS,
      );
    }

    const result = bodySchema.safeParse(body);
    if (!result.success) {
      return c.json(
        { error: "code is required in request body" },
        400,
        NO_CACHE_HEADERS,
      );
    }

    const bonus = await redeemSignupCode(
      user.organization_id,
      result.data.code,
    );
    return c.json(
      {
        success: true,
        bonus,
        message: `Added $${Number(bonus).toFixed(2)} in bonus credits`,
      },
      200,
      NO_CACHE_HEADERS,
    );
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === ERRORS.INVALID_CODE) {
        return c.json({ error: ERRORS.INVALID_CODE }, 400, NO_CACHE_HEADERS);
      }
      if (error.message === ERRORS.ALREADY_USED) {
        return c.json({ error: ERRORS.ALREADY_USED }, 409, NO_CACHE_HEADERS);
      }
    }
    logger.error("[SignupCode Redeem] Error", { error });
    return c.json({ error: "Failed to redeem code" }, 500, NO_CACHE_HEADERS);
  }
});

export default app;

/**
 * POST /api/signup-code/redeem
 * Redeem a signup code for the current user's organization (one-time bonus credits).
 * Auth: session only (no API key) — see proxy session-only path list.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { ERRORS, redeemSignupCode } from "@/lib/services/signup-code";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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
    let user;
    try {
      user = await requireUserWithOrg(c);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 401, NO_CACHE_HEADERS);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400, NO_CACHE_HEADERS);
    }

    const result = bodySchema.safeParse(body);
    if (!result.success) {
      return c.json({ error: "code is required in request body" }, 400, NO_CACHE_HEADERS);
    }

    const bonus = await redeemSignupCode(user.organization_id, result.data.code);
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

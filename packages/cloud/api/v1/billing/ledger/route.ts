/**
 * GET /api/v1/billing/ledger
 * Recent billing and credit ledger entries for the authenticated organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { activeBillingService } from "@/lib/services/active-billing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

function parsePaginationParam(
  rawValue: string | undefined,
  parameter: "limit" | "offset",
  defaultValue: number,
): number | string {
  const value = rawValue?.trim();
  if (!value) return defaultValue;

  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return `Invalid ${parameter} ${JSON.stringify(
      rawValue,
    )}: expected a canonical decimal integer`;
  }

  const parsed = Number(value);
  const maximum = parameter === "limit" ? 500 : Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (parameter === "limit" ? 1 : 0) ||
    parsed > maximum
  ) {
    const bounds =
      parameter === "limit"
        ? "between 1 and 500"
        : "greater than or equal to 0";
    return `Invalid ${parameter} ${JSON.stringify(
      rawValue,
    )}: expected an integer ${bounds}`;
  }

  return parsed;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const limit = parsePaginationParam(c.req.query("limit"), "limit", 50);
    if (typeof limit === "string") {
      return c.json({ success: false, error: limit }, 400);
    }
    const ledger = await activeBillingService.listLedger(
      user.organization_id,
      limit,
    );

    return c.json({
      success: true,
      ledger,
      total: ledger.length,
    });
  } catch (error) {
    logger.error("[Billing Ledger API] Error listing ledger", error);
    return failureResponse(c, error);
  }
});

export default app;

/**
 * Dispatches an authenticated organization's manual request through the
 * durable auto-top-up state machine without reading or recomputing money.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { autoTopUpService } from "@/lib/services/auto-top-up";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", moneyRateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const result = await autoTopUpService.executeAutoTopUpForOrganization(
      user.organization_id,
      { source: "manual" },
    );

    if (result.success) {
      return c.json({
        success: true,
        message:
          result.amount === undefined
            ? "Auto top-up successful"
            : `Auto top-up successful! Added $${result.amount.toFixed(2)}`,
        amount: result.amount,
        previousBalance: result.previousBalance,
        newBalance: result.newBalance,
        attemptId: result.attemptId,
        status: result.status,
        recovered: result.recovered,
      });
    }

    const response = {
      success: false as const,
      error: result.error,
      amount: result.amount,
      previousBalance: result.previousBalance,
      newBalance: result.newBalance,
      attemptId: result.attemptId,
      status: result.status,
      recovered: result.recovered,
    };

    if (result.status === "not_needed") {
      return c.json({
        ...response,
        message:
          result.message ||
          "Balance is above threshold. Auto top-up not needed.",
      });
    }

    if (
      result.status === "claimed" ||
      result.status === "payment_pending" ||
      result.status === "payment_succeeded"
    ) {
      return c.json(
        {
          ...response,
          message: "Auto top-up is being processed",
        },
        202,
      );
    }

    if (result.status === "manual_review") {
      return c.json(
        {
          ...response,
          error: result.error || "Auto top-up requires manual review",
          code: "billing_state_conflict" as const,
          message: "Please review this payment before trying again",
        },
        409,
      );
    }

    if (result.status === "unavailable") {
      return c.json(
        {
          ...response,
          error:
            result.error || "Durable auto top-up is temporarily unavailable",
          code: "service_unavailable" as const,
          message: "Auto top-up is paused for a safe deployment transition",
        },
        503,
        { "Retry-After": "60" },
      );
    }

    return c.json(
      {
        ...response,
        error: result.error || "Auto top-up failed",
        message: "Please check your payment method and try again",
      },
      400,
    );
  } catch (error) {
    // error-policy:J1 The HTTP boundary returns the shared structured failure envelope.
    logger.error("[AutoTopUpTrigger] Manual dispatch failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
});

export default app;

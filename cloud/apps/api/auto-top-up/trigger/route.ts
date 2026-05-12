/**
 * POST /api/auto-top-up/trigger
 * Manually triggers an auto top-up check for the authenticated user's
 * organization. Useful for testing without waiting for cron.
 */

import { Hono } from "hono";
import { organizationsRepository } from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { autoTopUpService } from "@/lib/services/auto-top-up";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const org = await organizationsRepository.findById(user.organization_id);
    if (!org) return c.json({ error: "Organization not found" }, 404);

    if (!org.auto_top_up_enabled) {
      return c.json(
        { error: "Auto top-up is not enabled", message: "Please enable auto top-up first" },
        400,
      );
    }

    const currentBalance = Number(org.credit_balance || 0);
    const threshold = Number(org.auto_top_up_threshold || 0);

    if (currentBalance >= threshold) {
      return c.json({
        success: false,
        message: `Balance ($${currentBalance.toFixed(2)}) is above threshold ($${threshold.toFixed(2)}). Auto top-up not needed.`,
        currentBalance,
        threshold,
      });
    }

    const result = await autoTopUpService.executeAutoTopUp(org);

    if (result.success) {
      return c.json({
        success: true,
        message: `Auto top-up successful! Added $${result.amount?.toFixed(2)}`,
        amount: result.amount,
        previousBalance: currentBalance,
        newBalance: result.newBalance,
      });
    }
    return c.json(
      {
        success: false,
        error: result.error || "Auto top-up failed",
        message: "Please check your payment method and try again",
      },
      400,
    );
  } catch (error) {
    logger.error("Error triggering auto top-up:", error);
    return failureResponse(c, error);
  }
});

export default app;

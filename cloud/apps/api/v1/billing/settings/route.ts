/**
 * Billing Settings API (v1)
 *
 * GET/PUT /api/v1/billing/settings
 * Manage auto-top-up and billing settings.
 *
 * Auto-top-up powers autonomous-agent continuity: when balance falls below
 * threshold, the saved Stripe payment method is charged. Configuring this via
 * API lets agents/integrators tune their own billing without the dashboard.
 */

import { Hono } from "hono";
import { z } from "zod";
import { organizationsRepository } from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { AUTO_TOP_UP_LIMITS, autoTopUpService } from "@/lib/services/auto-top-up";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const UpdateSettingsSchema = z.object({
  autoTopUp: z
    .object({
      enabled: z.boolean().optional(),
      amount: z
        .number()
        .min(AUTO_TOP_UP_LIMITS.MIN_AMOUNT)
        .max(AUTO_TOP_UP_LIMITS.MAX_AMOUNT)
        .optional(),
      threshold: z
        .number()
        .min(AUTO_TOP_UP_LIMITS.MIN_THRESHOLD)
        .max(AUTO_TOP_UP_LIMITS.MAX_THRESHOLD)
        .optional(),
    })
    .optional(),
  payAsYouGoFromEarnings: z.boolean().optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const [autoTopUpSettings, org] = await Promise.all([
      autoTopUpService.getSettings(user.organization_id),
      organizationsRepository.findById(user.organization_id),
    ]);

    return c.json({
      success: true,
      settings: {
        autoTopUp: {
          enabled: autoTopUpSettings.enabled,
          amount: autoTopUpSettings.amount,
          threshold: autoTopUpSettings.threshold,
          hasPaymentMethod: autoTopUpSettings.hasPaymentMethod,
        },
        payAsYouGoFromEarnings: org?.pay_as_you_go_from_earnings ?? true,
        limits: {
          minAmount: AUTO_TOP_UP_LIMITS.MIN_AMOUNT,
          maxAmount: AUTO_TOP_UP_LIMITS.MAX_AMOUNT,
          minThreshold: AUTO_TOP_UP_LIMITS.MIN_THRESHOLD,
          maxThreshold: AUTO_TOP_UP_LIMITS.MAX_THRESHOLD,
        },
      },
    });
  } catch (error) {
    logger.error("[Billing Settings API] Error getting settings:", error);
    return failureResponse(c, error);
  }
});

app.put("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json();
    const validation = UpdateSettingsSchema.safeParse(body);

    if (!validation.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request data",
          details: validation.error.format(),
        },
        400,
      );
    }

    const { autoTopUp, payAsYouGoFromEarnings } = validation.data;

    if (autoTopUp) {
      try {
        await autoTopUpService.updateSettings(user.organization_id, {
          enabled: autoTopUp.enabled,
          amount: autoTopUp.amount,
          threshold: autoTopUp.threshold,
        });
      } catch (err) {
        // Allow domain-specific validation messages through (e.g. "Cannot
        // enable auto-top-up without a payment method") — they don't leak
        // internals.
        const message = err instanceof Error ? err.message : "";
        const isValidationError =
          message.includes("Cannot enable") ||
          message.includes("must be") ||
          message.includes("cannot exceed");
        if (isValidationError) {
          return c.json({ success: false, error: message }, 400);
        }
        throw err;
      }

      logger.info("[Billing Settings API] Updated auto-top-up settings", {
        organizationId: user.organization_id,
        userId: user.id,
        settings: autoTopUp,
      });
    }

    if (payAsYouGoFromEarnings !== undefined) {
      await organizationsRepository.update(user.organization_id, {
        pay_as_you_go_from_earnings: payAsYouGoFromEarnings,
        updated_at: new Date(),
      });

      logger.info("[Billing Settings API] Updated pay-as-you-go toggle", {
        organizationId: user.organization_id,
        userId: user.id,
        enabled: payAsYouGoFromEarnings,
      });
    }

    const [updatedSettings, org] = await Promise.all([
      autoTopUpService.getSettings(user.organization_id),
      organizationsRepository.findById(user.organization_id),
    ]);

    return c.json({
      success: true,
      message: "Billing settings updated successfully",
      settings: {
        autoTopUp: {
          enabled: updatedSettings.enabled,
          amount: updatedSettings.amount,
          threshold: updatedSettings.threshold,
          hasPaymentMethod: updatedSettings.hasPaymentMethod,
        },
        payAsYouGoFromEarnings: org?.pay_as_you_go_from_earnings ?? true,
      },
    });
  } catch (error) {
    logger.error("[Billing Settings API] Error updating settings:", error);
    return failureResponse(c, error);
  }
});

export default app;

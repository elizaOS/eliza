/**
 * Reads tenant billing settings and admits session-only manager changes.
 * The service rechecks current authority after validation and persists the
 * auto-top-up and earnings changes together before invalidating billing caches.
 */

import { Hono } from "hono";
import { z } from "zod";
import { organizationsRepository } from "@/db/repositories";
import {
  ApiError,
  ForbiddenError,
  failureResponse,
} from "@/lib/api/cloud-worker-errors";
import {
  requireCurrentBillingManagerSession,
  requireUserOrApiKeyWithOrg,
} from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  AUTO_TOP_UP_LIMITS,
  AutoTopUpSettingsPolicyError,
  AutoTopUpSettingsValidationError,
  autoTopUpService,
} from "@/lib/services/auto-top-up";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
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

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const [autoTopUpSettings, org] = await Promise.all([
      autoTopUpService.getSettings(user.organization_id),
      organizationsRepository.findById(user.organization_id),
    ]);

    if (!org) {
      throw new ApiError(
        503,
        "service_unavailable",
        "Billing settings are unavailable",
      );
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      settings: {
        autoTopUp: {
          enabled: autoTopUpSettings.enabled,
          amount: autoTopUpSettings.amount,
          threshold: autoTopUpSettings.threshold,
          hasPaymentMethod: autoTopUpSettings.hasPaymentMethod,
        },
        payAsYouGoFromEarnings: org.pay_as_you_go_from_earnings,
        limits: {
          minAmount: AUTO_TOP_UP_LIMITS.MIN_AMOUNT,
          maxAmount: AUTO_TOP_UP_LIMITS.MAX_AMOUNT,
          minThreshold: AUTO_TOP_UP_LIMITS.MIN_THRESHOLD,
          maxThreshold: AUTO_TOP_UP_LIMITS.MAX_THRESHOLD,
        },
      },
    });
  } catch (error) {
    // error-policy:J1 transport boundary returns a sanitized failure.
    logger.error("[Billing Settings API] Error getting settings:", error);
    return failureResponse(c, error);
  }
});

app.put("/", moneyRateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireCurrentBillingManagerSession(c);

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is an explicit invalid request.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;
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

    const authorizeMutation = async (): Promise<void> => {
      const current = await requireCurrentBillingManagerSession(c);
      if (
        current.id !== user.id ||
        current.organization_id !== user.organization_id
      ) {
        throw ForbiddenError("Organization billing authority changed");
      }
    };
    await autoTopUpService.updateSettings(
      user.organization_id,
      { ...autoTopUp, payAsYouGoFromEarnings },
      authorizeMutation,
    );
    logger.info("[Billing Settings API] Updated billing settings", {
      organizationId: user.organization_id,
      userId: user.id,
      command: "billing.settings.update",
      decision: "authorized",
      outcome: "persisted",
    });

    const [updatedSettings, org] = await Promise.all([
      autoTopUpService.getSettings(user.organization_id),
      organizationsRepository.findById(user.organization_id),
    ]);

    if (!org) {
      throw new ApiError(
        503,
        "service_unavailable",
        "Billing settings are unavailable",
      );
    }
    c.header("Cache-Control", "no-store");
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
        payAsYouGoFromEarnings: org.pay_as_you_go_from_earnings,
      },
    });
  } catch (error) {
    // error-policy:J1 transport boundary maps typed settings validation safely.
    if (error instanceof AutoTopUpSettingsValidationError) {
      return c.json(
        {
          success: false,
          error:
            "Valid auto top-up values are required to replace corrupt settings.",
          code: "validation_error",
        },
        400,
      );
    }
    if (error instanceof AutoTopUpSettingsPolicyError) {
      return c.json(
        { success: false, error: error.message, code: "validation_error" },
        400,
      );
    }
    logger.error("[Billing Settings API] Error updating settings:", error);
    return failureResponse(c, error);
  }
});

export default app;

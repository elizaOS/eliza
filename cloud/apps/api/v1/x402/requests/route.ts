/**
 * POST /api/v1/x402/requests
 * Create a durable x402 payment request for an authenticated creator/org.
 *
 * GET /api/v1/x402/requests
 * List x402 payment requests for the authenticated creator/org.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { appsService } from "@/lib/services/apps";
import {
  X402PaymentRequestError,
  x402PaymentRequestsService,
} from "@/lib/services/x402-payment-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CreatePaymentRequestSchema = z.object({
  amountUsd: z.number().positive().max(100_000),
  network: z.string().optional(),
  description: z.string().trim().min(1).max(240).optional(),
  callbackUrl: z.string().url().optional(),
  appId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expiresInSeconds: z.number().int().min(60).max(86_400).optional(),
});

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json();
    const parsed = CreatePaymentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid request", details: parsed.error.format() },
        400,
      );
    }

    const { appId } = parsed.data;
    if (appId) {
      const targetApp = await appsService.getById(appId);
      if (!targetApp) return c.json({ success: false, error: "App not found" }, 404);
      if (targetApp.organization_id !== user.organization_id) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }
    }

    const result = await x402PaymentRequestsService.create({
      organizationId: user.organization_id,
      userId: user.id,
      ...parsed.data,
    });

    return c.json(
      {
        success: true,
        ...result,
      },
      {
        headers: {
          "PAYMENT-REQUIRED": result.paymentRequiredHeader,
          "Payment-Required": result.paymentRequiredHeader,
          "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, Payment-Required",
        },
      },
    );
  } catch (error) {
    logger.error("[x402-payment-requests] create failed", error);
    if (error instanceof X402PaymentRequestError) {
      return Response.json(
        { success: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return failureResponse(c, error);
  }
});

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const paymentRequests = await x402PaymentRequestsService.listByOrganization(
      user.organization_id,
    );
    return c.json({ success: true, paymentRequests });
  } catch (error) {
    logger.error("[x402-payment-requests] list failed", error);
    return failureResponse(c, error);
  }
});

export default app;

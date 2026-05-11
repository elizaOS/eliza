/**
 * Unified payment requests — collection routes.
 *
 * POST  /api/v1/payment-requests        Create a new payment request (authed creator).
 * GET   /api/v1/payment-requests        List payment requests for the caller's org.
 *
 * The unified surface fronts the underlying provider implementations
 * (stripe, oxapay, x402, crypto). Existing app-charge / crypto-payments /
 * x402 routes remain unchanged.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getPaymentRequestsService } from "@/lib/services/payment-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ProviderSchema = z.enum(["stripe", "oxapay", "x402", "crypto"]);
const PaymentContextSchema = z.enum(["verified_payer", "any_payer"]);
const StatusSchema = z.enum(["pending", "settled", "expired", "cancelled", "failed"]);

const CreatePaymentRequestSchema = z.object({
  provider: ProviderSchema,
  amountCents: z.number().int().min(1).max(100_000_000),
  currency: z.string().min(3).max(8).optional(),
  paymentContext: PaymentContextSchema,
  reason: z.string().max(500).optional(),
  expiresInMs: z
    .number()
    .int()
    .min(60_000)
    .max(30 * 24 * 60 * 60 * 1000)
    .optional(),
  callbackUrl: z.string().url().optional(),
  callbackSecret: z.string().min(8).max(256).optional(),
  payerIdentityId: z.string().min(1).max(256).optional(),
  agentId: z.string().min(1).max(256).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ListQuerySchema = z.object({
  status: StatusSchema.optional(),
  provider: ProviderSchema.optional(),
  agentId: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json().catch(() => null);
    const parsed = CreatePaymentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid request", details: parsed.error.issues },
        400,
      );
    }

    const service = getPaymentRequestsService(c.env);
    const result = await service.create({
      organizationId: user.organization_id,
      creatorUserId: user.id,
      provider: parsed.data.provider,
      amountCents: parsed.data.amountCents,
      currency: parsed.data.currency,
      paymentContext: parsed.data.paymentContext,
      reason: parsed.data.reason,
      expiresInMs: parsed.data.expiresInMs,
      callbackUrl: parsed.data.callbackUrl,
      callbackSecret: parsed.data.callbackSecret,
      payerIdentityId: parsed.data.payerIdentityId,
      agentId: parsed.data.agentId,
      metadata: parsed.data.metadata,
    });

    return c.json({
      success: true,
      paymentRequest: result.paymentRequest,
      hostedUrl: result.hostedUrl,
    });
  } catch (error) {
    logger.error("[PaymentRequests API] Failed to create payment request", { error });
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const parsed = ListQuerySchema.safeParse({
      status: c.req.query("status"),
      provider: c.req.query("provider"),
      agentId: c.req.query("agentId"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid query", details: parsed.error.issues },
        400,
      );
    }

    const service = getPaymentRequestsService(c.env);
    const paymentRequests = await service.list(user.organization_id, {
      status: parsed.data.status,
      provider: parsed.data.provider,
      agentId: parsed.data.agentId,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    return c.json({ success: true, paymentRequests });
  } catch (error) {
    logger.error("[PaymentRequests API] Failed to list payment requests", { error });
    return failureResponse(c, error);
  }
});

export default app;

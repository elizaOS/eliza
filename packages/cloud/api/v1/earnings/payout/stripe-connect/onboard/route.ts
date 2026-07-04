// Handles v1 cloud API v1 earnings payout stripe connect onboard route traffic with route-local auth expectations.
import { stripeConnectAccountsRepository } from "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts";
import { createConnectOnboarding } from "@elizaos/cloud-shared/lib/services/stripe-connect-payout";
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { nextJsonFromCaughtError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { toConnectClient } from "../_stripe-connect-client";

const OnboardSchema = z.object({
  refresh_url: z.string().url(),
  return_url: z.string().url(),
});

/**
 * POST /api/v1/earnings/payout/stripe-connect/onboard (#8922)
 * Create (or reuse) the caller's Stripe Connect Express account and return a
 * one-time onboarding URL. Persists the linkage on first creation.
 */
async function handlePOST(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: "Invalid JSON in request body" },
        { status: 400 },
      );
    }
    const parsed = OnboardSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid request",
        },
        { status: 400 },
      );
    }

    const existing = await stripeConnectAccountsRepository.findByUserId(
      user.id,
    );
    const result = await createConnectOnboarding(
      toConnectClient(requireStripe()),
      {
        userId: user.id,
        email: user.email ?? undefined,
        refreshUrl: parsed.data.refresh_url,
        returnUrl: parsed.data.return_url,
        existingAccountId: existing?.stripe_connect_account_id,
      },
    );
    if (result.created) {
      await stripeConnectAccountsRepository.upsert({
        user_id: user.id,
        stripe_connect_account_id: result.accountId,
      });
    }

    logger.info("[StripeConnect] onboarding link issued", {
      userId: user.id,
      accountId: result.accountId,
      created: result.created,
    });
    return Response.json({
      success: true,
      accountId: result.accountId,
      onboardingUrl: result.onboardingUrl,
    });
  } catch (error) {
    return nextJsonFromCaughtError(error);
  }
}

const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", rateLimit(RateLimitPresets.CRITICAL), async (c) => {
  try {
    return await handlePOST(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;

import { affiliatesRepository } from "@elizaos/cloud-shared/db/repositories/affiliates";
import { stripeConnectAccountsRepository } from "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { nextJsonFromCaughtError } from "@elizaos/cloud-shared/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@elizaos/cloud-shared/lib/auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { createConnectOnboarding } from "@elizaos/cloud-shared/lib/services/stripe-connect-payout";
import { requireStripe } from "@elizaos/cloud-shared/lib/stripe";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { toConnectClient } from "../_stripe-connect-client";

const OnboardSchema = z.object({
  refresh_url: z.string().url(),
  return_url: z.string().url(),
});

/**
 * POST /api/v1/earnings/payout/stripe-connect/onboard (#8922)
 * Create (or reuse) the caller's Stripe Connect Express account and return a
 * one-time onboarding URL. Persists the linkage on first creation.
 *
 * Creator payouts are retired (#23022); Stripe Connect now only pays affiliate
 * earnings, so onboarding is limited to users with an affiliate code.
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

    const affiliateCode = await affiliatesRepository.getAffiliateCodeByUserId(
      user.id,
    );
    if (!affiliateCode) {
      return Response.json(
        {
          success: false,
          error:
            "Stripe Connect payouts are only available to affiliates. Creator payouts have been retired.",
          code: "access_denied",
        },
        { status: 403 },
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
honoRouter.post("/", moneyRateLimit(RateLimitPresets.CRITICAL), async (c) => {
  try {
    return await handlePOST(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;

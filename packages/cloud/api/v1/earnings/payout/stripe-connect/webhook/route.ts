import { stripeConnectAccountsRepository } from "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts";
import { mapConnectWebhookEvent } from "@elizaos/cloud-shared/lib/services/stripe-connect-payout";
import { Hono } from "hono";
import type Stripe from "stripe";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isStripeConfigured, requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

/**
 * Stripe signature tolerance window (seconds) — matches the main
 * `/api/stripe/webhook` handler so Connect webhooks share Stripe's default
 * 300s replay window.
 */
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * POST /api/v1/earnings/payout/stripe-connect/webhook (#8922)
 *
 * Advance connect-account status from Stripe Connect events
 * (`transfer.created` / `payout.paid` / `account.updated`).
 *
 * SECURITY: this route is on the PUBLIC (unauthenticated) allowlist in
 * `middleware/auth.ts` because Stripe calls it directly — so its ONLY trust
 * boundary is the Stripe signature. We verify the `stripe-signature` header
 * with `constructEventAsync` (WebCrypto; Workers-safe) BEFORE applying any
 * state change, exactly like the main `/api/stripe/webhook` handler. Without
 * this, anyone who knows an `acct_*` id could POST a forged `account.updated`
 * / `payout.paid` and flip a creator's payout-account status (#10117).
 *
 * Connect endpoints may be configured with a dedicated signing secret, so we
 * accept `STRIPE_CONNECT_WEBHOOK_SECRET` and fall back to the main
 * `STRIPE_WEBHOOK_SECRET` (Connect events delivered to the primary endpoint
 * verify with that one — already wired in prod). Fail-closed: missing/invalid
 * signature → 400; missing config → 500.
 */
async function handlePOST(c: AppContext): Promise<Response> {
  const body = await c.req.text();
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ success: false, error: "No signature provided" }, 400);
  }

  const webhookSecret =
    c.env.STRIPE_CONNECT_WEBHOOK_SECRET || c.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error(
      "[StripeConnect] webhook secret not set (STRIPE_CONNECT_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET)",
    );
    return c.json(
      { success: false, error: "Webhook configuration error" },
      500,
    );
  }
  if (!isStripeConfigured()) {
    logger.error("[StripeConnect] STRIPE_SECRET_KEY is not set");
    return c.json({ success: false, error: "Stripe configuration error" }, 500);
  }

  let event: Stripe.Event;
  try {
    // constructEventAsync uses WebCrypto and works on Workers; the sync
    // variant calls into node:crypto which is unavailable here.
    event = await requireStripe().webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret,
      STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    );
  } catch (err) {
    const reason =
      err instanceof Error && /timestamp/i.test(err.message)
        ? "stale_timestamp"
        : "invalid_signature";
    logger.error("[StripeConnect] webhook signature verification failed", {
      reason,
    });
    return c.json(
      { success: false, error: "Signature verification failed" },
      400,
    );
  }

  const outcome = mapConnectWebhookEvent({
    type: event.type,
    account: typeof event.account === "string" ? event.account : undefined,
    data: {
      object: event.data?.object as Record<string, unknown> | undefined,
    },
  });
  if (outcome.ignored || !outcome.accountId) {
    return c.json({ success: true, ignored: true });
  }

  await stripeConnectAccountsRepository.updateByAccountId(outcome.accountId, {
    ...(outcome.status ? { status: outcome.status } : {}),
  });
  logger.info("[StripeConnect] webhook applied", {
    type: event.type,
    accountId: outcome.accountId,
    payoutStatus: outcome.payoutStatus,
    status: outcome.status,
  });
  return c.json({ success: true });
}

const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", async (c) => {
  try {
    return await handlePOST(c);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;

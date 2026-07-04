// Handles webhook cloud API v1 earnings payout stripe connect webhook route traffic with signature or internal auth checks.
import { stripeConnectAccountsRepository } from "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts";
import { webhookEventsRepository } from "@elizaos/cloud-shared/db/repositories/webhook-events";
import { mapConnectWebhookEvent } from "@elizaos/cloud-shared/lib/services/stripe-connect-payout";
import { Hono } from "hono";
import type Stripe from "stripe";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isStripeConfigured, requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

/**
 * Maximum age (seconds) the Stripe `t=` timestamp may be relative to server
 * time — matches Stripe's SDK default and the main `stripe/webhook` route.
 */
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/** SHA-256 of the raw body for the webhook_events.payload_hash column.
 *  WebCrypto-only so this works on Workers. */
async function hashConnectPayload(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getClientIp(c: AppContext): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

/**
 * POST /api/v1/earnings/payout/stripe-connect/webhook (#8922)
 *
 * The Stripe **Connect** event handler — advances connect-account status from
 * `transfer.created` / `payout.paid` / `account.updated`. This route is in
 * `publicPathPrefixes` (unauthenticated), so it MUST verify the Stripe
 * signature itself: Connect endpoints have their own signing secret
 * (`STRIPE_CONNECT_WEBHOOK_SECRET`), distinct from `STRIPE_WEBHOOK_SECRET` which
 * signs the main billing endpoint. The signature is checked over the raw body
 * before any event is applied; missing/invalid signatures are rejected 400 and
 * audit-logged, and a missing secret fail-closes (500) rather than trusting an
 * unverified payload (#10117).
 */
async function handlePOST(c: AppContext): Promise<Response> {
  const body = await c.req.text();
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    return c.json({ success: false, error: "No signature provided" }, 400);
  }

  const webhookSecret = c.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error("[StripeConnect] STRIPE_CONNECT_WEBHOOK_SECRET is not set");
    return c.json(
      { success: false, error: "Webhook configuration error" },
      500,
    );
  }

  if (!isStripeConfigured()) {
    logger.error("[StripeConnect] STRIPE_SECRET_KEY is not set");
    return c.json({ success: false, error: "Stripe configuration error" }, 500);
  }

  const stripe = requireStripe();
  let event: Stripe.Event;
  try {
    // constructEventAsync uses WebCrypto and works on Workers; the sync variant
    // needs node:crypto which is unavailable here.
    event = await stripe.webhooks.constructEventAsync(
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
    logger.error("[StripeConnect] Signature verification failed", { reason });
    await getAuditDispatcher()
      .emit({
        actor: { type: "system", id: "stripe-connect-webhook" },
        action: "redemption.payout",
        result: "denied",
        resource: { type: "webhook", id: "stripe-connect" },
        ip: getClientIp(c),
        request_id: c.get("requestId"),
        metadata: { provider: "stripe-connect", reason },
      })
      .catch(() => undefined);
    return c.json(
      { success: false, error: "Webhook signature verification failed" },
      400,
    );
  }

  // Replay dedupe on the Stripe event id (matches the main stripe/webhook and
  // crypto webhooks). Stripe delivers at-least-once; without this a re-delivered
  // `account.updated` reapplies capability/status writes. The mutation below is
  // synchronous (no queue), so a committed marker with no rollback is safe.
  const dedupe = await webhookEventsRepository.tryCreate({
    event_id: `stripe-connect:${event.id}`,
    provider: "stripe-connect",
    event_type: event.type,
    payload_hash: await hashConnectPayload(body),
    source_ip: getClientIp(c),
    event_timestamp: event.created ? new Date(event.created * 1000) : undefined,
  });
  if (!dedupe.created) {
    logger.info("[StripeConnect] Duplicate event — skipping", {
      eventId: event.id,
      type: event.type,
    });
    return c.json({ success: true, duplicate: true });
  }

  const outcome = mapConnectWebhookEvent({
    type: event.type,
    account: event.account ?? undefined,
    // Stripe types `data.object` as a wide event-object union; the pure mapper
    // only reads capability booleans by key, so widen via `unknown`.
    data: {
      object: event.data?.object as unknown as
        | Record<string, unknown>
        | undefined,
    },
  });
  if (outcome.ignored || !outcome.accountId) {
    return c.json({ success: true, ignored: true });
  }

  await stripeConnectAccountsRepository.updateByAccountId(outcome.accountId, {
    ...(outcome.status ? { status: outcome.status } : {}),
    // Persist the capability booleans, not just the derived status: the payout
    // transfer gate reads `payouts_enabled` directly and it defaults false, so
    // storing status alone left every account non-payout-ready forever (#11172).
    ...(outcome.chargesEnabled !== undefined
      ? { charges_enabled: outcome.chargesEnabled }
      : {}),
    ...(outcome.payoutsEnabled !== undefined
      ? { payouts_enabled: outcome.payoutsEnabled }
      : {}),
  });
  logger.info("[StripeConnect] webhook applied", {
    type: event.type,
    eventId: event.id,
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

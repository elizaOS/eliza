import { stripeConnectAccountsRepository } from "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts";
import { mapConnectWebhookEvent } from "@elizaos/cloud-shared/lib/services/stripe-connect-payout";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * POST /api/v1/earnings/payout/stripe-connect/webhook (#8922)
 * Advance connect-account status from Stripe Connect events
 * (`transfer.created` / `payout.paid` / `account.updated`). Signature
 * verification is handled by the existing Stripe webhook middleware ahead of
 * this handler; here we apply the already-trusted event's status change.
 */
async function handlePOST(request: Request) {
  let event: {
    type: string;
    account?: string;
    data?: { object?: Record<string, unknown> };
  };
  try {
    event = (await request.json()) as typeof event;
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const outcome = mapConnectWebhookEvent(event);
  if (outcome.ignored || !outcome.accountId) {
    return Response.json({ success: true, ignored: true });
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
  return Response.json({ success: true });
}

const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", async (c) => {
  try {
    return await handlePOST(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;

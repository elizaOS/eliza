/** Accepts actual signed sandbox events into the production intake, durable receipts and finalizer. */
import type Stripe from "stripe";
import { webhookEventsRepository } from "../src/db/repositories/webhook-events";
import type { AppBillingReconciliation } from "../src/lib/services/app-billing-reconciliation";
import { appBillingTriggerFromVerifiedEvent } from "../src/lib/services/app-billing-webhook-intake";
export function createRuntimeSandboxIngress(config: {
  stripe: Stripe;
  account: string;
  webhookSecret: string;
  reconciler: AppBillingReconciliation;
  onProcessed(eventId: string): Promise<void>;
}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/stripe/webhook")
      return new Response(null, { status: 404 });
    const body = await request.text();
    let event: Stripe.Event;
    try {
      event = await config.stripe.webhooks.constructEventAsync(
        body,
        request.headers.get("stripe-signature") ?? "",
        config.webhookSecret,
      );
    } catch {
      // error-policy:J1 Reject unverified bytes before entering the database or provider path.
      return new Response("Invalid signature", { status: 400 });
    }
    if (event.livemode || (event.account ?? config.account) !== config.account)
      return new Response("Wrong environment", { status: 400 });
    try {
      const intake = await appBillingTriggerFromVerifiedEvent(event, body);
      if (!intake) return new Response(null, { status: 204 });
      const inserted = await webhookEventsRepository.tryCreate({
        event_id: intake.receiptKey,
        provider: "stripe",
        event_type: event.type,
        payload_hash: intake.trigger.event.payloadDigest,
        app_billing_trigger: intake.trigger,
        event_timestamp: new Date(event.created * 1000),
      });
      if (!inserted.created) {
        const previous = await webhookEventsRepository.findByEventIdPrimary(intake.receiptKey);
        if (previous?.payload_hash !== intake.trigger.event.payloadDigest)
          return new Response("Replay conflict", { status: 409 });
      }
      await config.reconciler.processPersisted(intake.receiptKey, intake.trigger);
      await config.onProcessed(event.id);
      return new Response(null, { status: 204 });
    } catch {
      // error-policy:J1 Stripe retries failed signed intake; durable receipts retain reconciliation errors.
      return new Response("Reconciliation unavailable", { status: 503 });
    }
  };
}

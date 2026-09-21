/** Creates recoverable, account-bound recurring Checkout sessions and activates only freshly retrieved captured first payments. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/common";
import type Stripe from "stripe";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import {
  finalizeSubscriptionCheckout,
  subscriptionCheckoutSessionSchema,
} from "../../db/repositories/subscription-checkout-finalization";
import type { SubscriptionPlanKey } from "../../db/schemas/billing-subscriptions";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { stripeCustomerAuthorityService } from "./stripe-customer-authority";
import { initialInvoiceSchema } from "./stripe-paid-renewal-validation";
import {
  adaptStripeSubscriptionCatalogProvider,
  getVerifiedSubscriptionPlans,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";

function unavailable(reason: string): never {
  throw new ElizaError(
    "Subscription checkout requires reconciliation; retry this checkout without starting a second purchase",
    { code: "SUBSCRIPTION_CHECKOUT_UNAVAILABLE", context: { reason } },
  );
}

export async function submitSubscriptionCheckout(
  input: {
    organizationId: string;
    actorId: string;
    planKey: SubscriptionPlanKey;
    idempotencyKey: string;
  },
  reauthorize: () => Promise<void>,
) {
  const stripe = requireStripe();
  const env = getCloudAwareEnv();
  await getVerifiedSubscriptionPlans({
    env,
    provider: adaptStripeSubscriptionCatalogProvider(stripe),
  });
  const appUrl = env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) unavailable("missing_app_origin");
  const origin = new URL(appUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password)
    unavailable("invalid_app_origin");
  const requestDigest = createHash("sha256")
    .update(
      JSON.stringify([input.organizationId, input.actorId, input.planKey, "v1", origin.origin]),
    )
    .digest("hex");
  const providerKey = `eliza-subscription-${createHash("sha256").update(`${input.organizationId}:${input.idempotencyKey}`).digest("hex")}`;
  await reauthorize();
  const pending = await operations.findPendingCheckout(input.organizationId);
  if (pending && pending.target_plan_key !== input.planKey)
    unavailable("different_plan_checkout_pending");
  if (
    pending &&
    pending.request_digest !==
      createHash("sha256")
        .update(
          JSON.stringify([
            input.organizationId,
            pending.requested_by_user_id,
            input.planKey,
            "v1",
            origin.origin,
          ]),
        )
        .digest("hex")
  )
    unavailable("pending_checkout_configuration_changed");
  let command =
    pending ??
    (
      await operations.enqueueCommand({
        organizationId: input.organizationId,
        requestedByUserId: input.actorId,
        kind: "checkout",
        subscriptionId: null,
        targetPlanKey: input.planKey,
        expectedSubscriptionRevision: null,
        idempotencyKey: input.idempotencyKey,
        providerIdempotencyKey: providerKey,
        requestDigest,
        now: new Date(),
      })
    ).value;
  if (command.status === "APPLIED")
    return { status: "completed" as const, commandId: command.id, checkoutUrl: null };
  if (command.status === "PREPARED") {
    const claimed = await operations.markCommandOutcomeUnknown({
      organizationId: input.organizationId,
      commandId: command.id,
      expectedStateRevision: command.state_revision,
      expectedExecutionGeneration: command.execution_generation,
    });
    if (!claimed) unavailable("command_changed");
    command = claimed;
  }
  if (command.status !== "OUTCOME_UNKNOWN" || !command.provider_started_at)
    unavailable("checkout_not_pending");
  await reauthorize();
  const customerId = await stripeCustomerAuthorityService.ensure({
    organizationId: input.organizationId,
    callerIntent: "interactive_checkout",
  });
  let session: Stripe.Checkout.Session | undefined;
  // Recovery reads all pages. The durable command, not provider metadata alone, authorizes activation.
  for await (const candidate of stripe.checkout.sessions.list({
    customer: customerId,
    limit: 100,
  })) {
    if (candidate.client_reference_id === command.id) {
      if (session) unavailable("duplicate_checkout_sessions");
      session = candidate;
    }
  }
  if (!session) {
    // Never reuse a Stripe key after its guaranteed retention window.
    if (Date.now() - command.provider_started_at.getTime() >= 23 * 60 * 60 * 1000)
      unavailable("provider_retry_window_elapsed");
    await reauthorize();
    const binding = resolveSubscriptionProviderBinding(env, input.planKey, "v1");
    session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        client_reference_id: command.id,
        line_items: [{ price: binding.priceId, quantity: 1 }],
        payment_method_types: ["card"],
        allow_promotion_codes: false,
        automatic_tax: { enabled: false },
        metadata: {
          app: "eliza-cloud",
          organization_id: input.organizationId,
          command_id: command.id,
        },
        subscription_data: {
          metadata: {
            app: "eliza-cloud",
            organization_id: input.organizationId,
            command_id: command.id,
          },
        },
        success_url: `${origin.origin}/cloud/billing?subscription_session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin.origin}/cloud/billing`,
        expires_at: Math.floor(command.provider_started_at.getTime() / 1000) + 24 * 60 * 60,
      },
      { idempotencyKey: command.provider_idempotency_key },
    );
  }
  const parsed = subscriptionCheckoutSessionSchema.parse(session);
  if (
    parsed.customer !== customerId ||
    parsed.metadata.organization_id !== input.organizationId ||
    parsed.metadata.command_id !== command.id
  )
    unavailable("session_identity_mismatch");
  if (parsed.status === "complete") {
    await reconcileSubscriptionCheckout(session.id, input.organizationId);
    return { status: "completed" as const, commandId: command.id, checkoutUrl: null };
  }
  if (parsed.status === "expired") {
    await operations.resolveCommandOutcome({
      organizationId: input.organizationId,
      commandId: command.id,
      expectedStateRevision: command.state_revision,
      expectedExecutionGeneration: command.execution_generation,
      outcome: "FAILED",
      providerResponseDigest: null,
      errorCode: "CHECKOUT_EXPIRED",
    });
    return { status: "expired" as const, commandId: command.id, checkoutUrl: null };
  }
  if (!session.url) unavailable("missing_checkout_url");
  const url = new URL(session.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "checkout.stripe.com" ||
    url.username ||
    url.password
  )
    unavailable("invalid_checkout_url");
  return { status: "open" as const, commandId: command.id, checkoutUrl: session.url };
}

export async function reconcileSubscriptionCheckout(
  sessionId: string,
  expectedOrganizationId?: string,
) {
  const stripe = requireStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const parsed = subscriptionCheckoutSessionSchema.parse(session);
  if (
    expectedOrganizationId !== undefined &&
    parsed.metadata.organization_id !== expectedOrganizationId
  )
    unavailable("checkout_account_mismatch");
  const command = await operations.findCommand(
    parsed.metadata.organization_id,
    parsed.metadata.command_id,
  );
  if (!command || command.kind !== "checkout" || command.id !== parsed.client_reference_id)
    unavailable("unknown_checkout");
  if (
    parsed.status !== "complete" ||
    parsed.payment_status !== "paid" ||
    !parsed.subscription ||
    !parsed.invoice
  )
    unavailable("checkout_payment_pending");
  const invoice = await stripe.invoices.retrieve(parsed.invoice);
  const paid = initialInvoiceSchema.parse(invoice);
  const [subscription, customer, paymentIntent, charge] = await Promise.all([
    stripe.subscriptions.retrieve(parsed.subscription),
    stripe.customers.retrieve(parsed.customer),
    stripe.paymentIntents.retrieve(paid.payment_intent),
    stripe.charges.retrieve(paid.charge),
  ]);
  return finalizeSubscriptionCheckout({
    session,
    invoice,
    subscription,
    customer,
    paymentIntent,
    charge,
  });
}

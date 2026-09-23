/** Creates recoverable, account-bound recurring Checkout sessions and activates only freshly retrieved captured first payments. */
import { createHash, randomUUID } from "node:crypto";
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
import {
  assertCheckoutProviderAuthority,
  readCheckoutContract,
  requireCheckoutContract,
} from "./subscription-checkout-contract";

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
  const replay = await operations.findCommandByIdempotencyKey(
    input.organizationId,
    input.idempotencyKey,
  );
  if (
    replay &&
    (replay.kind !== "checkout" ||
      replay.requested_by_user_id !== input.actorId ||
      replay.target_plan_key !== input.planKey)
  )
    unavailable("checkout_replay_mismatch");
  const pending = replay ? undefined : await operations.findPendingCheckout(input.organizationId);
  if (pending && pending.target_plan_key !== input.planKey)
    unavailable("different_plan_checkout_pending");
  let command = replay ?? pending;
  if (!command) {
    const commandId = randomUUID();
    const createdAt = new Date();
    await getVerifiedSubscriptionPlans({
      env,
      provider: adaptStripeSubscriptionCatalogProvider(stripe),
    });
    const account = await stripe.accounts.retrieve(null);
    await reauthorize();
    const customerId = await stripeCustomerAuthorityService.ensure({
      organizationId: input.organizationId,
      callerIntent: "interactive_checkout",
    });
    const binding = resolveSubscriptionProviderBinding(env, input.planKey, "v1");
    const contract = requireCheckoutContract({
      version: 1,
      catalogVersion: "v1",
      planKey: input.planKey,
      accountId: account.id,
      expectedLivemode: binding.expectedLivemode,
      priceId: binding.priceId,
      productId: binding.productId,
      params: {
        mode: "subscription",
        customer: customerId,
        client_reference_id: commandId,
        line_items: [{ price: binding.priceId, quantity: 1 }],
        payment_method_types: ["card"],
        allow_promotion_codes: false,
        automatic_tax: { enabled: false },
        metadata: {
          app: "eliza-cloud",
          organization_id: input.organizationId,
          command_id: commandId,
        },
        subscription_data: {
          metadata: {
            app: "eliza-cloud",
            organization_id: input.organizationId,
            command_id: commandId,
          },
        },
        success_url: `${origin.origin}/cloud/billing?subscription_session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin.origin}/cloud/billing`,
        expires_at: Math.floor(createdAt.getTime() / 1000) + 24 * 60 * 60,
      },
    });
    command = (
      await operations.enqueueCommand({
        id: commandId,
        organizationId: input.organizationId,
        requestedByUserId: input.actorId,
        kind: "checkout",
        subscriptionId: null,
        targetPlanKey: input.planKey,
        expectedSubscriptionRevision: null,
        idempotencyKey: input.idempotencyKey,
        providerIdempotencyKey: providerKey,
        requestDigest,
        checkoutContract: contract,
        now: createdAt,
      })
    ).value;
  }
  if (command.status === "APPLIED")
    return { status: "completed" as const, commandId: command.id, checkoutUrl: null };
  const contract = readCheckoutContract(command);
  const account = await stripe.accounts.retrieve(null);
  assertCheckoutProviderAuthority(contract, account.id, env);
  if (command.status === "PREPARED") {
    const claimed = await operations.markCommandOutcomeUnknown({
      organizationId: input.organizationId,
      commandId: command.id,
      expectedStateRevision: command.state_revision,
      expectedExecutionGeneration: command.execution_generation,
    });
    if (claimed) command = claimed;
    else {
      const winner = await operations.findCommandByIdempotencyKey(
        input.organizationId,
        command.idempotency_key,
      );
      if (!winner || winner.id !== command.id || winner.status !== "OUTCOME_UNKNOWN")
        unavailable("command_changed");
      readCheckoutContract(winner);
      command = winner;
    }
  }
  if (command.status !== "OUTCOME_UNKNOWN" || !command.provider_started_at)
    unavailable("checkout_not_pending");
  await reauthorize();
  const customerId = contract.params.customer;
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
    session = await stripe.checkout.sessions.create(contract.params, {
      idempotencyKey: command.provider_idempotency_key,
    });
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
  const contract =
    command.status === "APPLIED" && command.checkout_contract === null
      ? null
      : readCheckoutContract(command);
  const account = await stripe.accounts.retrieve(null);
  if (contract) assertCheckoutProviderAuthority(contract, account.id, getCloudAwareEnv());
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
    providerAccountId: account.id,
    session,
    invoice,
    subscription,
    customer,
    paymentIntent,
    charge,
  });
}

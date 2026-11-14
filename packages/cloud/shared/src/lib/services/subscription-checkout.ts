/** Creates recoverable, account-bound recurring Checkout sessions and activates only freshly retrieved captured first payments. */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { subscriptionBillingOperationsRepository as operations } from "../../db/repositories/subscription-billing-operations";
import {
  finalizeSubscriptionCheckout,
  subscriptionCheckoutSessionSchema,
} from "../../db/repositories/subscription-checkout-finalization";
import { subscriptionCheckoutRecoveryRepository as recovery } from "../../db/repositories/subscription-checkout-recovery";
import type { SubscriptionPlanKey } from "../../db/schemas/billing-subscriptions";
import type { BillingSubscriptionCommand } from "../../db/schemas/subscription-billing-operations";
import { isProductionDeployment } from "../config/deployment-environment";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { logger } from "../utils/logger";
import { stripeCustomerAuthorityService } from "./stripe-customer-authority";
import { initialInvoiceSchema } from "./stripe-paid-renewal-validation";
import {
  adaptStripeSubscriptionCatalogProvider,
  getVerifiedSubscriptionPlans,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";
import {
  assertCheckoutProviderAuthority,
  type CheckoutContract,
  checkoutPresentation,
  readCheckoutContract,
  requireCheckoutContract,
  requireCheckoutPublishableKey,
  SUBSCRIPTION_CHECKOUT_CANCEL_PATH,
  type SubscriptionCheckoutPresentation,
  sharedCheckoutReturnUrl,
} from "./subscription-checkout-contract";

/** Stripe's maximum is 24h; stay below it so provider clock skew never rejects creation. */
export const CHECKOUT_SESSION_TTL_MS = (23 * 60 + 55) * 60 * 1000;
/** Stripe rejects `expires_at` less than 30 minutes after the create request. */
const STRIPE_MIN_SESSION_REMAINING_MS = 30 * 60 * 1000;
/** Never reuse a Stripe idempotency key after its guaranteed retention window. */
const PROVIDER_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
/** A create admitted before its deadline is visible to session listing well within this margin. */
const PROVIDER_CREATE_SETTLE_MS = 5 * 60 * 1000;

export type SubscriptionCheckoutResult =
  /** Hosted (default): this account's own browser redirect, unchanged from the original contract. */
  | { status: "open"; commandId: string; checkoutUrl: string }
  /**
   * In-app Embedded Checkout. `clientSecret` mounts the payment form; the quote is the
   * provider session's own amount. Payment is never inferred from the form: entitlement
   * comes only from the webhook or `checkout/confirm` with `sessionId`.
   */
  | {
      status: "open";
      presentation: "embedded";
      commandId: string;
      checkoutUrl: null;
      sessionId: string;
      uiMode: "embedded";
      clientSecret: string;
      publishableKey: string;
      amountDueCents: number;
      currency: "usd";
      interval: "month";
      expiresAt: string;
    }
  /** A hosted page for someone else to pay without signing in; returns land on the public payer page. */
  | {
      status: "open";
      presentation: "shared";
      commandId: string;
      checkoutUrl: string;
      expiresAt: string;
    }
  /** The provider payment is captured and the subscription it created is still live. */
  | { status: "completed"; commandId: string; checkoutUrl: null }
  /** The checkout expired or was replaced; this intent is spent and the client must mint a new key. */
  | { status: "expired"; commandId: string; checkoutUrl: null }
  /** The intent already bought a subscription that is no longer live; mint a new key to buy again. */
  | { status: "stale_intent"; commandId: string; checkoutUrl: null };

type PendingCheckoutSettlement = "settled" | "completed" | "pending";
type Reauthorize = () => Promise<void>;

function unavailable(reason: string): never {
  throw new ElizaError(
    "Subscription checkout requires reconciliation; retry this checkout without starting a second purchase",
    { code: "SUBSCRIPTION_CHECKOUT_UNAVAILABLE", context: { reason } },
  );
}

/** Non-retryable: repeating the same request cannot succeed until billing state is refreshed. */
function rejected(reason: string): never {
  throw new ElizaError("Subscription checkout conflicts with current billing state", {
    code: "SUBSCRIPTION_CHECKOUT_REJECTED",
    context: { reason },
  });
}

function terminal(
  status: "completed" | "expired" | "stale_intent",
  commandId: string,
): SubscriptionCheckoutResult {
  return { status, commandId, checkoutUrl: null };
}

function isRetired(command: BillingSubscriptionCommand): boolean {
  return command.status === "FAILED" || command.status === "SUPERSEDED";
}

/** Returns `completed` only while the subscription this checkout published is still live. */
async function appliedResult(
  command: BillingSubscriptionCommand,
): Promise<SubscriptionCheckoutResult> {
  const live =
    command.result_subscription_id !== null &&
    (await recovery.isLiveOrganizationSubscription(
      command.organization_id,
      command.result_subscription_id,
    ));
  return terminal(live ? "completed" : "stale_intent", command.id);
}

/**
 * Decides what to do when no provider session carries this command's reference:
 * create it while Stripe would still accept the stored contract, wait while a
 * create admitted before that deadline could still become visible, then fail.
 */
function noSessionDisposition(
  command: BillingSubscriptionCommand,
  contract: CheckoutContract,
  nowMs: number,
): "create" | "wait" | "fail" {
  const startedMs = (command.provider_started_at ?? command.created_at).getTime();
  const createDeadline = Math.min(
    contract.params.expires_at * 1000 - STRIPE_MIN_SESSION_REMAINING_MS,
    startedMs + PROVIDER_RETRY_WINDOW_MS,
  );
  if (nowMs < createDeadline) return "create";
  if (nowMs < createDeadline + PROVIDER_CREATE_SETTLE_MS) return "wait";
  return "fail";
}

/** Moves an unpaid pending checkout to a terminal failure and returns the durable state. */
async function retireCommand(
  command: BillingSubscriptionCommand,
  errorCode: string,
): Promise<BillingSubscriptionCommand> {
  const changed =
    command.status === "PREPARED"
      ? await operations.supersedePreparedCommand({
          organizationId: command.organization_id,
          commandId: command.id,
          expectedStateRevision: command.state_revision,
          errorCode,
        })
      : command.status === "OUTCOME_UNKNOWN"
        ? await operations.resolveCommandOutcome({
            organizationId: command.organization_id,
            commandId: command.id,
            expectedStateRevision: command.state_revision,
            expectedExecutionGeneration: command.execution_generation,
            outcome: "FAILED",
            providerResponseDigest: null,
            errorCode,
          })
        : null;
  if (changed) return changed;
  const current = await operations.findCommand(command.organization_id, command.id);
  if (!current) unavailable("command_changed");
  return current;
}

async function findCheckoutSession(
  stripe: Stripe,
  customerId: string,
  commandId: string,
): Promise<Stripe.Checkout.Session | undefined> {
  let session: Stripe.Checkout.Session | undefined;
  // Recovery reads all pages. The durable command, not provider metadata alone, authorizes activation.
  for await (const candidate of stripe.checkout.sessions.list({
    customer: customerId,
    limit: 100,
  })) {
    if (candidate.client_reference_id === commandId) {
      if (session) unavailable("duplicate_checkout_sessions");
      session = candidate;
    }
  }
  return session;
}

function assertSessionIdentity(
  session: Stripe.Checkout.Session,
  command: BillingSubscriptionCommand,
  customerId: string,
) {
  const parsed = subscriptionCheckoutSessionSchema.parse(session);
  if (
    parsed.customer !== customerId ||
    parsed.metadata.organization_id !== command.organization_id ||
    parsed.metadata.command_id !== command.id ||
    parsed.client_reference_id !== command.id
  )
    unavailable("session_identity_mismatch");
  return parsed;
}

/**
 * Drives one pending checkout to an open provider session or a terminal result.
 * A PREPARED command has never reached the provider, so a stale one is retired
 * instead of dispatched with an expiry Stripe would reject.
 */
async function driveCheckout(
  stripe: Stripe,
  env: NodeJS.ProcessEnv,
  initial: BillingSubscriptionCommand,
  reauthorize: Reauthorize,
): Promise<SubscriptionCheckoutResult> {
  let command = initial;
  if (command.status === "APPLIED") return appliedResult(command);
  if (isRetired(command)) return terminal("expired", command.id);
  const contract = readCheckoutContract(command);
  const account = await stripe.accounts.retrieve(null);
  assertCheckoutProviderAuthority(contract, account.id, env);
  if (command.status === "PREPARED") {
    if (Date.now() >= contract.params.expires_at * 1000 - STRIPE_MIN_SESSION_REMAINING_MS) {
      const retired = await retireCommand(command, "CHECKOUT_CONTRACT_EXPIRED");
      if (retired.status === "PREPARED") unavailable("command_changed");
      return driveCheckout(stripe, env, retired, reauthorize);
    }
    const claimed = await operations.markCommandOutcomeUnknown({
      organizationId: command.organization_id,
      commandId: command.id,
      expectedStateRevision: command.state_revision,
      expectedExecutionGeneration: command.execution_generation,
    });
    if (claimed) command = claimed;
    else {
      const winner = await operations.findCommand(command.organization_id, command.id);
      if (!winner || winner.status === "PREPARED") unavailable("command_changed");
      if (winner.status !== "OUTCOME_UNKNOWN")
        return driveCheckout(stripe, env, winner, reauthorize);
      readCheckoutContract(winner);
      command = winner;
    }
  }
  if (command.status !== "OUTCOME_UNKNOWN" || !command.provider_started_at)
    unavailable("checkout_not_pending");
  await reauthorize();
  const customerId = contract.params.customer;
  let session = await findCheckoutSession(stripe, customerId, command.id);
  if (!session) {
    const disposition = noSessionDisposition(command, contract, Date.now());
    if (disposition === "fail") {
      const retired = await retireCommand(command, "CHECKOUT_EXPIRED");
      if (!isRetired(retired)) unavailable("command_changed");
      return terminal("expired", command.id);
    }
    if (disposition === "wait") unavailable("provider_retry_window_elapsed");
    await reauthorize();
    session = await stripe.checkout.sessions.create(contract.params, {
      idempotencyKey: command.provider_idempotency_key,
    });
  }
  const parsed = assertSessionIdentity(session, command, customerId);
  if (parsed.status === "complete") {
    await reconcileSubscriptionCheckout(session.id, command.organization_id);
    return terminal("completed", command.id);
  }
  if (parsed.status === "expired") {
    const retired = await retireCommand(command, "CHECKOUT_EXPIRED");
    if (!isRetired(retired)) unavailable("command_changed");
    return terminal("expired", command.id);
  }
  return openResult(session, command, contract, env);
}

function openResult(
  session: Stripe.Checkout.Session,
  command: BillingSubscriptionCommand,
  contract: CheckoutContract,
  env: NodeJS.ProcessEnv,
): SubscriptionCheckoutResult {
  const presentation = checkoutPresentation(contract);
  const expiresAt = new Date(session.expires_at * 1000).toISOString();
  if (presentation === "embedded") {
    const secret = session.client_secret;
    if (
      session.ui_mode !== "embedded" ||
      typeof secret !== "string" ||
      !secret.startsWith(`${session.id}_secret_`)
    )
      unavailable("invalid_embedded_session");
    const amount = session.amount_total;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0)
      unavailable("missing_checkout_amount");
    if (session.currency !== "usd") unavailable("checkout_currency_mismatch");
    return {
      status: "open",
      presentation,
      commandId: command.id,
      checkoutUrl: null,
      sessionId: session.id,
      uiMode: "embedded",
      clientSecret: secret,
      publishableKey: requireCheckoutPublishableKey(contract.expectedLivemode, env),
      amountDueCents: amount,
      currency: "usd",
      // The v1 catalog admits only one-month recurring prices (subscription-catalog plan schema).
      interval: "month",
      expiresAt,
    };
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
  if (presentation === "shared")
    return {
      status: "open",
      presentation,
      commandId: command.id,
      checkoutUrl: session.url,
      expiresAt,
    };
  return { status: "open", commandId: command.id, checkoutUrl: session.url };
}

function commandPresentation(
  command: BillingSubscriptionCommand,
): SubscriptionCheckoutPresentation {
  return checkoutPresentation(readCheckoutContract(command));
}

/** Server-owned return origins; a client never supplies a return URL. */
function httpsOrigin(value: string | undefined, missing: string, invalid: string): string {
  if (!value) unavailable(missing);
  if (!URL.canParse(value)) unavailable(invalid);
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password) unavailable(invalid);
  return origin.origin;
}

function returnParams(
  presentation: SubscriptionCheckoutPresentation,
  env: NodeJS.ProcessEnv,
):
  | { ui_mode: "embedded"; redirect_on_completion: "never" }
  | { success_url: string; cancel_url: string } {
  if (presentation === "embedded") return { ui_mode: "embedded", redirect_on_completion: "never" };
  if (presentation === "shared") {
    const api = httpsOrigin(env.NEXT_PUBLIC_API_URL, "missing_api_origin", "invalid_api_origin");
    return {
      success_url: sharedCheckoutReturnUrl(api, "paid"),
      cancel_url: sharedCheckoutReturnUrl(api, "canceled"),
    };
  }
  const app = httpsOrigin(env.NEXT_PUBLIC_APP_URL, "missing_app_origin", "invalid_app_origin");
  return {
    success_url: `${app}/cloud/billing?subscription_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${app}${SUBSCRIPTION_CHECKOUT_CANCEL_PATH}`,
  };
}

function classify(command: BillingSubscriptionCommand): PendingCheckoutSettlement {
  if (command.status === "APPLIED") return "completed";
  return isRetired(command) ? "settled" : "pending";
}

/**
 * Closes a pending checkout so it can no longer be paid, confirming the outcome
 * with Stripe. A session that completed is reconciled (never discarded) and
 * reported as `completed`; callers must not start another purchase after that.
 */
async function settlePendingCheckout(
  stripe: Stripe,
  env: NodeJS.ProcessEnv,
  command: BillingSubscriptionCommand,
  errorCode: string,
  options: { expireOpen: boolean; createIfMissing: boolean; reauthorize?: Reauthorize },
): Promise<PendingCheckoutSettlement> {
  // PREPARED never reached the provider; the CAS makes a concurrent dispatch lose.
  if (command.status === "PREPARED") return classify(await retireCommand(command, errorCode));
  if (command.status !== "OUTCOME_UNKNOWN") return classify(command);
  const contract = readCheckoutContract(command);
  const account = await stripe.accounts.retrieve(null);
  assertCheckoutProviderAuthority(contract, account.id, env);
  const customerId = contract.params.customer;
  let session = await findCheckoutSession(stripe, customerId, command.id);
  if (!session) {
    const disposition = noSessionDisposition(command, contract, Date.now());
    if (disposition === "fail") return classify(await retireCommand(command, errorCode));
    if (disposition === "wait" || !options.createIfMissing) return "pending";
    // Materialize the one session this key may ever create, so it can be closed deterministically.
    await options.reauthorize?.();
    session = await stripe.checkout.sessions.create(contract.params, {
      idempotencyKey: command.provider_idempotency_key,
    });
  }
  let parsed = assertSessionIdentity(session, command, customerId);
  if (parsed.status === "open" && options.expireOpen) {
    try {
      session = await stripe.checkout.sessions.expire(session.id);
    } catch (error) {
      // error-policy:J2 Stripe refuses to expire a session that just completed or expired;
      // the fresh retrieval below is the only authority for which one happened.
      logger.warn("[SubscriptionCheckout] Checkout expiry refused; re-reading session", {
        organizationId: command.organization_id,
        commandId: command.id,
        code: error instanceof Error && "code" in error ? String(error.code) : "unknown",
      });
      session = await stripe.checkout.sessions.retrieve(session.id);
    }
    parsed = assertSessionIdentity(session, command, customerId);
  }
  if (parsed.status === "expired") return classify(await retireCommand(command, errorCode));
  if (parsed.status === "complete") {
    await reconcileSubscriptionCheckout(session.id, command.organization_id);
    return "completed";
  }
  return "pending";
}

export async function submitSubscriptionCheckout(
  input: {
    organizationId: string;
    actorId: string;
    planKey: SubscriptionPlanKey;
    idempotencyKey: string;
    /** Defaults to `hosted`, the original browser-redirect checkout. */
    presentation?: SubscriptionCheckoutPresentation;
  },
  reauthorize: Reauthorize,
): Promise<SubscriptionCheckoutResult> {
  const stripe = requireStripe();
  const env = getCloudAwareEnv();
  const presentation = input.presentation ?? "hosted";
  const returns = returnParams(presentation, env);
  // Fail before any provider write when the app could never mount the form.
  if (presentation === "embedded") requireCheckoutPublishableKey(isProductionDeployment(env), env);
  const requestDigest = createHash("sha256")
    .update(
      JSON.stringify([
        input.organizationId,
        input.actorId,
        input.planKey,
        "v1",
        // Hosted digests keep their original shape.
        ...("success_url" in returns ? [new URL(returns.success_url).origin] : []),
        ...(presentation === "hosted" ? [] : [presentation]),
      ]),
    )
    .digest("hex");
  const providerKey = `eliza-subscription-${createHash("sha256").update(`${input.organizationId}:${input.idempotencyKey}`).digest("hex")}`;
  await reauthorize();
  const replay = await operations.findCommandByIdempotencyKey(
    input.organizationId,
    input.idempotencyKey,
  );
  if (replay) {
    if (
      replay.kind !== "checkout" ||
      replay.requested_by_user_id !== input.actorId ||
      replay.target_plan_key !== input.planKey ||
      (replay.checkout_contract !== null && commandPresentation(replay) !== presentation)
    )
      rejected("checkout_replay_mismatch");
    return driveCheckout(stripe, env, replay, reauthorize);
  }
  const pending = await operations.findPendingCheckout(input.organizationId);
  if (pending) {
    const samePlan = pending.target_plan_key === input.planKey;
    if (samePlan && commandPresentation(pending) === presentation) {
      // Resume the organization's single pending checkout across devices and keys.
      const resumed = await driveCheckout(stripe, env, pending, reauthorize);
      if (resumed.status !== "expired") return resumed;
    } else {
      // Switching plan or who pays closes the old payable session first, so a shared link
      // and an in-app form can never both charge for this organization.
      const settled = await settlePendingCheckout(
        stripe,
        env,
        pending,
        samePlan
          ? "CHECKOUT_SUPERSEDED_BY_PRESENTATION_CHANGE"
          : "CHECKOUT_SUPERSEDED_BY_PLAN_CHANGE",
        { expireOpen: true, createIfMissing: true, reauthorize },
      );
      if (settled === "completed") rejected("previous_checkout_completed");
      if (settled === "pending") unavailable("previous_checkout_unsettled");
    }
  }
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
    ...(presentation === "hosted" ? {} : { presentation }),
    params: {
      mode: "subscription",
      currency: "usd",
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
      ...returns,
      expires_at: Math.floor((createdAt.getTime() + CHECKOUT_SESSION_TTL_MS) / 1000),
    },
  });
  const command = (
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
  return driveCheckout(stripe, env, command, reauthorize);
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
    rejected("checkout_account_mismatch");
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
  try {
    return await finalizeSubscriptionCheckout({
      providerAccountId: account.id,
      session,
      invoice,
      subscription,
      customer,
      paymentIntent,
      charge,
    });
  } catch (error) {
    if (
      error instanceof ElizaError &&
      error.code === "SUBSCRIPTION_RENEWAL_UNAVAILABLE" &&
      error.context?.reason === "checkout_organization_fenced"
    ) {
      // error-policy:J2 A captured first payment whose organization lost paid authority is kept
      // pending (a canceled deletion can still publish it) and surfaced for manual refund review.
      // Refunds are an operator decision; this path never refunds or discards the payment.
      logger.error("[SubscriptionCheckout] Captured checkout payment has no entitlement", {
        alert: "subscription_paid_checkout_unentitled",
        organizationId: command.organization_id,
        commandId: command.id,
        commandStatus: command.status,
        checkoutSessionId: parsed.id,
        stripeSubscriptionId: parsed.subscription,
      });
    }
    throw error;
  }
}

/**
 * Best-effort closing of every payable checkout for an organization that just lost paid
 * authority (e.g. account deletion). Each failure is logged; the recovery sweep retries.
 */
export async function expirePendingSubscriptionCheckoutsForOrganization(
  organizationId: string,
  errorCode = "CHECKOUT_ORGANIZATION_FENCED",
): Promise<{ inspected: number; settled: number; completed: number; pending: number }> {
  const result = { inspected: 0, settled: 0, completed: 0, pending: 0 };
  const commands = await recovery.listPendingCheckoutsForOrganization(organizationId);
  if (commands.length === 0) return result;
  const stripe = requireStripe();
  const env = getCloudAwareEnv();
  for (const command of commands) {
    result.inspected++;
    try {
      const outcome = await settlePendingCheckout(stripe, env, command, errorCode, {
        expireOpen: true,
        createIfMissing: false,
      });
      result[outcome]++;
    } catch (error) {
      // error-policy:J4 Fencing must not fail on provider availability; the sweep retries.
      logger.error("[SubscriptionCheckout] Could not close checkout for fenced organization", {
        organizationId,
        commandId: command.id,
        code: error instanceof ElizaError ? error.code : "SUBSCRIPTION_CHECKOUT_SETTLE_FAILED",
        reason: error instanceof ElizaError ? error.context?.reason : undefined,
      });
      result.pending++;
    }
  }
  return result;
}

/**
 * Settles org checkouts that reached their provider expiry (observed, never forced) and closes
 * payable sessions for fenced organizations. Completed sessions are reconciled, not discarded.
 */
export async function recoverStaleSubscriptionCheckouts(limit = 10): Promise<{
  inspected: number;
  settled: number;
  completed: number;
  pending: number;
  unavailable: number;
}> {
  const result = { inspected: 0, settled: 0, completed: 0, pending: 0, unavailable: 0 };
  const candidates = await recovery.listStalePendingCheckouts(
    new Date(Date.now() - PROVIDER_RETRY_WINDOW_MS),
    limit,
  );
  if (candidates.length === 0) return result;
  const stripe = requireStripe();
  const env = getCloudAwareEnv();
  for (const { command, organizationFenced } of candidates) {
    result.inspected++;
    try {
      const outcome = await settlePendingCheckout(stripe, env, command, "CHECKOUT_EXPIRED", {
        expireOpen: organizationFenced,
        createIfMissing: false,
      });
      result[outcome]++;
      if (outcome === "pending") await recovery.rotateCheckoutRecovery(command);
    } catch (error) {
      // error-policy:J4 One unverifiable checkout must not starve the others; it is rotated.
      logger.warn("[SubscriptionCheckout] Stale checkout recovery unavailable", {
        organizationId: command.organization_id,
        commandId: command.id,
        code: error instanceof ElizaError ? error.code : "SUBSCRIPTION_CHECKOUT_RECOVERY_FAILED",
        reason: error instanceof ElizaError ? error.context?.reason : undefined,
      });
      result.unavailable++;
      await recovery.rotateCheckoutRecovery(command);
    }
  }
  return result;
}

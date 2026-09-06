/**
 * Executes scoped Stripe operations for durable billing commands and validates Acacia wire data.
 * This adapter never grants access or writes a ledger; callers finalize observations under their
 * database generation fence. Provider timeouts remain ambiguous and retain the original intent.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { z } from "zod";
import {
  type BillingProviderBindingResolver,
  type BillingProviderCheckout,
  type BillingProviderCreationDiscovery,
  type BillingProviderCustomer,
  type BillingProviderEvent,
  type BillingProviderInvoice,
  type BillingProviderInvoicePreview,
  type BillingProviderMerchant,
  type BillingProviderObservation,
  type BillingProviderPaymentMethodCheckout,
  type BillingProviderPlan,
  type BillingProviderResumePaymentInput,
  type BillingProviderResumePaymentInspection,
  type BillingProviderScope,
  type BillingProviderSubscription,
  type BillingProviderTrialClaim,
  type BillingProviderUpdatePreview,
  type BillingProviderUpdateRequest,
  type DurableProviderIntent,
  GENERIC_BILLING_STRIPE_API_VERSION,
} from "./generic-billing-provider-types";

import { settlementDigest } from "./settlement-digest";

export type * from "./generic-billing-provider-types";
export { GENERIC_BILLING_STRIPE_API_VERSION } from "./generic-billing-provider-types";

const id = z.string().min(1);
const seconds = z.number().int().nonnegative().safe();
const money = z.number().int().safe();
const metadata = z.record(z.string(), z.string());
const expandableId = z
  .union([id, z.object({ id })])
  .transform((value) => (typeof value === "string" ? value : value.id));
const customerSchema = z.object({
  id,
  object: z.literal("customer"),
  livemode: z.boolean(),
  metadata,
});
const priceSchema = z.object({
  id,
  object: z.literal("price"),
  active: z.boolean(),
  livemode: z.boolean(),
  product: expandableId,
  currency: z.string(),
  unit_amount: money.nullable(),
  type: z.literal("recurring"),
  billing_scheme: z.literal("per_unit"),
  transform_quantity: z.null(),
  recurring: z.object({
    interval: z.enum(["day", "week", "month", "year"]),
    interval_count: z.number().int().positive(),
    usage_type: z.literal("licensed"),
    trial_period_days: z.null(),
  }),
});
const subscriptionSchema = z.object({
  id,
  object: z.literal("subscription"),
  customer: expandableId,
  livemode: z.boolean(),
  metadata,
  status: z.enum([
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
  ]),
  current_period_start: seconds,
  current_period_end: seconds,
  trial_start: seconds.nullable(),
  trial_end: seconds.nullable(),
  cancel_at_period_end: z.boolean(),
  canceled_at: seconds.nullable(),
  ended_at: seconds.nullable(),
  latest_invoice: expandableId.nullable(),
  pending_update: z.object({}).passthrough().nullable(),
  items: z.object({
    has_more: z.literal(false),
    data: z
      .array(z.object({ id, quantity: z.number().int().positive().safe(), price: priceSchema }))
      .length(1),
  }),
});
const checkoutSchema = z.object({
  id,
  object: z.literal("checkout.session"),
  mode: z.literal("subscription"),
  invoice: expandableId.nullable(),
  customer: expandableId,
  subscription: expandableId.nullable(),
  livemode: z.boolean(),
  metadata,
  status: z.enum(["open", "complete", "expired"]),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  url: z.string().url().nullable(),
  expires_at: seconds,
});
const paymentMethodCheckoutSchema = z.object({
  id,
  object: z.literal("checkout.session"),
  mode: z.literal("setup"),
  customer: expandableId,
  livemode: z.boolean(),
  metadata,
  status: z.enum(["open", "complete", "expired"]),
  url: z.string().url().nullable(),
  expires_at: seconds,
  setup_intent: expandableId.nullable(),
});
const invoiceLineSchema = z.object({
  id,
  type: z.enum(["subscription", "invoiceitem"]),
  subscription: expandableId.nullable().optional(),
  subscription_item: expandableId.nullable().optional(),
  price: z.object({ id }).nullable(),
  quantity: z.number().int().nonnegative().safe().nullable(),
  amount: money,
  discount_amounts: z.array(z.object({ amount: money.nonnegative() })),
  tax_amounts: z.array(z.object({ amount: money })),
  period: z.object({ start: seconds, end: seconds }),
  proration: z.boolean(),
});
const invoiceSchema = z.object({
  hosted_invoice_url: z.string().url().nullable(),
  id,
  object: z.literal("invoice"),
  livemode: z.boolean(),
  customer: expandableId,
  subscription: expandableId,
  charge: expandableId.nullable(),
  payment_intent: expandableId.nullable(),
  status: z.enum(["draft", "open", "paid", "uncollectible", "void"]).nullable(),
  paid: z.boolean(),
  paid_out_of_band: z.boolean(),
  amount_paid: money.nonnegative(),
  amount_due: money.nonnegative(),
  billing_reason: z.string(),
  subtotal: money,
  subtotal_excluding_tax: money.nullable(),
  total: money,
  tax: money.nullable(),
  total_discount_amounts: z.array(z.object({ amount: money.nonnegative() })),
  currency: z.string(),
  period_start: seconds,
  period_end: seconds,
});
const planSchema = z.object({
  planRevisionId: id,
  priceId: z.string().startsWith("price_"),
  productId: z.string().startsWith("prod_"),
  amountCents: money.nonnegative(),
  currency: z.string().regex(/^[a-z]{3}$/),
  interval: z.enum(["day", "week", "month", "year"]),
  intervalCount: z.number().int().positive(),
  minimumQuantity: z.number().int().positive().safe(),
  maximumQuantity: z.number().int().positive().safe(),
  trialDays: z.literal(7),
});

function fail(code: string, message: string): never {
  throw new ElizaError(message, { code: `BILLING_PROVIDER_${code}` });
}
function requireValue(condition: boolean, code: string, message: string): void {
  if (!condition) fail(code, message);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    fail("WIRE_SHAPE", "Stripe response does not satisfy the pinned Acacia billing contract");
  return result.data;
}
function requireProviderJson(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const child of value) requireProviderJson(child);
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const child of Object.values(value)) requireProviderJson(child);
    return;
  }
  fail("DIGEST", "Provider observation contains an unavailable or non-JSON value");
}
function digest(value: unknown): string {
  // Settlement canonicalization owns locale-independent ordering; provider data must not omit undefined.
  requireProviderJson(value);
  return settlementDigest(value);
}

function reviewDigest(preview: BillingProviderUpdatePreview): string {
  const stableInvoice = (invoice: BillingProviderInvoicePreview | null) =>
    invoice === null
      ? null
      : {
          ...invoice,
          lines: invoice.lines.map(({ lineId: _providerGeneratedLineId, ...line }) => line),
        };
  return digest({
    ...preview,
    nextInvoice: stableInvoice(preview.nextInvoice),
    recurringInvoice: stableInvoice(preview.recurringInvoice),
  });
}

function projectInvoiceLine(
  line: z.infer<typeof invoiceLineSchema>,
): BillingProviderInvoice["lines"][number] {
  return {
    lineId: line.id,
    lineType: line.type,
    subscriptionId: line.subscription ?? null,
    subscriptionItemId: line.subscription_item ?? null,
    priceId: line.price?.id ?? null,
    discountAmountsCents: line.discount_amounts.map((entry) => entry.amount),
    taxAmountsCents: line.tax_amounts.map((entry) => entry.amount),
    quantity: line.quantity,
    amountCents: line.amount,
    periodStart: line.period.start,
    periodEnd: line.period.end,
    proration: line.proration,
  };
}

function validateTrialClaim(claim: BillingProviderTrialClaim): void {
  parse(z.object({ startsAt: seconds, endsAt: seconds }), claim);
  requireValue(
    claim.endsAt - claim.startsAt === 7 * 86400,
    "TRIAL_CLAIM",
    "Trial claim must retain exactly seven days from its original UTC start",
  );
}

/**
 * Production reads require a durable binding resolver; metadata-only mode supports creation fixtures.
 * Supplying the existing SDK client does not change its global API configuration.
 */
export function createGenericBillingProvider(
  stripe: Stripe,
  merchant: BillingProviderMerchant,
  bindings?: BillingProviderBindingResolver,
) {
  parse(
    z.object({
      merchantId: id,
      kind: z.enum(["platform", "connected"]),
      stripeAccountId: z.string().regex(/^acct_[A-Za-z0-9]+$/),
      livemode: z.boolean(),
    }),
    merchant,
  );
  const options = (intent?: DurableProviderIntent): Stripe.RequestOptions => {
    if (intent)
      parse(
        z.object({
          commandId: id,
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/),
          requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
        }),
        intent,
      );
    return {
      apiVersion: GENERIC_BILLING_STRIPE_API_VERSION,
      stripeAccount: merchant.stripeAccountId,
      ...(intent ? { idempotencyKey: intent.idempotencyKey } : {}),
    };
  };
  let credentialMode: Promise<void> | undefined;
  const ensureCredentialMode = () =>
    (credentialMode ??= (async () => {
      const balance = parse(
        z.object({ livemode: z.boolean() }),
        await stripe.balance.retrieve({}, options()),
      );
      requireValue(
        balance.livemode === merchant.livemode,
        "MODE",
        "Stripe credential does not match the stored merchant environment",
      );
    })());
  const tags = (scope: BillingProviderScope) => {
    parse(z.object({ scopeId: id, appId: id, billingAccountId: id }), scope);
    return {
      eliza_billing_scope_id: scope.scopeId,
      eliza_app_id: scope.appId,
      eliza_billing_account_id: scope.billingAccountId,
      eliza_merchant_id: merchant.merchantId,
    };
  };
  const owned = async (
    scope: BillingProviderScope,
    object: { id: string; object: string; livemode: boolean; metadata: Record<string, string> },
    persisted = false,
  ) => {
    requireValue(
      object.livemode === merchant.livemode,
      "MODE",
      "Stripe object belongs to a different billing environment",
    );
    const customerObject = object.object === "customer";
    let bound = false;
    if (persisted && bindings) {
      const objectType = parse(
        z.enum(["customer", "subscription", "checkout.session"]),
        object.object,
      );
      const binding = await bindings.resolveBinding({
        objectType,
        objectId: object.id,
        merchantId: merchant.merchantId,
        providerAccountId: merchant.stripeAccountId,
        livemode: merchant.livemode,
      });
      requireValue(
        binding !== null &&
          binding.appId === scope.appId &&
          binding.billingAccountId === scope.billingAccountId &&
          (customerObject || binding.scopeId === scope.scopeId),
        "BINDING",
        "Provider object has no matching durable ownership binding",
      );
      bound = true;
    }
    const expected = tags(scope);
    const entries = Object.entries(expected).filter(
      ([key]) => !customerObject || key !== "eliza_billing_scope_id",
    );
    requireValue(
      entries.every(
        ([key, value]) =>
          object.metadata[key] === value || (bound && object.metadata[key] === undefined),
      ),
      "SCOPE",
      "Stripe object metadata contradicts or cannot establish its stored billing ownership",
    );
  };
  const observation = <T>(
    value: T,
    input: unknown,
    intent?: DurableProviderIntent,
  ): BillingProviderObservation<T> => ({
    value,
    digest: digest(value),
    inputDigest: intent ? intent.requestDigest : digest(input),
    apiVersion: GENERIC_BILLING_STRIPE_API_VERSION,
    merchantId: merchant.merchantId,
    providerAccountId: merchant.stripeAccountId,
    livemode: merchant.livemode,
    observedAt: new Date().toISOString(),
  });
  const customer = async (scope: BillingProviderScope, customerId: string) => {
    await ensureCredentialMode();
    const value = parse(customerSchema, await stripe.customers.retrieve(customerId, {}, options()));
    await owned(scope, value, true);
    requireValue(value.id === customerId, "IDENTITY", "Stripe returned a different customer");
    return value;
  };
  const checkPlan = (price: z.infer<typeof priceSchema>, plan: BillingProviderPlan) => {
    parse(planSchema, plan);
    requireValue(
      plan.minimumQuantity <= plan.maximumQuantity,
      "CATALOG",
      "Plan quantity bounds are invalid",
    );
    requireValue(
      price.livemode === merchant.livemode &&
        price.id === plan.priceId &&
        price.product === plan.productId &&
        price.currency === plan.currency &&
        price.unit_amount === plan.amountCents &&
        price.recurring.interval === plan.interval &&
        price.recurring.interval_count === plan.intervalCount,
      "CATALOG",
      "Stripe price does not match the immutable merchant catalog binding",
    );
  };
  const verifyPlan = async (plan: BillingProviderPlan) => {
    await ensureCredentialMode();
    parse(planSchema, plan);
    const [price, product] = await Promise.all([
      stripe.prices
        .retrieve(plan.priceId, {}, options())
        .then((value) => parse(priceSchema, value)),
      stripe.products
        .retrieve(plan.productId, {}, options())
        .then((value) =>
          parse(z.object({ id, active: z.boolean(), livemode: z.boolean() }), value),
        ),
    ]);
    checkPlan(price, plan);
    requireValue(
      price.active &&
        product.active &&
        product.id === plan.productId &&
        product.livemode === merchant.livemode,
      "CATALOG",
      "The merchant product or price is unavailable for new sales",
    );
    return observation(plan, { operation: "verifyPlan", plan });
  };
  const checkQuantity = (quantity: number, plan: BillingProviderPlan) =>
    requireValue(
      Number.isSafeInteger(quantity) &&
        quantity >= plan.minimumQuantity &&
        quantity <= plan.maximumQuantity,
      "QUANTITY",
      "Seat quantity is outside the registered plan bounds",
    );
  const projectSubscription = async (
    scope: BillingProviderScope,
    raw: unknown,
    plan: BillingProviderPlan,
    customerId: string,
    persisted = false,
  ): Promise<BillingProviderSubscription> => {
    const value = parse(subscriptionSchema, raw);
    await owned(scope, value, persisted);
    const item = value.items.data[0];
    if (!item) fail("WIRE_SHAPE", "Subscription has no base item");
    checkPlan(item.price, plan);
    checkQuantity(item.quantity, plan);
    requireValue(
      value.customer === customerId && value.current_period_end > value.current_period_start,
      "SUBSCRIPTION",
      "Subscription customer or billing interval is invalid",
    );
    requireValue(
      (value.trial_start === null) === (value.trial_end === null) &&
        (value.trial_start === null ||
          (value.trial_end !== null && value.trial_end > value.trial_start)),
      "TRIAL",
      "Subscription trial bounds are unavailable or invalid",
    );
    requireValue(
      value.status !== "trialing" || value.trial_end !== null,
      "TRIAL",
      "Trialing subscription has no trial interval",
    );
    return {
      subscriptionId: value.id,
      customerId: value.customer,
      itemId: item.id,
      status: value.status,
      quantity: item.quantity,
      priceId: item.price.id,
      productId: item.price.product,
      currentPeriodStart: value.current_period_start,
      currentPeriodEnd: value.current_period_end,
      trialStart: value.trial_start,
      trialEnd: value.trial_end,
      cancelAtPeriodEnd: value.cancel_at_period_end,
      canceledAt: value.canceled_at,
      endedAt: value.ended_at,
      latestInvoiceId: value.latest_invoice,
      pendingUpdate: value.pending_update !== null,
    };
  };
  const retrieveSubscription = async (
    scope: BillingProviderScope,
    input: { subscriptionId: string; customerId: string; plan: BillingProviderPlan },
  ) => {
    await customer(scope, input.customerId);
    const value = await projectSubscription(
      scope,
      await stripe.subscriptions.retrieve(input.subscriptionId, {}, options()),
      input.plan,
      input.customerId,
      true,
    );
    requireValue(
      value.subscriptionId === input.subscriptionId,
      "IDENTITY",
      "Stripe returned a different subscription",
    );
    return observation(value, { operation: "retrieveSubscription", scope, input });
  };
  const completedSetupPaymentMethod = async (
    scope: BillingProviderScope,
    input: { sessionId: string; subscriptionId: string; customerId: string },
  ) => {
    const session = parse(
      paymentMethodCheckoutSchema.extend({
        status: z.literal("complete"),
        setup_intent: expandableId,
      }),
      await stripe.checkout.sessions.retrieve(input.sessionId, {}, options()),
    );
    await owned(scope, session, true);
    requireValue(
      session.id === input.sessionId &&
        session.customer === input.customerId &&
        (session.metadata.eliza_subscription_id === input.subscriptionId ||
          (Boolean(bindings) && session.metadata.eliza_subscription_id === undefined)),
      "SETUP",
      "Setup Checkout does not belong to this subscription",
    );
    const setup = parse(
      z.object({
        id,
        object: z.literal("setup_intent"),
        customer: expandableId,
        livemode: z.boolean(),
        metadata,
        status: z.literal("succeeded"),
        payment_method: expandableId,
      }),
      await stripe.setupIntents.retrieve(session.setup_intent, {}, options()),
    );
    requireValue(
      setup.livemode === merchant.livemode &&
        Object.entries(tags(scope)).every(
          ([key, expected]) =>
            setup.metadata[key] === expected ||
            (Boolean(bindings) && setup.metadata[key] === undefined),
        ),
      "SCOPE",
      "Setup intent contradicts its bound Checkout ownership",
    );
    requireValue(
      setup.id === session.setup_intent &&
        setup.customer === input.customerId &&
        (setup.metadata.eliza_subscription_id === input.subscriptionId ||
          (Boolean(bindings) && setup.metadata.eliza_subscription_id === undefined)),
      "SETUP",
      "Setup authorization does not belong to this subscription",
    );
    const method = parse(
      z.object({
        id,
        object: z.literal("payment_method"),
        customer: expandableId,
        livemode: z.boolean(),
      }),
      await stripe.paymentMethods.retrieve(setup.payment_method, {}, options()),
    );
    requireValue(
      method.id === setup.payment_method &&
        method.customer === input.customerId &&
        method.livemode === merchant.livemode,
      "SETUP",
      "Payment method is not attached to the scoped customer",
    );
    return method;
  };
  const readCheckout = async (
    scope: BillingProviderScope,
    input: { sessionId: string; customerId: string },
  ) => {
    await customer(scope, input.customerId);
    const value = parse(
      checkoutSchema,
      await stripe.checkout.sessions.retrieve(input.sessionId, {}, options()),
    );
    await owned(scope, value, true);
    requireValue(
      value.id === input.sessionId && value.customer === input.customerId,
      "CHECKOUT",
      "Checkout identity differs from the stored command binding",
    );
    const projected: BillingProviderCheckout = {
      mode: "subscription",
      invoiceId: value.invoice,
      sessionId: value.id,
      customerId: value.customer,
      subscriptionId: value.subscription,
      status: value.status,
      paymentStatus: value.payment_status,
      url: value.url,
      expiresAt: value.expires_at,
    };
    return observation(projected, { operation: "readCheckout", scope, input });
  };
  const projectPaymentMethodCheckout = async (
    scope: BillingProviderScope,
    raw: unknown,
    input: { sessionId?: string; customerId: string; subscriptionId: string },
    persisted: boolean,
  ): Promise<BillingProviderPaymentMethodCheckout> => {
    const value = parse(paymentMethodCheckoutSchema, raw);
    await owned(scope, value, persisted);
    requireValue(
      (input.sessionId === undefined || value.id === input.sessionId) &&
        value.customer === input.customerId &&
        (value.metadata.eliza_subscription_id === input.subscriptionId ||
          (persisted && Boolean(bindings) && value.metadata.eliza_subscription_id === undefined)),
      "SETUP",
      "Payment method Checkout differs from the original subscription command binding",
    );
    return {
      mode: "setup",
      sessionId: value.id,
      customerId: value.customer,
      subscriptionId: input.subscriptionId,
      status: value.status,
      url: value.url,
      expiresAt: value.expires_at,
      setupIntentId: value.setup_intent,
    };
  };
  const readPaymentMethodCheckout = async (
    scope: BillingProviderScope,
    input: {
      sessionId: string;
      customerId: string;
      subscriptionId: string;
      plan: BillingProviderPlan;
    },
  ) => {
    await retrieveSubscription(scope, input);
    const value = await projectPaymentMethodCheckout(
      scope,
      await stripe.checkout.sessions.retrieve(input.sessionId, {}, options()),
      input,
      true,
    );
    return observation(value, { operation: "readPaymentMethodCheckout", scope, input });
  };
  const returnUrl = (url: string) => {
    const parsed = parse(z.string().url(), url);
    requireValue(
      new URL(parsed).protocol === "https:",
      "RETURN_URL",
      "Billing return URLs must use HTTPS and come from the trusted app registration",
    );
    return parsed;
  };
  const prepareUpdate = async (
    scope: BillingProviderScope,
    input: BillingProviderUpdateRequest,
  ) => {
    const current = await retrieveSubscription(scope, { ...input, plan: input.currentPlan });
    await verifyPlan(input.targetPlan);
    checkQuantity(input.quantity, input.targetPlan);
    requireValue(
      Number.isSafeInteger(input.minimumSeats) &&
        input.minimumSeats >= 0 &&
        input.quantity >= input.minimumSeats,
      "QUANTITY",
      "Requested seats are below the authoritative occupied seat count",
    );
    requireValue(
      ["active", "trialing"].includes(current.value.status) &&
        !current.value.pendingUpdate &&
        !current.value.cancelAtPeriodEnd,
      "UPDATE",
      "Subscription is not eligible for an immediate plan update",
    );
    requireValue(
      current.value.priceId !== input.targetPlan.priceId ||
        current.value.quantity !== input.quantity,
      "UPDATE_NO_CHANGE",
      "Selected plan and quantity already match this subscription",
    );
    parse(seconds, input.prorationDate);
    requireValue(
      input.prorationDate >= current.value.currentPeriodStart &&
        input.prorationDate < current.value.currentPeriodEnd,
      "QUOTE_EXPIRED",
      "Review timestamp is outside the current subscription period",
    );
    requireValue(
      input.currentPlan.currency === input.targetPlan.currency,
      "CURRENCY",
      "A subscription update cannot change billing currency",
    );
    return current;
  };
  const previewSubscriptionUpdate = async (
    scope: BillingProviderScope,
    input: BillingProviderUpdateRequest,
  ) => {
    const current = await prepareUpdate(scope, input);
    const trial = current.value.status === "trialing";
    const invoicePreview = async (recurring: boolean): Promise<BillingProviderInvoicePreview> => {
      const raw = await stripe.invoices.createPreview(
        {
          customer: input.customerId,
          subscription: input.subscriptionId,
          preview_mode: recurring ? "recurring" : "next",
          subscription_details: {
            items: [
              {
                id: current.value.itemId,
                price: input.targetPlan.priceId,
                quantity: input.quantity,
              },
            ],
            ...(!recurring
              ? trial
                ? {
                    proration_behavior: "none" as const,
                    ...(current.value.trialEnd !== null
                      ? { trial_end: current.value.trialEnd }
                      : {}),
                  }
                : {
                    proration_behavior: "always_invoice" as const,
                    proration_date: input.prorationDate,
                  }
              : {}),
          },
        },
        options(),
      );
      const value = parse(
        invoiceSchema.extend({
          automatic_tax: z.object({ enabled: z.boolean(), status: z.string().nullable() }),
          lines: z.object({ has_more: z.boolean(), data: z.array(invoiceLineSchema) }),
        }),
        raw,
      );
      requireValue(
        value.livemode === merchant.livemode &&
          value.customer === input.customerId &&
          value.subscription === input.subscriptionId &&
          value.currency === input.targetPlan.currency,
        "PREVIEW_SCOPE",
        "Invoice preview differs from the stored customer, subscription or merchant",
      );
      requireValue(
        !value.lines.has_more,
        "PREVIEW_INCOMPLETE",
        "Provider preview contains additional lines; a complete review is required before confirmation",
      );
      requireValue(
        !value.automatic_tax.enabled || value.automatic_tax.status === "complete",
        "PREVIEW_TAX",
        "Invoice tax calculation is incomplete; update billing address and review again",
      );
      requireValue(
        value.lines.data.every(
          (line) => !line.subscription || line.subscription === input.subscriptionId,
        ),
        "INVOICE_LINE_SCOPE",
        "Preview includes a line from another subscription",
      );
      return {
        currency: value.currency,
        amountDueCents: value.amount_due,
        subtotalCents: value.subtotal,
        totalCents: value.total,
        taxCents: value.tax,
        discountCents: parse(
          money.nonnegative(),
          value.total_discount_amounts.reduce((sum, entry) => sum + entry.amount, 0),
        ),
        prorationCents: parse(
          money,
          value.lines.data
            .filter((line) => line.proration && line.period.start === input.prorationDate)
            .reduce((sum, line) => sum + line.amount, 0),
        ),
        lines: value.lines.data.map(projectInvoiceLine),
      };
    };
    const nextInvoice = await invoicePreview(false);
    const recurringInvoice = trial ? null : await invoicePreview(true);
    const value: BillingProviderUpdatePreview = {
      requestDigest: digest({ scope, merchant, input }),
      subscriptionDigest: current.digest,
      prorationDate: input.prorationDate,
      trialEnd: current.value.trialEnd,
      dueNowCents: trial ? 0 : nextInvoice.amountDueCents,
      nextInvoice,
      recurringInvoice,
      recurringBasis: trial ? "trial_renewal" : "long_term",
    };
    return observation(value, { operation: "previewSubscriptionUpdate", scope, input });
  };
  return {
    verifyPlan,
    previewSubscriptionUpdate,
    async verifyMerchant() {
      await ensureCredentialMode();
      const account = parse(
        z.object({
          id,
          charges_enabled: z.boolean(),
          payouts_enabled: z.boolean(),
          details_submitted: z.boolean(),
          capabilities: z.object({
            card_payments: z.string().optional(),
            transfers: z.string().optional(),
          }),
          requirements: z.object({
            disabled_reason: z.string().nullable(),
            currently_due: z.array(z.string()),
          }),
        }),
        await stripe.accounts.retrieve(
          merchant.stripeAccountId,
          {},
          {
            apiVersion: GENERIC_BILLING_STRIPE_API_VERSION,
          },
        ),
      );
      requireValue(
        account.id === merchant.stripeAccountId,
        "MERCHANT",
        "Stripe returned a different merchant account",
      );
      return observation(
        {
          accountId: account.id,
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          detailsSubmitted: account.details_submitted,
          cardPaymentsActive: account.capabilities.card_payments === "active",
          disabledReason: account.requirements.disabled_reason,
          requirementsDue: account.requirements.currently_due,
        },
        { operation: "verifyMerchant", merchant },
      );
    },
    async createCustomer(scope: BillingProviderScope, intent: DurableProviderIntent) {
      await ensureCredentialMode();
      const value = parse(
        customerSchema,
        await stripe.customers.create(
          {
            metadata: {
              ...tags(scope),
              eliza_command_id: intent.commandId,
              eliza_request_digest: intent.requestDigest,
            },
          },
          options(intent),
        ),
      );
      await owned(scope, value);
      return observation<BillingProviderCustomer>({ customerId: value.id }, scope, intent);
    },
    /** Observes a retained customer binding, including Stripe's explicit deletion tombstone. This grants no cleanup or erasure authority. */
    async inspectBoundCustomer(scope: BillingProviderScope, customerId: string) {
      tags(scope);
      parse(z.string().regex(/^cus_[A-Za-z0-9]+$/), customerId);
      if (!bindings) fail("BINDING", "Customer lifecycle observation requires durable ownership");
      const binding = await bindings.resolveBinding({
        objectType: "customer",
        objectId: customerId,
        merchantId: merchant.merchantId,
        providerAccountId: merchant.stripeAccountId,
        livemode: merchant.livemode,
      });
      requireValue(
        binding !== null &&
          binding.appId === scope.appId &&
          binding.billingAccountId === scope.billingAccountId,
        "BINDING",
        "Customer lifecycle observation has no matching durable ownership binding",
      );
      await ensureCredentialMode();
      const raw = await stripe.customers.retrieve(customerId, {}, options());
      const identity = parse(
        z.object({ id, object: z.literal("customer"), deleted: z.boolean().optional() }),
        raw,
      );
      requireValue(
        identity.id === customerId,
        "SCOPE",
        "Customer lifecycle response differs from the bound customer",
      );
      if (identity.deleted === true) {
        parse(z.strictObject({ id, object: z.literal("customer"), deleted: z.literal(true) }), raw);
        return observation(
          { customerId, status: "deleted" as const },
          { operation: "inspectBoundCustomer", scope, customerId },
        );
      }
      await owned(scope, parse(customerSchema, raw), true);
      return observation(
        { customerId, status: "present" as const },
        { operation: "inspectBoundCustomer", scope, customerId },
      );
    },
    async retrieveCustomer(scope: BillingProviderScope, customerId: string) {
      const value = await customer(scope, customerId);
      return observation<BillingProviderCustomer>(
        { customerId: value.id },
        { operation: "retrieveCustomer", scope, customerId },
      );
    },
    async discoverCreatedCustomer(scope: BillingProviderScope, intent: DurableProviderIntent) {
      await ensureCredentialMode();
      options(intent);
      const candidates: BillingProviderCustomer[] = [];
      for await (const raw of stripe.customers.list({ limit: 100 }, options())) {
        const value = parse(customerSchema, raw);
        if (value.metadata.eliza_command_id !== intent.commandId) continue;
        await owned(scope, value);
        requireValue(
          value.metadata.eliza_request_digest === intent.requestDigest,
          "DISCOVERY_CONFLICT",
          "Customer candidate contradicts the original durable command",
        );
        candidates.push({ customerId: value.id });
      }
      requireValue(
        candidates.length <= 1,
        "DISCOVERY_CONFLICT",
        "Multiple provider customers match the same durable creation intent",
      );
      const object = candidates[0];
      return observation<BillingProviderCreationDiscovery<BillingProviderCustomer>>(
        object ? { status: "found", object } : { status: "not_observed" },
        scope,
        intent,
      );
    },
    async discoverCreatedSubscription(
      scope: BillingProviderScope,
      input: {
        customerId: string;
        plan: BillingProviderPlan;
        quantity: number;
        trialClaim: BillingProviderTrialClaim;
      },
      intent: DurableProviderIntent,
    ) {
      await customer(scope, input.customerId);
      options(intent);
      validateTrialClaim(input.trialClaim);
      checkQuantity(input.quantity, input.plan);
      const candidates: BillingProviderSubscription[] = [];
      for await (const raw of stripe.subscriptions.list(
        { customer: input.customerId, status: "all", limit: 100 },
        options(),
      )) {
        const lookup = parse(z.object({ metadata }), raw);
        if (lookup.metadata.eliza_command_id !== intent.commandId) continue;
        requireValue(
          lookup.metadata.eliza_request_digest === intent.requestDigest &&
            lookup.metadata.eliza_plan_revision_id === input.plan.planRevisionId,
          "DISCOVERY_CONFLICT",
          "Subscription candidate contradicts the original durable command",
        );
        const value = await projectSubscription(scope, raw, input.plan, input.customerId);
        requireValue(
          value.quantity === input.quantity &&
            value.trialEnd === input.trialClaim.endsAt &&
            value.trialStart !== null &&
            value.trialStart >= input.trialClaim.startsAt,
          "DISCOVERY_CONFLICT",
          "Subscription candidate differs from the originally claimed trial or quantity",
        );
        candidates.push(value);
      }
      requireValue(
        candidates.length <= 1,
        "DISCOVERY_CONFLICT",
        "Multiple subscriptions match the same durable creation intent",
      );
      const object = candidates[0];
      return observation<BillingProviderCreationDiscovery<BillingProviderSubscription>>(
        object ? { status: "found", object } : { status: "not_observed" },
        input,
        intent,
      );
    },
    async startTrial(
      scope: BillingProviderScope,
      input: {
        customerId: string;
        plan: BillingProviderPlan;
        quantity: number;
        trialClaim: BillingProviderTrialClaim;
      },
      intent: DurableProviderIntent,
    ) {
      await customer(scope, input.customerId);
      await verifyPlan(input.plan);
      checkQuantity(input.quantity, input.plan);
      validateTrialClaim(input.trialClaim);
      const raw = await stripe.subscriptions.create(
        {
          customer: input.customerId,
          items: [{ price: input.plan.priceId, quantity: input.quantity }],
          trial_end: input.trialClaim.endsAt,
          trial_settings: { end_behavior: { missing_payment_method: "pause" } },
          payment_behavior: "default_incomplete",
          metadata: {
            ...tags(scope),
            eliza_command_id: intent.commandId,
            eliza_request_digest: intent.requestDigest,
            eliza_plan_revision_id: input.plan.planRevisionId,
          },
        },
        options(intent),
      );
      const value = await projectSubscription(scope, raw, input.plan, input.customerId);
      requireValue(
        value.status === "trialing" &&
          value.trialStart !== null &&
          value.trialEnd !== null &&
          value.trialEnd === input.trialClaim.endsAt &&
          value.trialStart >= input.trialClaim.startsAt,
        "TRIAL",
        "Provider did not return the authorized seven-day trial",
      );
      return observation(value, input, intent);
    },
    async createCheckout(
      scope: BillingProviderScope,
      input: {
        customerId: string;
        plan: BillingProviderPlan;
        quantity: number;
        successUrl: string;
        cancelUrl: string;
        trial: boolean;
        trialClaim?: BillingProviderTrialClaim;
      },
      intent: DurableProviderIntent,
    ) {
      await customer(scope, input.customerId);
      await verifyPlan(input.plan);
      checkQuantity(input.quantity, input.plan);
      if (input.trial) {
        if (!input.trialClaim)
          fail("TRIAL_CLAIM", "Trial checkout requires the original durable claim interval");
        validateTrialClaim(input.trialClaim);
      }
      const value = parse(
        checkoutSchema,
        await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer: input.customerId,
            line_items: [{ price: input.plan.priceId, quantity: input.quantity }],
            success_url: returnUrl(input.successUrl),
            cancel_url: returnUrl(input.cancelUrl),
            metadata: {
              ...tags(scope),
              eliza_command_id: intent.commandId,
              eliza_request_digest: intent.requestDigest,
              eliza_plan_revision_id: input.plan.planRevisionId,
              eliza_trial_end: input.trial ? String(input.trialClaim?.endsAt) : "none",
              eliza_trial_start: input.trial ? String(input.trialClaim?.startsAt) : "none",
            },
            subscription_data: {
              metadata: {
                ...tags(scope),
                eliza_command_id: intent.commandId,
                eliza_request_digest: intent.requestDigest,
                eliza_plan_revision_id: input.plan.planRevisionId,
              },
              ...(input.trial
                ? {
                    trial_end: input.trialClaim?.endsAt,
                    trial_settings: { end_behavior: { missing_payment_method: "pause" as const } },
                  }
                : {}),
            },
            ...(input.trial ? { payment_method_collection: "if_required" as const } : {}),
          },
          options(intent),
        ),
      );
      await owned(scope, value);
      requireValue(
        value.customer === input.customerId,
        "CHECKOUT",
        "Provider checkout customer differs from its durable intent",
      );
      return observation<BillingProviderCheckout>(
        {
          mode: "subscription",
          invoiceId: value.invoice,
          sessionId: value.id,
          customerId: value.customer,
          subscriptionId: value.subscription,
          status: value.status,
          paymentStatus: value.payment_status,
          url: value.url,
          expiresAt: value.expires_at,
        },
        input,
        intent,
      );
    },
    readCheckout,
    async expireCheckout(
      scope: BillingProviderScope,
      input: { sessionId: string; customerId: string } & (
        | { mode?: "subscription" }
        | { mode: "setup"; subscriptionId: string; plan: BillingProviderPlan }
      ),
      intent: DurableProviderIntent,
    ) {
      const read = () =>
        input.mode === "setup"
          ? readPaymentMethodCheckout(scope, input)
          : readCheckout(scope, input);
      const current = await read();
      if (current.value.status !== "open") return current;
      await stripe.checkout.sessions.expire(input.sessionId, {}, options(intent));
      return read();
    },
    /** Discovery never authorizes repeating a create when no candidate is observed. */
    async discoverCreatedCheckout(
      scope: BillingProviderScope,
      input: {
        customerId: string;
        plan: BillingProviderPlan;
        quantity: number;
        successUrl: string;
        cancelUrl: string;
        trial: boolean;
        trialClaim?: BillingProviderTrialClaim;
      },
      intent: DurableProviderIntent,
    ) {
      await customer(scope, input.customerId);
      options(intent);
      checkQuantity(input.quantity, input.plan);
      if (input.trial) {
        if (!input.trialClaim)
          fail("TRIAL_CLAIM", "Checkout recovery requires the original trial claim");
        validateTrialClaim(input.trialClaim);
      }
      const candidates: BillingProviderCheckout[] = [];
      for await (const raw of stripe.checkout.sessions.list(
        { customer: input.customerId, limit: 100 },
        options(),
      )) {
        const lookup = parse(z.object({ metadata }), raw);
        if (lookup.metadata.eliza_command_id !== intent.commandId) continue;
        const value = parse(
          checkoutSchema.extend({
            success_url: z.string().nullable(),
            cancel_url: z.string().nullable(),
            payment_method_collection: z.enum(["always", "if_required"]).nullable(),
          }),
          raw,
        );
        await owned(scope, value);
        requireValue(
          value.customer === input.customerId &&
            value.metadata.eliza_request_digest === intent.requestDigest &&
            value.metadata.eliza_plan_revision_id === input.plan.planRevisionId &&
            value.metadata.eliza_trial_end ===
              (input.trial ? String(input.trialClaim?.endsAt) : "none") &&
            value.metadata.eliza_trial_start ===
              (input.trial ? String(input.trialClaim?.startsAt) : "none") &&
            value.success_url === returnUrl(input.successUrl) &&
            value.cancel_url === returnUrl(input.cancelUrl) &&
            (!input.trial || value.payment_method_collection === "if_required"),
          "DISCOVERY_CONFLICT",
          "Checkout candidate contradicts the original durable command",
        );
        const lines: { price: z.infer<typeof priceSchema>; quantity: number }[] = [];
        for await (const line of stripe.checkout.sessions.listLineItems(
          value.id,
          { limit: 100 },
          options(),
        ))
          lines.push(
            parse(
              z.object({ price: priceSchema, quantity: z.number().int().positive().safe() }),
              line,
            ),
          );
        const line = lines[0];
        requireValue(
          lines.length === 1 && line !== undefined && line.quantity === input.quantity,
          "DISCOVERY_CONFLICT",
          "Checkout has different or additional purchased items",
        );
        if (!line) fail("DISCOVERY_CONFLICT", "Checkout has no immutable plan line");
        checkPlan(line.price, input.plan);
        if (value.subscription !== null) {
          const subscription = await projectSubscription(
            scope,
            await stripe.subscriptions.retrieve(value.subscription, {}, options()),
            input.plan,
            input.customerId,
          );
          requireValue(
            subscription.subscriptionId === value.subscription &&
              subscription.quantity === input.quantity &&
              (input.trial
                ? input.trialClaim !== undefined &&
                  subscription.trialEnd === input.trialClaim.endsAt &&
                  subscription.trialStart !== null &&
                  subscription.trialStart >= input.trialClaim.startsAt
                : subscription.trialEnd === null),
            "DISCOVERY_CONFLICT",
            "Completed Checkout subscription differs from the original purchase",
          );
        }
        // Open Checkout does not expose subscription_data.trial_end. The resulting subscription must still pass the finalizer before access or allowance is granted.
        candidates.push({
          mode: "subscription",
          sessionId: value.id,
          invoiceId: value.invoice,
          customerId: value.customer,
          subscriptionId: value.subscription,
          status: value.status,
          paymentStatus: value.payment_status,
          url: value.url,
          expiresAt: value.expires_at,
        });
      }
      requireValue(
        candidates.length <= 1,
        "DISCOVERY_CONFLICT",
        "Multiple Checkout sessions match the same durable command",
      );
      const object = candidates[0];
      return observation<BillingProviderCreationDiscovery<BillingProviderCheckout>>(
        object ? { status: "found", object } : { status: "not_observed" },
        input,
        intent,
      );
    },
    async discoverCreatedPaymentMethodCheckout(
      scope: BillingProviderScope,
      input: {
        subscriptionId: string;
        customerId: string;
        plan: BillingProviderPlan;
        successUrl: string;
        cancelUrl: string;
      },
      intent: DurableProviderIntent,
    ) {
      await retrieveSubscription(scope, input);
      options(intent);
      const candidates: BillingProviderPaymentMethodCheckout[] = [];
      for await (const raw of stripe.checkout.sessions.list(
        { customer: input.customerId, limit: 100 },
        options(),
      )) {
        const lookup = parse(z.object({ metadata }), raw);
        if (lookup.metadata.eliza_command_id !== intent.commandId) continue;
        const urls = parse(
          z.object({
            success_url: z.string().nullable(),
            cancel_url: z.string().nullable(),
            currency: z.string(),
          }),
          raw,
        );
        requireValue(
          lookup.metadata.eliza_request_digest === intent.requestDigest &&
            urls.success_url === returnUrl(input.successUrl) &&
            urls.cancel_url === returnUrl(input.cancelUrl) &&
            urls.currency === input.plan.currency,
          "DISCOVERY_CONFLICT",
          "Setup Checkout candidate contradicts the original durable command",
        );
        candidates.push(await projectPaymentMethodCheckout(scope, raw, input, false));
      }
      requireValue(
        candidates.length <= 1,
        "DISCOVERY_CONFLICT",
        "Multiple setup Checkout sessions match the same durable command",
      );
      const object = candidates[0];
      return observation<BillingProviderCreationDiscovery<BillingProviderPaymentMethodCheckout>>(
        object ? { status: "found", object } : { status: "not_observed" },
        input,
        intent,
      );
    },
    async createPaymentMethodCheckout(
      scope: BillingProviderScope,
      input: {
        subscriptionId: string;
        customerId: string;
        plan: BillingProviderPlan;
        successUrl: string;
        cancelUrl: string;
      },
      intent: DurableProviderIntent,
    ) {
      await retrieveSubscription(scope, input);
      const value = await projectPaymentMethodCheckout(
        scope,
        await stripe.checkout.sessions.create(
          {
            mode: "setup",
            customer: input.customerId,
            currency: input.plan.currency,
            success_url: returnUrl(input.successUrl),
            cancel_url: returnUrl(input.cancelUrl),
            metadata: {
              ...tags(scope),
              eliza_subscription_id: input.subscriptionId,
              eliza_command_id: intent.commandId,
              eliza_request_digest: intent.requestDigest,
            },
            setup_intent_data: {
              metadata: {
                ...tags(scope),
                eliza_subscription_id: input.subscriptionId,
                eliza_command_id: intent.commandId,
                eliza_request_digest: intent.requestDigest,
              },
            },
          },
          options(intent),
        ),
        input,
        false,
      );
      return observation(value, input, intent);
    },
    readPaymentMethodCheckout,
    async applyPaymentMethodCheckout(
      scope: BillingProviderScope,
      input: {
        sessionId: string;
        subscriptionId: string;
        customerId: string;
        plan: BillingProviderPlan;
      },
      intent: DurableProviderIntent,
    ) {
      const current = await retrieveSubscription(scope, input);
      const method = await completedSetupPaymentMethod(scope, input);
      const value = await projectSubscription(
        scope,
        await stripe.subscriptions.update(
          input.subscriptionId,
          { default_payment_method: method.id },
          options(intent),
        ),
        input.plan,
        input.customerId,
        true,
      );
      requireValue(
        value.subscriptionId === current.value.subscriptionId &&
          value.trialStart === current.value.trialStart &&
          value.trialEnd === current.value.trialEnd,
        "TRIAL_CHANGED",
        "Payment method setup changed subscription or trial identity",
      );
      return observation(value, input, intent);
    },
    retrieveSubscription,
    async retrieveSubscriptionFromCatalog(
      scope: BillingProviderScope,
      input: { subscriptionId: string; customerId: string; plans: BillingProviderPlan[] },
    ) {
      await customer(scope, input.customerId);
      const raw = await stripe.subscriptions.retrieve(input.subscriptionId, {}, options());
      const identity = parse(
        z.object({ items: z.object({ data: z.array(z.object({ price: z.object({ id }) })) }) }),
        raw,
      );
      requireValue(
        identity.items.data.length === 1,
        "SUBSCRIPTION_ITEMS",
        "App subscription must have one catalog item",
      );
      const matches = input.plans.filter(
        (plan) => plan.priceId === identity.items.data[0]!.price.id,
      );
      requireValue(
        matches.length === 1,
        "CATALOG",
        "Current subscription price must resolve to exactly one immutable app plan",
      );
      const plan = matches[0]!;
      const value = await projectSubscription(scope, raw, plan, input.customerId, true);
      requireValue(
        value.subscriptionId === input.subscriptionId,
        "IDENTITY",
        "Stripe returned a different subscription",
      );
      return {
        subscription: observation(value, {
          operation: "retrieveSubscriptionFromCatalog",
          scope,
          input,
        }),
        planRevisionId: plan.planRevisionId,
      };
    },
    async listSubscriptions(
      scope: BillingProviderScope,
      input: { customerId: string; plans: readonly BillingProviderPlan[] },
    ) {
      await customer(scope, input.customerId);
      const subscriptions: BillingProviderSubscription[] = [];
      for await (const raw of stripe.subscriptions.list(
        { customer: input.customerId, status: "all", limit: 100 },
        options(),
      )) {
        if (bindings) {
          const identity = parse(
            z.object({ id, customer: expandableId, livemode: z.boolean() }),
            raw,
          );
          requireValue(
            identity.customer === input.customerId && identity.livemode === merchant.livemode,
            "BINDING",
            "Provider list returned a customer or mode outside this billing account",
          );
          const binding = await bindings.resolveBinding({
            objectType: "subscription",
            objectId: identity.id,
            merchantId: merchant.merchantId,
            providerAccountId: merchant.stripeAccountId,
            livemode: merchant.livemode,
          });
          if (!binding)
            fail(
              "UNBOUND_SUBSCRIPTION",
              "Unbound subscription requires original-command reconciliation before scope listing can complete",
            );
          requireValue(
            binding.appId === scope.appId && binding.billingAccountId === scope.billingAccountId,
            "BINDING",
            "Customer contains a subscription bound to another app or billing account",
          );
          if (binding.scopeId !== scope.scopeId) continue;
        }
        const parsed = parse(subscriptionSchema, raw);
        const priceId = parsed.items.data[0]?.price.id;
        const plan = input.plans.find((candidate) => candidate.priceId === priceId);
        if (!plan) fail("CATALOG", "Subscription price has no immutable catalog binding");
        subscriptions.push(await projectSubscription(scope, parsed, plan, input.customerId, true));
      }
      return observation(subscriptions, { operation: "listSubscriptions", scope, input });
    },
    async updateSubscription(
      scope: BillingProviderScope,
      input: BillingProviderUpdateRequest & { reviewedPreview: BillingProviderUpdatePreview },
      intent: DurableProviderIntent,
    ) {
      const { reviewedPreview, ...request } = input;
      const fresh = await previewSubscriptionUpdate(scope, request);
      // The finalizer must hold the seat-assignment fence and persist buyer consent before dispatch.
      requireValue(
        reviewDigest(fresh.value) === reviewDigest(reviewedPreview),
        "QUOTE_CHANGED",
        "Subscription or invoice totals changed; review the fresh quote before confirming",
      );
      const current = await retrieveSubscription(scope, { ...input, plan: input.currentPlan });
      requireValue(
        current.digest === fresh.value.subscriptionDigest,
        "QUOTE_CHANGED",
        "Subscription changed during quote confirmation",
      );
      const raw = await stripe.subscriptions.update(
        input.subscriptionId,
        {
          items: [
            { id: current.value.itemId, price: input.targetPlan.priceId, quantity: input.quantity },
          ],
          proration_behavior: current.value.status === "trialing" ? "none" : "always_invoice",
          payment_behavior: "pending_if_incomplete",
          ...(current.value.status === "active" ? { proration_date: input.prorationDate } : {}),
          ...(current.value.status === "trialing" && current.value.trialEnd !== null
            ? { trial_end: current.value.trialEnd }
            : {}),
        },
        options(intent),
      );
      // An unpaid pending update keeps the old item; it is an observation, not an entitlement grant.
      const parsed = parse(subscriptionSchema, raw);
      requireValue(
        parsed.id === input.subscriptionId,
        "IDENTITY",
        "Provider returned a different subscription after update",
      );
      requireValue(
        parsed.pending_update !== null ||
          (parsed.items.data[0]?.price.id === input.targetPlan.priceId &&
            parsed.items.data[0]?.quantity === input.quantity),
        "UPDATE",
        "Provider did not apply or pend the reviewed subscription change",
      );
      const effectivePlan =
        parsed.items.data[0]?.price.id === input.targetPlan.priceId
          ? input.targetPlan
          : input.currentPlan;
      const value = await projectSubscription(scope, parsed, effectivePlan, input.customerId, true);
      requireValue(
        current.value.status !== "trialing" ||
          (value.status === "trialing" &&
            value.trialStart === current.value.trialStart &&
            value.trialEnd === current.value.trialEnd),
        "TRIAL_CHANGED",
        "Subscription update changed the authorized trial interval",
      );
      return observation(value, input, intent);
    },
    async inspectUpdatePayment(
      scope: BillingProviderScope,
      input: {
        subscriptionId: string;
        customerId: string;
        currentPlan: BillingProviderPlan;
        targetPlan: BillingProviderPlan;
        quantity: number;
        invoiceId: string | null;
        dispatchedAt: number;
        reviewedPreview: BillingProviderUpdatePreview;
      },
    ) {
      await customer(scope, input.customerId);
      const raw = parse(
        subscriptionSchema,
        await stripe.subscriptions.retrieve(input.subscriptionId, {}, options()),
      );
      const effectivePlan =
        raw.items.data[0]?.price.id === input.targetPlan.priceId
          ? input.targetPlan
          : input.currentPlan;
      const current = await projectSubscription(scope, raw, effectivePlan, input.customerId, true);
      requireValue(
        current.subscriptionId === input.subscriptionId,
        "IDENTITY",
        "Payment recovery returned a different subscription",
      );
      const applied =
        !current.pendingUpdate &&
        current.priceId === input.targetPlan.priceId &&
        current.quantity === input.quantity;
      const subscription = observation(current, {
        operation: "inspectUpdatePayment",
        scope,
        input,
      });
      if (applied) return { subscription, invoice: null, action: null, applied: true };
      const pending =
        raw.pending_update === null
          ? null
          : parse(
              z.object({
                expires_at: seconds,
                subscription_items: z
                  .array(
                    z.object({
                      id,
                      price: expandableId,
                      quantity: z.number().int().positive().safe(),
                    }),
                  )
                  .length(1),
              }),
              raw.pending_update,
            );
      if (pending) {
        const item = pending.subscription_items[0]!;
        requireValue(
          item.id === current.itemId &&
            item.price === input.targetPlan.priceId &&
            item.quantity === input.quantity,
          "PENDING_UPDATE",
          "Pending payment differs from the confirmed subscription change",
        );
        requireValue(
          input.invoiceId === null || input.invoiceId === current.latestInvoiceId,
          "PENDING_UPDATE",
          "Pending update replaced the original payment invoice",
        );
      }
      const invoiceId = input.invoiceId ?? current.latestInvoiceId;
      if (invoiceId === null || (!pending && input.invoiceId === null))
        return { subscription, invoice: null, action: null, applied: false };
      const identity = parse(
        invoiceSchema.extend({ created: seconds }),
        await stripe.invoices.retrieve(invoiceId, {}, options()),
      );
      requireValue(
        identity.id === invoiceId &&
          identity.customer === input.customerId &&
          identity.subscription === input.subscriptionId &&
          identity.livemode === merchant.livemode &&
          identity.created >= input.dispatchedAt &&
          identity.billing_reason === "subscription_update",
        "INVOICE",
        "Payment invoice does not belong to the original scoped update",
      );
      const invoice = await this.retrieveInvoice(scope, {
        invoiceId,
        subscriptionId: input.subscriptionId,
        customerId: input.customerId,
        plan: effectivePlan,
      });
      requireValue(
        invoice.value.amountDueCents === input.reviewedPreview.dueNowCents &&
          invoice.value.currency === input.reviewedPreview.nextInvoice.currency &&
          invoice.value.totalCents === input.reviewedPreview.nextInvoice.totalCents,
        "QUOTE_CHANGED",
        "Payment invoice differs from the confirmed amount",
      );
      if (
        !pending ||
        invoice.value.status !== "open" ||
        invoice.value.paid ||
        invoice.value.payment?.status !== "requires_action"
      )
        return { subscription, invoice, action: null, applied: false };
      const hosted = invoice.value.hostedInvoiceUrl;
      if (hosted === null) fail("INVOICE", "Authentication invoice has no hosted payment link");
      const url = new URL(hosted);
      requireValue(
        url.protocol === "https:" &&
          url.hostname === "invoice.stripe.com" &&
          !url.username &&
          !url.password,
        "INVOICE",
        "Authentication invoice link is not a hosted Stripe invoice",
      );
      return {
        subscription,
        invoice,
        applied: false,
        action: {
          kind: "payment" as const,
          invoiceId,
          customerId: input.customerId,
          subscriptionId: input.subscriptionId,
          url: hosted,
          expiresAt: new Date(pending.expires_at * 1000).toISOString(),
        },
      };
    },
    async inspectPaymentMethodResume(
      scope: BillingProviderScope,
      input: BillingProviderResumePaymentInput,
    ): Promise<BillingProviderResumePaymentInspection> {
      parse(
        z.object({
          invoiceId: id,
          previousInvoiceId: id.nullable(),
          dispatchedAt: seconds,
          quantity: z.number().int().positive().safe(),
        }),
        input,
      );
      requireValue(
        input.invoiceId !== input.previousInvoiceId,
        "RESUME_INVOICE",
        "Resume cannot collect the preceding subscription invoice",
      );
      await completedSetupPaymentMethod(scope, input);
      const raw = parse(
        subscriptionSchema,
        await stripe.subscriptions.retrieve(input.subscriptionId, {}, options()),
      );
      const current = await projectSubscription(scope, raw, input.plan, input.customerId, true);
      requireValue(
        current.subscriptionId === input.subscriptionId && current.quantity === input.quantity,
        "RESUME_INVOICE",
        "Resume differs from the original subscription and quantity",
      );
      const pending =
        raw.pending_update === null
          ? null
          : parse(
              z.object({
                expires_at: seconds,
                subscription_items: z
                  .array(
                    z.object({
                      id,
                      price: expandableId,
                      quantity: z.number().int().positive().safe(),
                    }),
                  )
                  .nullable(),
              }),
              raw.pending_update,
            );
      if (pending?.subscription_items !== null && pending?.subscription_items !== undefined) {
        const item = pending.subscription_items[0];
        requireValue(
          pending.subscription_items.length === 1 &&
            item?.id === current.itemId &&
            item.price === input.plan.priceId &&
            item.quantity === input.quantity,
          "RESUME_INVOICE",
          "Pending resume changed the original catalog selection",
        );
      }
      requireValue(
        !current.pendingUpdate || current.latestInvoiceId === input.invoiceId,
        "RESUME_INVOICE",
        "Pending resume replaced the persisted invoice",
      );
      const identity = parse(
        invoiceSchema.extend({ created: seconds }),
        await stripe.invoices.retrieve(input.invoiceId, {}, options()),
      );
      requireValue(
        identity.id === input.invoiceId &&
          identity.created >= input.dispatchedAt &&
          (identity.billing_reason === "subscription_cycle" ||
            identity.billing_reason === "subscription_update"),
        "RESUME_INVOICE",
        "Invoice is not from the original resume dispatch",
      );
      const invoice = await this.retrieveInvoice(scope, input);
      const line = invoice.value.lines[0];
      requireValue(
        invoice.value.lines.length === 1 &&
          line?.lineType === "subscription" &&
          line.subscriptionId === input.subscriptionId &&
          line.subscriptionItemId === current.itemId &&
          line.priceId === input.plan.priceId &&
          line.quantity === input.quantity &&
          !line.proration &&
          line.amountCents === input.plan.amountCents * input.quantity,
        "RESUME_INVOICE",
        "Resume invoice differs from the original catalog and quantity",
      );
      const subscription = observation(current, {
        operation: "inspectPaymentMethodResume",
        scope,
        input,
      });
      const payment = invoice.value.payment;
      const settled =
        invoice.value.status === "paid" &&
        invoice.value.paid &&
        !invoice.value.paidOutOfBand &&
        invoice.value.amountPaidCents >= invoice.value.amountDueCents &&
        (invoice.value.amountDueCents === 0 ||
          (payment?.status === "succeeded" &&
            payment.amountReceivedCents >= invoice.value.amountDueCents));
      const applied = current.status === "active" && !current.pendingUpdate && settled;
      const open = invoice.value.status === "open" && !invoice.value.paid;
      const actionable =
        open &&
        (payment?.status === "requires_confirmation" ||
          payment?.status === "requires_action" ||
          payment?.status === "requires_payment_method");
      let action: BillingProviderResumePaymentInspection["action"] = null;
      if (actionable) {
        if (pending === null)
          fail("RESUME_INVOICE", "Actionable resume invoice lost its pending expiration");
        const hosted = invoice.value.hostedInvoiceUrl;
        if (hosted === null) fail("RESUME_INVOICE", "Resume invoice has no hosted payment link");
        const url = new URL(hosted);
        requireValue(
          url.protocol === "https:" &&
            url.hostname === "invoice.stripe.com" &&
            !url.username &&
            !url.password,
          "RESUME_INVOICE",
          "Resume payment link is not a hosted Stripe invoice",
        );
        action = {
          kind: "payment",
          invoiceId: input.invoiceId,
          customerId: input.customerId,
          subscriptionId: input.subscriptionId,
          url: hosted,
          expiresAt: new Date(pending.expires_at * 1000).toISOString(),
        };
      }
      const payable =
        open &&
        current.status === "paused" &&
        pending !== null &&
        current.latestInvoiceId === input.invoiceId &&
        (payment?.status === "requires_confirmation" ||
          (payment === null && invoice.value.amountDueCents === 0));
      return { subscription, invoice, action, applied, payable, settled };
    },
    async payPaymentMethodResumeInvoice(
      scope: BillingProviderScope,
      input: BillingProviderResumePaymentInput,
      intent: DurableProviderIntent,
    ): Promise<BillingProviderResumePaymentInspection> {
      const inspected = await this.inspectPaymentMethodResume(scope, input);
      if (!inspected.payable) return inspected;
      const method = await completedSetupPaymentMethod(scope, input);
      try {
        await stripe.invoices.pay(
          input.invoiceId,
          { payment_method: method.id, off_session: true },
          options(intent),
        );
      } catch (error) {
        // error-policy:J4 Expected card failures become a freshly observed hosted payment action; transport failures retain ambiguous intent.
        if (!(error instanceof Error) || !("type" in error) || error.type !== "StripeCardError")
          throw error;
        const refreshed = await this.inspectPaymentMethodResume(scope, input);
        if (!refreshed.action && !refreshed.applied) throw error;
        return refreshed;
      }
      return this.inspectPaymentMethodResume(scope, input);
    },
    async cancelSubscription(
      scope: BillingProviderScope,
      input: {
        subscriptionId: string;
        customerId: string;
        plan: BillingProviderPlan;
        atPeriodEnd: boolean;
      },
      intent: DurableProviderIntent,
    ) {
      const current = await retrieveSubscription(scope, input);
      if (current.value.status === "canceled") return observation(current.value, input, intent);
      const raw = input.atPeriodEnd
        ? await stripe.subscriptions.update(
            input.subscriptionId,
            { cancel_at_period_end: true },
            options(intent),
          )
        : await stripe.subscriptions.cancel(
            input.subscriptionId,
            { invoice_now: false, prorate: false },
            options(intent),
          );
      return observation(
        await projectSubscription(scope, raw, input.plan, input.customerId, true),
        input,
        intent,
      );
    },
    /** Replays the original resume endpoint and body; the journal owns the bounded retry window. */
    async replayPausedSubscriptionResume(
      scope: BillingProviderScope,
      input: { subscriptionId: string; customerId: string; plan: BillingProviderPlan },
      intent: DurableProviderIntent,
    ) {
      await retrieveSubscription(scope, input);
      const raw = await stripe.subscriptions.resume(
        input.subscriptionId,
        { billing_cycle_anchor: "now" },
        options(intent),
      );
      return observation(
        await projectSubscription(scope, raw, input.plan, input.customerId, true),
        input,
        intent,
      );
    },
    async resumeSubscription(
      scope: BillingProviderScope,
      input: { subscriptionId: string; customerId: string; plan: BillingProviderPlan },
      intent: DurableProviderIntent,
    ) {
      const current = await retrieveSubscription(scope, input);
      const raw =
        current.value.status === "paused"
          ? await stripe.subscriptions.resume(
              input.subscriptionId,
              { billing_cycle_anchor: "now" },
              options(intent),
            )
          : await stripe.subscriptions.update(
              input.subscriptionId,
              { cancel_at_period_end: false },
              options(intent),
            );
      return observation(
        await projectSubscription(scope, raw, input.plan, input.customerId, true),
        input,
        intent,
      );
    },
    async createPortal(
      scope: BillingProviderScope,
      input: {
        subscriptionId: string;
        customerId: string;
        currentPlan: BillingProviderPlan;
        availablePlans: readonly BillingProviderPlan[];
        minimumSeats: number;
        returnUrl: string;
      },
      intent: DurableProviderIntent,
    ) {
      await retrieveSubscription(scope, { ...input, plan: input.currentPlan });
      // A portal can outlive the occupied-seat snapshot; changes use the fenced review flow instead.
      const allowUpdate = false;
      const configuration = await stripe.billingPortal.configurations.create(
        {
          default_return_url: returnUrl(input.returnUrl),
          features: {
            invoice_history: { enabled: true },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true, mode: "at_period_end" },
            subscription_update: { enabled: false },
          },
        },
        options({ ...intent, idempotencyKey: `portal-config:${digest(intent.idempotencyKey)}` }),
      );
      const config = parse(z.object({ id }), configuration);
      const session = parse(
        z.object({ id, url: z.string().url(), customer: expandableId, livemode: z.boolean() }),
        await stripe.billingPortal.sessions.create(
          {
            customer: input.customerId,
            configuration: config.id,
            return_url: returnUrl(input.returnUrl),
          },
          options(intent),
        ),
      );
      requireValue(
        session.customer === input.customerId && session.livemode === merchant.livemode,
        "PORTAL",
        "Provider portal differs from its billing scope",
      );
      return observation(
        { sessionId: session.id, url: session.url, subscriptionUpdatesEnabled: allowUpdate },
        input,
        intent,
      );
    },
    async listInvoices(
      scope: BillingProviderScope,
      input: { customerId: string; subscriptionId: string; startingAfter: string | null },
    ) {
      await customer(scope, input.customerId);
      if (!bindings) fail("BINDING", "Invoice listing requires durable subscription ownership");
      const binding = await bindings.resolveBinding({
        objectType: "subscription",
        objectId: input.subscriptionId,
        merchantId: merchant.merchantId,
        providerAccountId: merchant.stripeAccountId,
        livemode: merchant.livemode,
      });
      requireValue(
        binding !== null &&
          binding.appId === scope.appId &&
          binding.billingAccountId === scope.billingAccountId &&
          binding.scopeId === scope.scopeId,
        "BINDING",
        "Invoice subscription has no matching durable app binding",
      );
      if (input.startingAfter !== null) {
        const cursor = parse(
          invoiceSchema,
          await stripe.invoices.retrieve(input.startingAfter, {}, options()),
        );
        requireValue(
          cursor.id === input.startingAfter &&
            cursor.customer === input.customerId &&
            cursor.subscription === input.subscriptionId &&
            cursor.livemode === merchant.livemode,
          "INVOICE",
          "Invoice cursor belongs to another billing scope",
        );
      }
      const page = parse(
        z.object({
          object: z.literal("list"),
          has_more: z.boolean(),
          data: z.array(invoiceSchema),
        }),
        await stripe.invoices.list(
          {
            customer: input.customerId,
            subscription: input.subscriptionId,
            limit: 100,
            ...(input.startingAfter ? { starting_after: input.startingAfter } : {}),
          },
          options(),
        ),
      );
      const items = page.data.map((invoice) => {
        requireValue(
          invoice.customer === input.customerId &&
            invoice.subscription === input.subscriptionId &&
            invoice.livemode === merchant.livemode,
          "INVOICE",
          "Invoice list returned a record outside this subscription",
        );
        if (invoice.status === null) fail("INVOICE", "Invoice status is unavailable");
        requireValue(
          /^[a-z]{3}$/u.test(invoice.currency) &&
            invoice.period_end >= invoice.period_start &&
            (invoice.hosted_invoice_url === null ||
              new URL(invoice.hosted_invoice_url).protocol === "https:"),
          "INVOICE",
          "Invoice amount currency, period or hosted link is invalid",
        );
        if (invoice.id === input.startingAfter)
          fail("PAGINATION", "Invoice pagination repeated its cursor");
        return {
          id: invoice.id,
          status: invoice.status,
          amountPaidCents: invoice.amount_paid,
          amountDueCents: invoice.amount_due,
          currency: invoice.currency,
          periodStart: new Date(invoice.period_start * 1000).toISOString(),
          periodEnd: new Date(invoice.period_end * 1000).toISOString(),
          hostedInvoiceUrl: invoice.hosted_invoice_url,
        };
      });
      const last = items.at(-1);
      if (new Set(items.map((item) => item.id)).size !== items.length)
        fail("PAGINATION", "Invoice page contains duplicate records");
      if (page.has_more && !last) fail("PAGINATION", "Invoice pagination did not advance");
      return observation(
        { items, nextCursor: page.has_more && last ? last.id : null },
        { operation: "listInvoices", scope, input },
      );
    },
    async retrieveInvoice(
      scope: BillingProviderScope,
      input: {
        invoiceId: string;
        subscriptionId: string;
        customerId: string;
        plan: BillingProviderPlan;
        /** Historical invoices keep their original price after the subscription changes plan. */
        historicalPlan?: true;
      },
    ) {
      if (input.historicalPlan) {
        await customer(scope, input.customerId);
        const subscription = parse(
          subscriptionSchema,
          await stripe.subscriptions.retrieve(input.subscriptionId, {}, options()),
        );
        await owned(scope, subscription, true);
        requireValue(
          subscription.id === input.subscriptionId && subscription.customer === input.customerId,
          "INVOICE",
          "Historical invoice subscription ownership differs from the original payment",
        );
      } else await retrieveSubscription(scope, input);
      const value = parse(
        invoiceSchema,
        await stripe.invoices.retrieve(input.invoiceId, {}, options()),
      );
      requireValue(
        value.id === input.invoiceId &&
          value.livemode === merchant.livemode &&
          value.customer === input.customerId &&
          value.subscription === input.subscriptionId &&
          value.currency === input.plan.currency,
        "INVOICE",
        "Invoice does not belong to the scoped subscription",
      );
      const lines: z.infer<typeof invoiceLineSchema>[] = [];
      for await (const raw of stripe.invoices.listLineItems(
        input.invoiceId,
        { limit: 100 },
        options(),
      )) {
        const line = parse(invoiceLineSchema, raw);
        requireValue(
          line.subscription === undefined ||
            line.subscription === null ||
            line.subscription === input.subscriptionId,
          "INVOICE_LINE_SCOPE",
          "Invoice line belongs to another subscription",
        );
        lines.push(line);
      }
      let payment: BillingProviderInvoice["payment"] = null;
      if (value.payment_intent !== null) {
        const intent = parse(
          z.object({
            id,
            object: z.literal("payment_intent"),
            livemode: z.boolean(),
            customer: expandableId,
            currency: z.string(),
            amount_received: money.nonnegative(),
            invoice: expandableId.nullable(),
            status: z.enum([
              "requires_payment_method",
              "requires_confirmation",
              "requires_action",
              "processing",
              "requires_capture",
              "canceled",
              "succeeded",
            ]),
          }),
          await stripe.paymentIntents.retrieve(value.payment_intent, {}, options()),
        );
        requireValue(
          intent.id === value.payment_intent &&
            intent.livemode === merchant.livemode &&
            intent.customer === input.customerId &&
            intent.currency === value.currency &&
            (intent.invoice === null || intent.invoice === input.invoiceId),
          "INVOICE_PAYMENT",
          "Invoice payment does not match the stored customer, merchant or invoice",
        );
        payment = {
          paymentIntentId: intent.id,
          status: intent.status,
          amountReceivedCents: intent.amount_received,
          customerId: intent.customer,
          currency: intent.currency,
          invoiceId: intent.invoice,
        };
      }
      const invoice: BillingProviderInvoice = {
        hostedInvoiceUrl: value.hosted_invoice_url,
        invoiceId: value.id,
        subscriptionId: value.subscription,
        customerId: value.customer,
        chargeId: value.charge,
        paymentIntentId: value.payment_intent,
        paidOutOfBand: value.paid_out_of_band,
        payment,
        status: value.status,
        paid: value.paid,
        amountPaidCents: value.amount_paid,
        amountDueCents: value.amount_due,
        billingReason: value.billing_reason,
        subtotalCents: value.subtotal,
        subtotalExcludingTaxCents: value.subtotal_excluding_tax,
        totalCents: value.total,
        taxCents: value.tax,
        discountCents: parse(
          money.nonnegative(),
          value.total_discount_amounts.reduce((total, entry) => total + entry.amount, 0),
        ),
        currency: value.currency,
        periodStart: value.period_start,
        periodEnd: value.period_end,
        lines: lines.map(projectInvoiceLine),
      };
      return observation(invoice, { operation: "retrieveInvoice", scope, input });
    },
    async retrieveRefund(
      scope: BillingProviderScope,
      input: {
        refundId: string;
        invoiceId: string;
        subscriptionId: string;
        customerId: string;
        plan: BillingProviderPlan;
      },
    ) {
      const invoice = await this.retrieveInvoice(scope, { ...input, historicalPlan: true });
      requireValue(
        invoice.value.chargeId !== null,
        "REFUND",
        "Invoice has no original provider charge",
      );
      const refund = parse(
        z.object({
          id,
          object: z.literal("refund"),
          charge: expandableId,
          amount: money.nonnegative(),
          currency: z.string(),
          status: z
            .enum(["pending", "requires_action", "succeeded", "failed", "canceled"])
            .nullable(),
        }),
        await stripe.refunds.retrieve(input.refundId, {}, options()),
      );
      requireValue(
        refund.id === input.refundId &&
          refund.charge === invoice.value.chargeId &&
          refund.currency === invoice.value.currency,
        "REFUND",
        "Refund is not bound to the original merchant invoice charge",
      );
      return observation(
        {
          refundId: refund.id,
          chargeId: refund.charge,
          amountCents: refund.amount,
          currency: refund.currency,
          status: refund.status,
        },
        { operation: "retrieveRefund", scope, input },
      );
    },
    /** Reads every original-charge refund; absence alone never authorizes retrying a provider mutation. */
    async discoverCreatedRefund(
      scope: BillingProviderScope,
      input: {
        invoiceId: string;
        subscriptionId: string;
        customerId: string;
        plan: BillingProviderPlan;
        amountCents: number;
      },
      intent: DurableProviderIntent,
    ) {
      const invoice = await this.retrieveInvoice(scope, { ...input, historicalPlan: true });
      const chargeId = invoice.value.chargeId;
      if (chargeId === null) fail("REFUND", "Invoice has no original provider charge");
      options(intent);
      const candidates: Array<{
        refundId: string;
        chargeId: string;
        amountCents: number;
        currency: string;
        status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled" | null;
      }> = [];
      for await (const raw of stripe.refunds.list({ charge: chargeId, limit: 100 }, options())) {
        const candidate = parse(z.object({ id, metadata }), raw);
        if (candidate.metadata.eliza_command_id !== intent.commandId) continue;
        requireValue(
          candidate.metadata.eliza_request_digest === intent.requestDigest &&
            Object.entries(tags(scope)).every(([key, value]) => candidate.metadata[key] === value),
          "DISCOVERY_CONFLICT",
          "Refund candidate contradicts the original durable command or ownership",
        );
        const refund = await this.retrieveRefund(scope, { ...input, refundId: candidate.id });
        requireValue(
          refund.value.amountCents === input.amountCents && refund.value.chargeId === chargeId,
          "DISCOVERY_CONFLICT",
          "Refund candidate differs from the original invoice and amount",
        );
        candidates.push(refund.value);
      }
      requireValue(
        candidates.length <= 1,
        "DISCOVERY_CONFLICT",
        "Multiple refunds claim one durable command",
      );
      return observation(
        candidates[0]
          ? { status: "found" as const, object: candidates[0] }
          : { status: "absent" as const },
        { operation: "discoverCreatedRefund", scope, input },
        intent,
      );
    },
    async previewRefund(
      scope: BillingProviderScope,
      input: {
        invoiceId: string;
        subscriptionId: string;
        customerId: string;
        plan: BillingProviderPlan;
      },
    ) {
      const invoice = await this.retrieveInvoice(scope, { ...input, historicalPlan: true });
      requireValue(
        invoice.value.paid && invoice.value.status === "paid" && invoice.value.chargeId !== null,
        "REFUND",
        "Refund requires the original paid invoice",
      );
      const chargeId = invoice.value.chargeId;
      if (!chargeId) fail("REFUND", "Paid invoice has no charge");
      const charge = parse(
        z.object({
          id,
          customer: expandableId,
          invoice: expandableId,
          livemode: z.boolean(),
          amount: money,
          amount_refunded: money,
          paid: z.boolean(),
          currency: z.string(),
        }),
        await stripe.charges.retrieve(chargeId, {}, options()),
      );
      requireValue(
        charge.id === chargeId &&
          charge.customer === input.customerId &&
          charge.invoice === input.invoiceId &&
          charge.livemode === merchant.livemode &&
          charge.paid &&
          charge.currency === input.plan.currency &&
          charge.amount_refunded >= 0 &&
          charge.amount_refunded <= charge.amount,
        "REFUND",
        "Original charge cannot fund the requested refund",
      );
      return observation(
        {
          chargeId,
          amountPaidCents: invoice.value.amountPaidCents,
          chargeAmountCents: charge.amount,
          amountAvailableCents: Math.max(
            0,
            Math.min(invoice.value.amountPaidCents, charge.amount) - charge.amount_refunded,
          ),
          currency: charge.currency,
        },
        { operation: "previewRefund", scope, input },
      );
    },
    async refund(
      scope: BillingProviderScope,
      input: {
        invoiceId: string;
        subscriptionId: string;
        customerId: string;
        plan: BillingProviderPlan;
        amountCents: number;
      },
      intent: DurableProviderIntent,
    ) {
      const preview = await this.previewRefund(scope, input);
      requireValue(
        Number.isSafeInteger(input.amountCents) &&
          input.amountCents > 0 &&
          input.amountCents <= preview.value.amountPaidCents &&
          input.amountCents <= preview.value.chargeAmountCents,
        "REFUND",
        "Refund requires a positive amount bounded by the original payment",
      );
      // Stripe enforces remaining funds; replaying a durable key must still work after that refund consumes them.
      const chargeId = preview.value.chargeId;
      const refund = parse(
        z.object({
          id,
          charge: expandableId,
          amount: money,
          currency: z.string(),
          status: z
            .enum(["pending", "requires_action", "succeeded", "failed", "canceled"])
            .nullable(),
        }),
        await stripe.refunds.create(
          {
            charge: chargeId,
            amount: input.amountCents,
            metadata: {
              ...tags(scope),
              eliza_command_id: intent.commandId,
              eliza_request_digest: intent.requestDigest,
            },
          },
          options(intent),
        ),
      );
      requireValue(
        refund.charge === chargeId &&
          refund.amount === input.amountCents &&
          refund.currency === input.plan.currency,
        "REFUND",
        "Provider refund differs from the original invoice intent",
      );
      return observation(
        {
          refundId: refund.id,
          chargeId,
          amountCents: refund.amount,
          currency: refund.currency,
          status: refund.status,
        },
        input,
        intent,
      );
    },
    async verifyWebhook(
      payload: string,
      signature: string,
      webhookSecret: string,
    ): Promise<BillingProviderEvent> {
      requireValue(
        webhookSecret.startsWith("whsec_"),
        "WEBHOOK",
        "Merchant webhook verifier is not configured",
      );
      const raw = await stripe.webhooks.constructEventAsync(payload, signature, webhookSecret);
      const event = parse(
        z.object({
          id,
          type: id,
          created: seconds,
          api_version: z.literal(GENERIC_BILLING_STRIPE_API_VERSION),
          account: id.optional(),
          livemode: z.boolean(),
          data: z.object({ object: z.object({ id, object: id }) }),
        }),
        raw,
      );
      requireValue(
        event.livemode === merchant.livemode &&
          (merchant.kind === "connected"
            ? event.account === merchant.stripeAccountId
            : event.account === undefined || event.account === merchant.stripeAccountId),
        "WEBHOOK_SCOPE",
        "Signed event belongs to a different merchant or environment",
      );
      return {
        eventId: event.id,
        eventType: event.type,
        createdAt: event.created,
        apiVersion: event.api_version,
        merchantId: merchant.merchantId,
        providerAccountId: merchant.stripeAccountId,
        livemode: event.livemode,
        objectId: event.data.object.id,
        objectType: event.data.object.object,
        payloadDigest: createHash("sha256").update(payload).digest("hex"),
      };
    },
  };
}

export type GenericBillingProvider = ReturnType<typeof createGenericBillingProvider>;

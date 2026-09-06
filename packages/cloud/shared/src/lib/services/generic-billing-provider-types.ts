/** Defines merchant-scoped provider observations consumed by the durable subscription lifecycle. */
export const GENERIC_BILLING_STRIPE_API_VERSION = "2024-11-20.acacia";

export interface BillingProviderMerchant {
  merchantId: string;
  kind: "platform" | "connected";
  stripeAccountId: string;
  livemode: boolean;
}

/** Resolved database authority, never a browser-supplied ownership assertion. */
export interface BillingProviderScope {
  scopeId: string;
  appId: string;
  billingAccountId: string;
}

/** The caller commits this intent before any provider mutation. */
export interface DurableProviderIntent {
  commandId: string;
  idempotencyKey: string;
  requestDigest: string;
}

export interface BillingProviderPlan {
  planRevisionId: string;
  priceId: string;
  productId: string;
  amountCents: number;
  currency: string;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
  minimumQuantity: number;
  maximumQuantity: number;
  trialDays: 7;
}

export interface BillingProviderObservation<T> {
  value: T;
  digest: string;
  inputDigest: string;
  apiVersion: typeof GENERIC_BILLING_STRIPE_API_VERSION;
  merchantId: string;
  providerAccountId: string;
  livemode: boolean;
  /** Provider observation time only; the finalizer owns its database clock and revision fence. */
  observedAt: string;
}

export interface BillingProviderCustomer {
  customerId: string;
}

export interface BillingProviderSubscription {
  subscriptionId: string;
  customerId: string;
  itemId: string;
  status:
    | "incomplete"
    | "incomplete_expired"
    | "trialing"
    | "active"
    | "past_due"
    | "canceled"
    | "unpaid"
    | "paused";
  quantity: number;
  priceId: string;
  productId: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  trialStart: number | null;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  endedAt: number | null;
  latestInvoiceId: string | null;
  pendingUpdate: boolean;
}

export interface BillingProviderCheckout {
  mode: "subscription";
  invoiceId: string | null;
  sessionId: string;
  customerId: string;
  subscriptionId: string | null;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  url: string | null;
  expiresAt: number;
}

export interface BillingProviderPaymentMethodCheckout {
  mode: "setup";
  sessionId: string;
  customerId: string;
  subscriptionId: string;
  status: "open" | "complete" | "expired";
  url: string | null;
  expiresAt: number;
  setupIntentId: string | null;
}

export interface BillingProviderInvoice {
  hostedInvoiceUrl: string | null;
  invoiceId: string;
  subscriptionId: string;
  customerId: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  paidOutOfBand: boolean;
  payment: {
    paymentIntentId: string;
    status:
      | "requires_payment_method"
      | "requires_confirmation"
      | "requires_action"
      | "processing"
      | "requires_capture"
      | "canceled"
      | "succeeded";
    amountReceivedCents: number;
    customerId: string;
    currency: string;
    invoiceId: string | null;
  } | null;
  status: "draft" | "open" | "paid" | "uncollectible" | "void" | null;
  paid: boolean;
  amountPaidCents: number;
  amountDueCents: number;
  billingReason: string;
  subtotalCents: number;
  subtotalExcludingTaxCents: number | null;
  totalCents: number;
  taxCents: number | null;
  discountCents: number;
  currency: string;
  periodStart: number;
  periodEnd: number;
  lines: Array<{
    lineId: string;
    lineType: "subscription" | "invoiceitem";
    subscriptionId: string | null;
    subscriptionItemId: string | null;
    priceId: string | null;
    quantity: number | null;
    discountAmountsCents: number[];
    taxAmountsCents: number[];
    amountCents: number;
    periodStart: number;
    periodEnd: number;
    proration: boolean;
  }>;
}

/** Signed notification context is a lookup trigger; it does not grant entitlement. */
export interface BillingProviderEvent {
  eventId: string;
  eventType: string;
  createdAt: number;
  apiVersion: typeof GENERIC_BILLING_STRIPE_API_VERSION;
  merchantId: string;
  providerAccountId: string;
  livemode: boolean;
  objectId: string;
  objectType: string;
  payloadDigest: string;
}

/** A UTC interval already claimed atomically before dispatch; retries must retain its end. */
export interface BillingProviderTrialClaim {
  startsAt: number;
  endsAt: number;
}

/** Exact persisted object ownership. Customers deliberately have no product-family scope. */
export interface BillingProviderObjectBinding {
  appId: string;
  billingAccountId: string;
  scopeId: string | null;
}

export interface BillingProviderBindingResolver {
  resolveBinding(input: {
    objectType: "customer" | "subscription" | "checkout.session";
    objectId: string;
    merchantId: string;
    providerAccountId: string;
    livemode: boolean;
  }): Promise<BillingProviderObjectBinding | null>;
}

export interface BillingProviderUpdateRequest {
  subscriptionId: string;
  customerId: string;
  currentPlan: BillingProviderPlan;
  targetPlan: BillingProviderPlan;
  quantity: number;
  minimumSeats: number;
  /** Fixed provider timestamp carried from review through confirmation. */
  prorationDate: number;
}

export interface BillingProviderInvoicePreview {
  currency: string;
  amountDueCents: number;
  subtotalCents: number;
  totalCents: number;
  taxCents: number | null;
  discountCents: number;
  prorationCents: number;
  lines: BillingProviderInvoice["lines"];
}

/** Persist before presenting Review subscription; confirmation re-previews and compares this value. */
export interface BillingProviderUpdatePreview {
  requestDigest: string;
  subscriptionDigest: string;
  prorationDate: number;
  trialEnd: number | null;
  dueNowCents: number;
  nextInvoice: BillingProviderInvoicePreview;
  recurringInvoice: BillingProviderInvoicePreview | null;
  recurringBasis: "long_term" | "trial_renewal";
}

/** Discovery never authorizes another create: absence remains ambiguous after provider key expiry. */
export type BillingProviderCreationDiscovery<T> =
  | { status: "found"; object: T }
  | { status: "not_observed" };

/** The journal persists the exact invoice returned by the original resume dispatch before payment. */
export interface BillingProviderResumePaymentInput {
  sessionId: string;
  subscriptionId: string;
  customerId: string;
  plan: BillingProviderPlan;
  quantity: number;
  invoiceId: string;
  previousInvoiceId: string | null;
  dispatchedAt: number;
}

/** A pending invoice is payment progress, never subscription authority or an entitlement grant. */
export interface BillingProviderResumePaymentInspection {
  settled: boolean;
  subscription: BillingProviderObservation<BillingProviderSubscription>;
  invoice: BillingProviderObservation<BillingProviderInvoice>;
  action: {
    kind: "payment";
    invoiceId: string;
    customerId: string;
    subscriptionId: string;
    url: string;
    expiresAt: string;
  } | null;
  applied: boolean;
  payable: boolean;
}

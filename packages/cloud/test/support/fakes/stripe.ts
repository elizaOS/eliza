// spec/cloud/billing/checkout.md, "Story: Subscribe once, whichever screen or payer finishes it"; spec/cloud/billing/providerEvents.md, "Story: Apply each payment event once, whatever the delivery order"
import { createHmac } from "node:crypto";
import type { CatalogPrice, FakeAnswer, FakeHandler, FakeRequest } from "../fakes.ts";
import { catalogPrices } from "../profile.ts";

export const fakeSecretKey = "sk_test_fake";
export const fakeWebhookSecret = "whsec_fake";

type Metadata = Record<string, string>;
type FormField = string | Form | FormField[];
interface Form { [key: string]: FormField }

interface List<T> {
  readonly object: "list";
  readonly data: T[];
  readonly has_more: boolean;
  readonly url: string;
}

export interface StripePrice {
  readonly id: string;
  readonly object: "price";
  readonly active: true;
  readonly currency: "usd";
  readonly unit_amount: number;
  readonly type: "recurring";
  readonly billing_scheme: "per_unit";
  readonly transform_quantity: null;
  readonly livemode: boolean;
  readonly product: string;
  readonly recurring: { readonly interval: "month"; readonly interval_count: 1; readonly trial_period_days: null; readonly usage_type: "licensed" };
}

export interface StripeProduct {
  readonly id: string;
  readonly object: "product";
  readonly active: true;
  readonly livemode: boolean;
}

export interface StripeCustomer {
  readonly id: string;
  readonly object: "customer";
  email: string | null;
  name: string | null;
  metadata: Metadata;
  readonly livemode: boolean;
  readonly created: number;
}

export interface StripeCheckoutSession {
  readonly id: string;
  readonly object: "checkout.session";
  readonly mode: "subscription";
  status: "open" | "complete" | "expired";
  payment_status: "unpaid" | "paid";
  customer: string | null;
  readonly client_reference_id: string | null;
  readonly metadata: Metadata;
  subscription: string | null;
  invoice: string | null;
  readonly ui_mode: "hosted" | "embedded";
  url: string | null;
  client_secret: string | null;
  readonly success_url: string | null;
  readonly cancel_url: string | null;
  readonly return_url: string | null;
  readonly redirect_on_completion: "always" | "if_required" | "never" | null;
  readonly payment_method_types: string[];
  readonly allow_promotion_codes: boolean;
  readonly currency: "usd";
  readonly amount_subtotal: number;
  readonly amount_total: number;
  readonly expires_at: number;
  readonly created: number;
  readonly livemode: boolean;
}

export type StripeSubscriptionStatus = "incomplete" | "incomplete_expired" | "active" | "past_due" | "unpaid" | "canceled";

export interface StripeSubscriptionItem {
  readonly id: string;
  readonly object: "subscription_item";
  readonly subscription: string;
  price: StripePrice;
  readonly quantity: 1;
  current_period_start: number;
  current_period_end: number;
}

export interface StripeSubscription {
  readonly id: string;
  readonly object: "subscription";
  readonly customer: string;
  status: StripeSubscriptionStatus;
  readonly livemode: boolean;
  readonly created: number;
  readonly start_date: number;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  latest_invoice: string | null;
  metadata: Metadata;
  readonly currency: "usd";
  readonly collection_method: "charge_automatically";
  readonly schedule: null;
  readonly items: List<StripeSubscriptionItem>;
}

export interface StripeInvoiceLine {
  readonly id: string;
  readonly object: "line_item";
  readonly type: "subscription";
  readonly subscription: string;
  readonly subscription_item: string;
  readonly quantity: 1;
  readonly proration: false;
  readonly currency: "usd";
  readonly amount: number;
  readonly discounts: [];
  readonly discount_amounts: [];
  readonly tax_amounts: [];
  readonly period: { readonly start: number; readonly end: number };
  readonly price: { readonly id: string; readonly product: string };
  readonly pricing: { readonly price_details: { readonly price: string } };
  readonly parent: { readonly subscription_item_details: { readonly subscription_item: string; readonly proration: false } };
}

export interface StripeInvoicePayment {
  readonly amount_paid: number;
  readonly object: "invoice_payment";
  readonly payment: { readonly type: "payment_intent"; readonly payment_intent: string; readonly charge: string };
}

export interface StripeInvoice {
  readonly id: string;
  readonly object: "invoice";
  readonly customer: string;
  readonly subscription: string;
  readonly parent: { readonly type: "subscription_details"; readonly subscription_details: { readonly subscription: string; readonly metadata: Metadata } };
  readonly livemode: boolean;
  readonly billing_reason: "subscription_create" | "subscription_cycle";
  readonly status: "open" | "paid";
  readonly paid: boolean;
  readonly paid_out_of_band: false;
  readonly collection_method: "charge_automatically";
  readonly currency: "usd";
  readonly amount_due: number;
  readonly amount_paid: number;
  readonly amount_remaining: number;
  readonly total: number;
  readonly subtotal: number;
  readonly starting_balance: 0;
  readonly ending_balance: 0;
  readonly pre_payment_credit_notes_amount: 0;
  readonly post_payment_credit_notes_amount: 0;
  readonly discount: null;
  readonly discounts: [];
  readonly total_discount_amounts: [];
  readonly tax: null;
  readonly total_tax_amounts: [];
  readonly automatic_tax: { readonly enabled: false; readonly status: null };
  readonly application: null;
  readonly application_fee_amount: null;
  readonly on_behalf_of: null;
  readonly transfer_data: null;
  readonly issuer: { readonly type: "self" };
  readonly payment_intent: string | null;
  readonly charge: string | null;
  readonly payments: List<StripeInvoicePayment>;
  readonly status_transitions: { readonly paid_at: number | null };
  readonly period_start: number;
  readonly period_end: number;
  readonly hosted_invoice_url: string;
  readonly invoice_pdf: string;
  readonly created: number;
  readonly lines: List<StripeInvoiceLine>;
}

export interface StripePaymentIntent {
  readonly id: string;
  readonly object: "payment_intent";
  readonly amount: number;
  readonly amount_received: number;
  readonly currency: "usd";
  readonly customer: string;
  readonly invoice: string;
  readonly latest_charge: string;
  readonly status: "succeeded";
  readonly livemode: boolean;
  readonly created: number;
}

export interface StripeRefund {
  readonly id: string;
  readonly object: "refund";
  readonly amount: number;
  readonly charge: string;
  readonly payment_intent: string;
  readonly currency: "usd";
  readonly status: "succeeded";
  readonly created: number;
}

export interface StripeDispute {
  readonly id: string;
  readonly object: "dispute";
  readonly amount: number;
  readonly charge: string;
  readonly payment_intent: string;
  readonly currency: "usd";
  status: "needs_response" | "won" | "lost";
  readonly reason: "fraudulent";
  readonly livemode: boolean;
  readonly created: number;
}

export interface StripeCharge {
  readonly id: string;
  readonly object: "charge";
  readonly amount: number;
  readonly amount_captured: number;
  amount_refunded: number;
  refunded: boolean;
  disputed: boolean;
  readonly paid: true;
  readonly captured: true;
  readonly status: "succeeded";
  readonly currency: "usd";
  readonly customer: string;
  readonly invoice: string;
  readonly payment_intent: string;
  readonly livemode: boolean;
  readonly created: number;
  readonly refunds: List<StripeRefund>;
}

export interface StripePortalSession {
  readonly id: string;
  readonly object: "billing_portal.session";
  readonly customer: string;
  readonly return_url: string | null;
  readonly url: string;
  readonly livemode: boolean;
  readonly created: number;
}

export type StripeObject =
  | StripePrice
  | StripeProduct
  | StripeCustomer
  | StripeCheckoutSession
  | StripeSubscription
  | StripeInvoice
  | StripePaymentIntent
  | StripeCharge
  | StripeRefund
  | StripeDispute
  | StripePortalSession;

type Kind = StripeObject["object"];
type ObjectOf<K extends Kind> = Extract<StripeObject, { readonly object: K }>;

export type CompletedSession =
  | { readonly kind: "paid"; readonly session: StripeCheckoutSession; readonly subscription: StripeSubscription; readonly invoice: StripeInvoice; readonly paymentIntent: StripePaymentIntent; readonly charge: StripeCharge }
  | { readonly kind: "unpaid"; readonly session: StripeCheckoutSession; readonly subscription: StripeSubscription; readonly invoice: StripeInvoice };

export interface StripeEvent {
  readonly id: string;
  readonly object: "event";
  readonly type: string;
  readonly created: number;
  readonly livemode: boolean;
  readonly data: { readonly object: unknown; readonly previous_attributes?: unknown };
}

export interface SignedEvent {
  readonly id: string;
  readonly event: StripeEvent;
  readonly raw: string;
  readonly header: string;
}

export interface SignedEventOptions {
  readonly secret?: string;
  readonly timestamp?: number;
  readonly livemode?: boolean;
  readonly id?: string;
  readonly previousAttributes?: unknown;
}

export interface StripeFailureAnswer {
  readonly status: number;
  readonly type: "invalid_request_error" | "api_error" | "card_error" | "rate_limit_error";
  readonly code?: string;
}

export interface StripeFakeOptions {
  readonly prices?: ReadonlyArray<CatalogPrice>;
  readonly livemode?: boolean;
  readonly now?: () => number;
}

export interface StripeFake {
  readonly handler: FakeHandler;
  object(id: string): StripeObject;
  dropNextReply(path: string): void;
  failNext(path: string, answer: StripeFailureAnswer): void;
  completeSession(id: string, payment?: "paid" | "unpaid"): CompletedSession;
  expireSession(id: string): StripeCheckoutSession;
  refundCharge(id: string, amount?: number): StripeCharge;
  disputeCharge(id: string): StripeDispute;
  resolveDispute(id: string, outcome: "won" | "lost"): StripeDispute;
  signedEvent(type: string, object: unknown, options?: SignedEventOptions): SignedEvent;
  tamper(raw: string): string;
}

const prefixes = {
  customer: "cus",
  "checkout.session": "cs_test",
  subscription: "sub",
  subscription_item: "si",
  invoice: "in",
  line_item: "il",
  payment_intent: "pi",
  charge: "ch",
  refund: "re",
  dispute: "dp",
  "billing_portal.session": "bps",
  event: "evt",
  request: "req",
} as const;

const clone = <T>(value: T): T => structuredClone(value);

function refuse(status: number, message: string, extra: { readonly type?: string; readonly code?: string; readonly param?: string } = {}): FakeAnswer {
  return { status, body: { error: { type: extra.type ?? "invalid_request_error", message, ...(extra.code === undefined ? {} : { code: extra.code }), ...(extra.param === undefined ? {} : { param: extra.param }) } } };
}

const noSuch = (kind: string, id: string, param?: string): FakeAnswer =>
  refuse(param === undefined ? 404 : 400, `No such ${kind}: '${id}'`, { code: "resource_missing", ...(param === undefined ? {} : { param }) });

const isForm = (field: FormField | undefined): field is Form => typeof field === "object" && !Array.isArray(field);

function arrays(field: FormField): FormField {
  if (!isForm(field)) return Array.isArray(field) ? field.map(arrays) : field;
  const keys = Object.keys(field);
  const converted: Form = Object.fromEntries(keys.map((key) => [key, arrays(field[key])]));
  return keys.length > 0 && keys.every((key) => /^\d+$/.test(key)) ? keys.sort((a, b) => Number(a) - Number(b)).map((key) => converted[key]) : converted;
}

export function parseForm(body: string): Form {
  const root: Form = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const head = key.indexOf("[");
    const segments = [head === -1 ? key : key.slice(0, head), ...[...key.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1])];
    let target = root;
    segments.forEach((segment, index) => {
      const name = segment === "" ? String(Object.keys(target).length) : segment;
      if (index === segments.length - 1) {
        target[name] = value;
        return;
      }
      const next = target[name];
      const child: Form = isForm(next) ? next : {};
      target[name] = child;
      target = child;
    });
  }
  const converted = arrays(root);
  return isForm(converted) ? converted : {};
}

const text = (form: Form, key: string): string | undefined => {
  const value = form[key];
  return typeof value === "string" ? value : undefined;
};
const nested = (form: Form, key: string): Form => {
  const value = form[key];
  return isForm(value) ? value : {};
};
const forms = (form: Form, key: string): Form[] => {
  const value = form[key];
  return Array.isArray(value) ? value.filter(isForm) : [];
};
const answeredOnlyWhenExpanded = new Set(["refunds"]);
const strings = (form: Form, key: string): string[] => {
  const value = form[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
};
const metadataOf = (form: Form): Metadata =>
  Object.fromEntries(Object.entries(form).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));

function addMonth(seconds: number): number {
  const date = new Date(seconds * 1000);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return Math.floor(date.getTime() / 1000);
}

export function signStripePayload(raw: string, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
}

export function tamper(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  return JSON.stringify(typeof parsed === "object" && parsed !== null ? { ...parsed, tampered: true } : { value: parsed, tampered: true });
}

export function createStripeFake(options: StripeFakeOptions = {}): StripeFake {
  const livemode = options.livemode ?? false;
  const clock = options.now ?? Date.now;
  const now = () => Math.floor(clock() / 1000);
  const objects = new Map<string, StripeObject>();
  const sessionTerms = new Map<string, { readonly priceId: string; readonly subscriptionMetadata: Metadata }>();
  const replies = new Map<string, { readonly fingerprint: string; readonly answer: FakeAnswer }>();
  const drops: string[] = [];
  const failures: Array<{ readonly path: string; readonly answer: StripeFailureAnswer }> = [];
  let sequence = 0;
  const nextId = (kind: keyof typeof prefixes) => `${prefixes[kind]}_fake${String(++sequence).padStart(6, "0")}`;

  const prices: ReadonlyArray<CatalogPrice> = options.prices ?? catalogPrices;
  for (const price of prices) {
    objects.set(price.productId, { id: price.productId, object: "product", active: true, livemode: price.livemode ?? false });
    objects.set(price.priceId, {
      id: price.priceId,
      object: "price",
      active: true,
      currency: "usd",
      unit_amount: price.unitAmount,
      type: "recurring",
      billing_scheme: "per_unit",
      transform_quantity: null,
      livemode: price.livemode ?? false,
      product: price.productId,
      recurring: { interval: "month", interval_count: 1, trial_period_days: null, usage_type: "licensed" },
    });
  }

  const isKind = <K extends Kind>(kind: K) => (object: StripeObject | undefined): object is ObjectOf<K> => object?.object === kind;

  function find<K extends Kind>(kind: K, id: string): ObjectOf<K> | undefined {
    const found = objects.get(id);
    return isKind(kind)(found) ? found : undefined;
  }

  function keep<T extends StripeObject>(object: T): T {
    objects.set(object.id, object);
    return object;
  }

  function list<K extends Kind>(kind: K, query: Form, url: string, matches: (object: ObjectOf<K>) => boolean): List<ObjectOf<K>> {
    const all = [...objects.values()].filter(isKind(kind)).filter(matches).reverse();
    const after = text(query, "starting_after");
    const start = after === undefined ? 0 : all.findIndex((object) => object.id === after) + 1;
    const limit = Math.min(Math.max(Number(text(query, "limit") ?? 10), 1), 100);
    return { object: "list", data: all.slice(start, start + limit), has_more: start + limit < all.length, url };
  }

  const equalsQuery = (query: Form, key: string, value: string | null) => text(query, key) === undefined || text(query, key) === value;

  function expanded(object: StripeObject | List<StripeObject>, form: Form): unknown {
    const fields = strings(form, "expand");
    const one = (value: StripeObject) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !answeredOnlyWhenExpanded.has(key) || fields.includes(key)).map(([key, field]) => {
        const target = typeof field === "string" && fields.includes(key) ? objects.get(field) : undefined;
        return [key, target === undefined ? field : clone(target)];
      }));
    return object.object === "list" ? { ...object, data: object.data.map(one) } : one(object);
  }

  function createSession(form: Form): FakeAnswer {
    if (text(form, "mode") !== "subscription") return refuse(400, "The fake serves subscription checkouts only.", { param: "mode" });
    const lines = forms(form, "line_items");
    if (lines.length !== 1) return refuse(400, "A subscription checkout takes one line item.", { param: "line_items" });
    const priceId = text(lines[0], "price") ?? "";
    const price = find("price", priceId);
    if (price === undefined) return noSuch("price", priceId, "line_items[0][price]");
    if ((text(lines[0], "quantity") ?? "1") !== "1") return refuse(400, "The fake sells a quantity of one.", { param: "line_items[0][quantity]" });
    const customer = text(form, "customer");
    if (customer !== undefined && find("customer", customer) === undefined) return noSuch("customer", customer, "customer");
    const created = now();
    const expiresAt = Number(text(form, "expires_at") ?? created + 86_400);
    if (!Number.isInteger(expiresAt) || expiresAt < created + 1_800 || expiresAt > created + 86_400) {
      return refuse(400, "The `expires_at` timestamp must be between 30 minutes and 24 hours from the Checkout Session's creation.", { param: "expires_at" });
    }
    const uiMode = text(form, "ui_mode") ?? "hosted";
    if (uiMode !== "hosted" && uiMode !== "embedded") return refuse(400, `Invalid ui_mode: ${uiMode}`, { param: "ui_mode" });
    const redirect = text(form, "redirect_on_completion");
    if (redirect !== undefined && redirect !== "always" && redirect !== "if_required" && redirect !== "never") return refuse(400, `Invalid redirect_on_completion: ${redirect}`, { param: "redirect_on_completion" });
    const successUrl = text(form, "success_url") ?? null;
    const cancelUrl = text(form, "cancel_url") ?? null;
    const returnUrl = text(form, "return_url") ?? null;
    if (uiMode === "embedded" && (successUrl !== null || cancelUrl !== null)) return refuse(400, "success_url and cancel_url are not allowed with ui_mode embedded.", { param: successUrl === null ? "cancel_url" : "success_url" });
    if (uiMode === "embedded" && returnUrl === null && redirect !== "never") return refuse(400, "return_url is required with ui_mode embedded unless redirect_on_completion is never.", { param: "return_url" });
    if (uiMode === "hosted" && successUrl === null) return refuse(400, "Missing required param: success_url.", { param: "success_url" });
    if (uiMode === "hosted" && returnUrl !== null) return refuse(400, "return_url is only allowed with ui_mode embedded.", { param: "return_url" });
    const id = nextId("checkout.session");
    const methods = strings(form, "payment_method_types");
    const session = keep<StripeCheckoutSession>({
      id,
      object: "checkout.session",
      mode: "subscription",
      status: "open",
      payment_status: "unpaid",
      customer: customer ?? null,
      client_reference_id: text(form, "client_reference_id") ?? null,
      metadata: metadataOf(nested(form, "metadata")),
      subscription: null,
      invoice: null,
      ui_mode: uiMode,
      url: uiMode === "hosted" ? `https://checkout.stripe.com/c/pay/${id}` : null,
      client_secret: uiMode === "embedded" ? `${id}_secret_fake` : null,
      success_url: successUrl,
      cancel_url: cancelUrl,
      return_url: returnUrl,
      redirect_on_completion: uiMode === "embedded" ? (redirect ?? "always") : null,
      payment_method_types: methods.length > 0 ? methods : ["card"],
      allow_promotion_codes: text(form, "allow_promotion_codes") === "true",
      currency: "usd",
      amount_subtotal: price.unit_amount,
      amount_total: price.unit_amount,
      expires_at: expiresAt,
      created,
      livemode,
    });
    sessionTerms.set(id, { priceId, subscriptionMetadata: metadataOf(nested(nested(form, "subscription_data"), "metadata")) });
    return { status: 200, body: clone(session) };
  }

  function updateSubscription(subscription: StripeSubscription, form: Form): FakeAnswer {
    if (subscription.status === "canceled" || subscription.status === "incomplete_expired") return refuse(400, "A canceled subscription can only update its cancellation_details and metadata.");
    const changes = forms(form, "items").map((change) => ({ item: subscription.items.data.find((candidate) => candidate.id === text(change, "id")), itemId: text(change, "id") ?? "", priceId: text(change, "price") }));
    for (const { item, itemId, priceId } of changes) {
      if (item === undefined) return noSuch("subscription item", itemId, "items[0][id]");
      if (priceId !== undefined && find("price", priceId) === undefined) return noSuch("price", priceId, "items[0][price]");
    }
    for (const { item, priceId } of changes) {
      const price = priceId === undefined ? undefined : find("price", priceId);
      if (item !== undefined && price !== undefined) item.price = clone(price);
    }
    const cancel = text(form, "cancel_at_period_end");
    if (cancel !== undefined) {
      subscription.cancel_at_period_end = cancel === "true";
      subscription.cancel_at = subscription.cancel_at_period_end ? subscription.current_period_end : null;
    }
    subscription.metadata = { ...subscription.metadata, ...metadataOf(nested(form, "metadata")) };
    return { status: 200, body: clone(subscription) };
  }

  function cancelSubscription(subscription: StripeSubscription): FakeAnswer {
    if (subscription.status === "canceled") return refuse(400, `This subscription is already canceled: '${subscription.id}'`);
    const at = now();
    subscription.status = "canceled";
    subscription.canceled_at = at;
    subscription.ended_at = at;
    return { status: 200, body: clone(subscription) };
  }

  function expireSession(id: string): StripeCheckoutSession {
    const session = find("checkout.session", id);
    if (session === undefined || session.status !== "open") throw new Error(`checkout session ${id} is not open`);
    session.status = "expired";
    session.url = null;
    session.client_secret = null;
    return clone(session);
  }

  function completeSession(id: string, payment: "paid" | "unpaid" = "paid"): CompletedSession {
    const session = find("checkout.session", id);
    const terms = sessionTerms.get(id);
    if (session === undefined || terms === undefined || session.status !== "open") throw new Error(`checkout session ${id} is not open`);
    const price = find("price", terms.priceId);
    if (price === undefined) throw new Error(`price ${terms.priceId} left the catalog`);
    const at = now();
    const end = addMonth(at);
    const amount = price.unit_amount;
    const customer = session.customer ?? keep<StripeCustomer>({ id: nextId("customer"), object: "customer", email: null, name: null, metadata: {}, livemode, created: at }).id;
    const subscriptionId = nextId("subscription");
    const itemId = nextId("subscription_item");
    const invoiceId = nextId("invoice");
    const paid = payment === "paid";
    const paymentIntentId = paid ? nextId("payment_intent") : null;
    const chargeId = paid ? nextId("charge") : null;
    const subscription = keep<StripeSubscription>({
      id: subscriptionId,
      object: "subscription",
      customer,
      status: paid ? "active" : "incomplete",
      livemode,
      created: at,
      start_date: at,
      current_period_start: at,
      current_period_end: end,
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      latest_invoice: invoiceId,
      metadata: terms.subscriptionMetadata,
      currency: "usd",
      collection_method: "charge_automatically",
      schedule: null,
      items: { object: "list", has_more: false, url: `/v1/subscription_items?subscription=${subscriptionId}`, data: [{ id: itemId, object: "subscription_item", subscription: subscriptionId, price: clone(price), quantity: 1, current_period_start: at, current_period_end: end }] },
    });
    const invoice = keep<StripeInvoice>({
      id: invoiceId,
      object: "invoice",
      customer,
      subscription: subscriptionId,
      parent: { type: "subscription_details", subscription_details: { subscription: subscriptionId, metadata: terms.subscriptionMetadata } },
      livemode,
      billing_reason: "subscription_create",
      status: paid ? "paid" : "open",
      paid,
      paid_out_of_band: false,
      collection_method: "charge_automatically",
      currency: "usd",
      amount_due: amount,
      amount_paid: paid ? amount : 0,
      amount_remaining: paid ? 0 : amount,
      total: amount,
      subtotal: amount,
      starting_balance: 0,
      ending_balance: 0,
      pre_payment_credit_notes_amount: 0,
      post_payment_credit_notes_amount: 0,
      discount: null,
      discounts: [],
      total_discount_amounts: [],
      tax: null,
      total_tax_amounts: [],
      automatic_tax: { enabled: false, status: null },
      application: null,
      application_fee_amount: null,
      on_behalf_of: null,
      transfer_data: null,
      issuer: { type: "self" },
      payment_intent: paymentIntentId,
      charge: chargeId,
      payments: { object: "list", has_more: false, url: `/v1/invoice_payments?invoice=${invoiceId}`, data: paymentIntentId === null || chargeId === null ? [] : [{ object: "invoice_payment", amount_paid: amount, payment: { type: "payment_intent", payment_intent: paymentIntentId, charge: chargeId } }] },
      status_transitions: { paid_at: paid ? at : null },
      period_start: at,
      period_end: at,
      hosted_invoice_url: `https://invoice.stripe.com/i/${invoiceId}`,
      invoice_pdf: `https://pay.stripe.com/invoice/${invoiceId}/pdf`,
      created: at,
      lines: { object: "list", has_more: false, url: `/v1/invoices/${invoiceId}/lines`, data: [{ id: nextId("line_item"), object: "line_item", type: "subscription", subscription: subscriptionId, subscription_item: itemId, quantity: 1, proration: false, currency: "usd", amount, discounts: [], discount_amounts: [], tax_amounts: [], period: { start: at, end }, price: { id: price.id, product: price.product }, pricing: { price_details: { price: price.id } }, parent: { subscription_item_details: { subscription_item: itemId, proration: false } } }] },
    });
    session.status = "complete";
    session.payment_status = paid ? "paid" : "unpaid";
    session.customer = customer;
    session.subscription = subscriptionId;
    session.invoice = invoiceId;
    session.url = null;
    session.client_secret = null;
    if (paymentIntentId === null || chargeId === null) return { kind: "unpaid", session: clone(session), subscription: clone(subscription), invoice: clone(invoice) };
    const paymentIntent = keep<StripePaymentIntent>({ id: paymentIntentId, object: "payment_intent", amount, amount_received: amount, currency: "usd", customer, invoice: invoiceId, latest_charge: chargeId, status: "succeeded", livemode, created: at });
    const charge = keep<StripeCharge>({ id: chargeId, object: "charge", amount, amount_captured: amount, amount_refunded: 0, refunded: false, disputed: false, paid: true, captured: true, status: "succeeded", currency: "usd", customer, invoice: invoiceId, payment_intent: paymentIntentId, livemode, created: at, refunds: { object: "list", data: [], has_more: false, url: `/v1/charges/${chargeId}/refunds` } });
    return { kind: "paid", session: clone(session), subscription: clone(subscription), invoice: clone(invoice), paymentIntent: clone(paymentIntent), charge: clone(charge) };
  }

  function charged(id: string): StripeCharge {
    const charge = find("charge", id);
    if (charge === undefined) throw new Error(`the Stripe fake holds no charge ${id}`);
    return charge;
  }

  function refundCharge(id: string, amount?: number): StripeCharge {
    const charge = charged(id);
    const refundable = charge.amount - charge.amount_refunded;
    const refunded = amount ?? refundable;
    if (!Number.isInteger(refunded) || refunded <= 0 || refunded > refundable) throw new Error(`charge ${id} has ${refundable} cents left to refund, not ${refunded}`);
    const refund = keep<StripeRefund>({ id: nextId("refund"), object: "refund", amount: refunded, charge: id, payment_intent: charge.payment_intent, currency: "usd", status: "succeeded", created: now() });
    charge.amount_refunded += refunded;
    charge.refunded = charge.amount_refunded === charge.amount;
    charge.refunds.data.unshift(refund);
    return clone(charge);
  }

  function disputeCharge(id: string): StripeDispute {
    const charge = charged(id);
    if (charge.disputed) throw new Error(`charge ${id} is already disputed`);
    charge.disputed = true;
    return clone(keep<StripeDispute>({ id: nextId("dispute"), object: "dispute", amount: charge.amount - charge.amount_refunded, charge: id, payment_intent: charge.payment_intent, currency: "usd", status: "needs_response", reason: "fraudulent", livemode, created: now() }));
  }

  function resolveDispute(id: string, outcome: "won" | "lost"): StripeDispute {
    const dispute = find("dispute", id);
    if (dispute === undefined || dispute.status !== "needs_response") throw new Error(`dispute ${id} is not open`);
    dispute.status = outcome;
    return clone(dispute);
  }

  function route(request: FakeRequest): FakeAnswer | undefined {
    const form = parseForm(request.method === "GET" ? request.query.toString() : request.body);
    const [, version, resource, id, action] = request.path.split("/");
    if (version !== "v1") return undefined;
    const url = request.path;
    const read = (object: StripeObject | undefined, kind: string): FakeAnswer => (object === undefined ? noSuch(kind, id) : { status: 200, body: expanded(object, form) });
    switch (`${request.method} ${[resource, id === undefined ? undefined : ":id", action].filter((part) => part !== undefined).join("/")}`) {
      case "GET account":
        return { status: 200, body: { id: "acct_fake", object: "account", livemode } };
      case "GET prices/:id":
        return read(find("price", id), "price");
      case "GET products/:id":
        return read(find("product", id), "product");
      case "POST customers":
        return { status: 200, body: clone(keep<StripeCustomer>({ id: nextId("customer"), object: "customer", email: text(form, "email") ?? null, name: text(form, "name") ?? null, metadata: metadataOf(nested(form, "metadata")), livemode, created: now() })) };
      case "GET customers":
        return { status: 200, body: expanded(list("customer", form, url, (customer) => equalsQuery(form, "email", customer.email)), form) };
      case "GET customers/:id":
        return read(find("customer", id), "customer");
      case "POST customers/:id": {
        const customer = find("customer", id);
        if (customer === undefined) return noSuch("customer", id);
        customer.email = text(form, "email") ?? customer.email;
        customer.name = text(form, "name") ?? customer.name;
        customer.metadata = { ...customer.metadata, ...metadataOf(nested(form, "metadata")) };
        return { status: 200, body: clone(customer) };
      }
      case "POST checkout/:id":
        return id === "sessions" ? createSession(form) : undefined;
      case "GET checkout/:id":
        return id === "sessions"
          ? { status: 200, body: expanded(list("checkout.session", form, url, (session) => equalsQuery(form, "customer", session.customer) && equalsQuery(form, "status", session.status) && equalsQuery(form, "subscription", session.subscription)), form) }
          : undefined;
      case "GET subscriptions": {
        const status = text(form, "status");
        return { status: 200, body: expanded(list("subscription", form, url, (subscription) => equalsQuery(form, "customer", subscription.customer) && (status === "all" || (status === undefined ? subscription.status !== "canceled" : subscription.status === status))), form) };
      }
      case "GET subscriptions/:id":
        return read(find("subscription", id), "subscription");
      case "POST subscriptions/:id": {
        const subscription = find("subscription", id);
        return subscription === undefined ? noSuch("subscription", id) : updateSubscription(subscription, form);
      }
      case "DELETE subscriptions/:id": {
        const subscription = find("subscription", id);
        return subscription === undefined ? noSuch("subscription", id) : cancelSubscription(subscription);
      }
      case "GET invoices":
        return { status: 200, body: expanded(list("invoice", form, url, (invoice) => equalsQuery(form, "customer", invoice.customer) && equalsQuery(form, "subscription", invoice.subscription) && equalsQuery(form, "status", invoice.status)), form) };
      case "GET invoices/:id":
        return read(find("invoice", id), "invoice");
      case "GET invoice_payments": {
        const invoice = find("invoice", text(form, "invoice") ?? "");
        return invoice === undefined ? noSuch("invoice", text(form, "invoice") ?? "") : { status: 200, body: invoice.payments };
      }
      case "GET payment_intents/:id":
        return read(find("payment_intent", id), "payment_intent");
      case "GET charges/:id":
        return read(find("charge", id), "charge");
      case "GET refunds/:id":
        return read(find("refund", id), "refund");
      case "GET disputes":
        return { status: 200, body: list("dispute", form, url, (dispute) => equalsQuery(form, "charge", dispute.charge)) };
      case "GET disputes/:id":
        return read(find("dispute", id), "dispute");
      case "POST billing_portal/:id": {
        if (id !== "sessions") return undefined;
        const customer = text(form, "customer") ?? "";
        if (find("customer", customer) === undefined) return noSuch("customer", customer, "customer");
        const portalId = nextId("billing_portal.session");
        return { status: 200, body: clone(keep<StripePortalSession>({ id: portalId, object: "billing_portal.session", customer, return_url: text(form, "return_url") ?? null, url: `https://billing.stripe.com/p/session/test_${portalId}`, livemode, created: now() })) };
      }
      default:
        return undefined;
    }
  }

  function routeSession(request: FakeRequest): FakeAnswer | undefined {
    const match = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(request.path);
    if (match === null) return undefined;
    const session = find("checkout.session", match[1]);
    if (session === undefined) return noSuch("checkout.session", match[1]);
    if (match[2] === undefined) return request.method === "GET" ? { status: 200, body: expanded(session, parseForm(request.query.toString())) } : undefined;
    if (request.method !== "POST") return undefined;
    if (session.status !== "open") return refuse(400, `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "${session.status}".`, { code: "checkout_session_not_open" });
    return { status: 200, body: expireSession(session.id) };
  }

  function answer(request: FakeRequest): FakeAnswer | undefined {
    if (request.headers.authorization !== `Bearer ${fakeSecretKey}`) return refuse(401, "Invalid API Key provided.");
    const failure = failures.findIndex((candidate) => candidate.path === request.path);
    if (failure !== -1) {
      const [{ answer: failed }] = failures.splice(failure, 1);
      return refuse(failed.status, `The fake refused ${request.method} ${request.path}.`, { type: failed.type, ...(failed.code === undefined ? {} : { code: failed.code }) });
    }
    const header = request.headers["idempotency-key"];
    const key = request.method !== "GET" && typeof header === "string" ? header : undefined;
    const fingerprint = `${request.method} ${request.path} ${new URLSearchParams(request.body).toString()}`;
    const replay = key === undefined ? undefined : replies.get(key);
    if (replay !== undefined && replay.fingerprint !== fingerprint) {
      return refuse(400, `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`, { type: "idempotency_error" });
    }
    const answered = replay === undefined ? (routeSession(request) ?? route(request)) : { ...replay.answer, headers: { ...replay.answer.headers, "idempotent-replayed": "true" } };
    if (answered === undefined) return undefined;
    if (key !== undefined && replay === undefined && answered.status < 500) replies.set(key, { fingerprint, answer: clone(answered) });
    const drop = drops.indexOf(request.path);
    if (drop !== -1) {
      drops.splice(drop, 1);
      return refuse(504, "The fake dropped the reply after applying the request.", { type: "api_error" });
    }
    return { ...answered, headers: { "request-id": nextId("request"), ...answered.headers } };
  }

  return {
    handler: answer,
    object(id) {
      const found = objects.get(id);
      if (found === undefined) throw new Error(`the Stripe fake holds no ${id}`);
      return clone(found);
    },
    dropNextReply: (path) => {
      drops.push(path);
    },
    failNext: (path, failed) => {
      failures.push({ path, answer: failed });
    },
    completeSession,
    expireSession,
    refundCharge,
    disputeCharge,
    resolveDispute,
    signedEvent(type, object, eventOptions = {}) {
      const id = eventOptions.id ?? nextId("event");
      const timestamp = eventOptions.timestamp ?? now();
      const event: StripeEvent = {
        id,
        object: "event",
        type,
        created: timestamp,
        livemode: eventOptions.livemode ?? livemode,
        data: eventOptions.previousAttributes === undefined ? { object } : { object, previous_attributes: eventOptions.previousAttributes },
      };
      const raw = JSON.stringify(event);
      return { id, event, raw, header: signStripePayload(raw, eventOptions.secret ?? fakeWebhookSecret, timestamp) };
    },
    tamper,
  };
}

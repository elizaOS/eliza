// spec/cloud/billing/subscriptions.md, "Story: Keep my plan as the provider says it is"
import type { FakeAnswer, FakeHandler, FakeRequest } from "../fakes.ts";
import { fakeSecretKey, type StripeFake, type StripeInvoice, type StripeSubscription, type StripeSubscriptionStatus } from "./stripe.ts";

interface Patch {
  status?: StripeSubscriptionStatus;
  latestInvoice?: string;
  priceId?: string;
  periodStart?: number;
  periodEnd?: number;
}

type CycleInvoice = Pick<StripeInvoice, "id" | "object" | "customer" | "parent" | "livemode" | "currency" | "amount_due" | "amount_paid" | "period_start" | "period_end" | "hosted_invoice_url" | "created" | "lines"> & {
  readonly billing_reason: "subscription_cycle";
  readonly status: "paid" | "open";
  readonly attempted: boolean;
  readonly attempt_count: number;
};

export interface Subscribed {
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly invoiceId: string;
}

export interface SubscriptionLifecycle {
  readonly stripe: StripeFake;
  subscribe(priceId: string): Subscribed;
  renew(subscriptionId: string, outcome: "paid" | "failed", priceId?: string): CycleInvoice;
  lapse(subscriptionId: string, status: StripeSubscriptionStatus): void;
  cancel(subscriptionId: string): void;
}

const monthSeconds = 30 * 86_400;

export function withSubscriptionLifecycle(base: StripeFake): SubscriptionLifecycle {
  const patches = new Map<string, Patch>();
  const invoices = new Map<string, CycleInvoice>();
  let sequence = 0;

  const call = (method: string, path: string, form: Record<string, string> = {}): unknown => {
    const body = new URLSearchParams(form).toString();
    const answer = base.handler({ method, path, query: new URLSearchParams(method === "GET" ? body : ""), headers: { authorization: `Bearer ${fakeSecretKey}` }, body: method === "GET" ? "" : body, raw: new Uint8Array() });
    if (answer === undefined || answer instanceof Promise || answer.status !== 200) throw new Error(`the Stripe fake refused ${method} ${path}`);
    return answer.body;
  };

  const patched = (subscription: StripeSubscription): StripeSubscription => {
    const patch = patches.get(subscription.id);
    if (patch === undefined) return subscription;
    const item = subscription.items.data[0];
    const price = patch.priceId === undefined ? item.price : { ...item.price, id: patch.priceId };
    const periodStart = patch.periodStart ?? item.current_period_start;
    const periodEnd = patch.periodEnd ?? item.current_period_end;
    return {
      ...subscription,
      status: subscription.status === "canceled" ? subscription.status : patch.status ?? subscription.status,
      latest_invoice: patch.latestInvoice ?? subscription.latest_invoice,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      items: { ...subscription.items, data: [{ ...item, price, current_period_start: periodStart, current_period_end: periodEnd }] },
    };
  };

  const isSubscription = (value: unknown): value is StripeSubscription =>
    typeof value === "object" && value !== null && (value as { object?: unknown }).object === "subscription";

  const handler: FakeHandler = (request: FakeRequest): FakeAnswer | undefined | Promise<FakeAnswer | undefined> => {
    const [, version, resource, id] = request.path.split("/");
    if (version === "v1" && resource === "invoices" && id !== undefined && request.method === "GET" && request.headers.authorization === `Bearer ${fakeSecretKey}`) {
      const invoice = invoices.get(id);
      if (invoice !== undefined) return { status: 200, body: structuredClone(invoice) };
    }
    const answer = base.handler(request);
    if (answer === undefined || answer instanceof Promise || answer.status !== 200 || resource !== "subscriptions" || request.method !== "GET") return answer;
    const body = answer.body as { data?: unknown[] } | StripeSubscription;
    if (isSubscription(body)) return { ...answer, body: patched(body) };
    return { ...answer, body: { ...body, data: (body.data ?? []).map((each) => (isSubscription(each) ? patched(each) : each)) } };
  };

  const current = (subscriptionId: string): StripeSubscription => {
    const found = base.object(subscriptionId);
    if (!isSubscription(found)) throw new Error(`the Stripe fake holds no subscription ${subscriptionId}`);
    return patched(found);
  };

  const stripe: StripeFake = { ...base, handler };

  return {
    stripe,
    subscribe(priceId) {
      const customer = call("POST", "/v1/customers") as { id: string };
      const session = call("POST", "/v1/checkout/sessions", {
        mode: "subscription", customer: customer.id, "line_items[0][price]": priceId, "line_items[0][quantity]": "1", success_url: "https://example.test/return",
      }) as { id: string };
      const paid = base.completeSession(session.id);
      return { customerId: customer.id, subscriptionId: paid.subscription.id, invoiceId: paid.invoice.id };
    },
    renew(subscriptionId, outcome, priceId) {
      const subscription = current(subscriptionId);
      const item = subscription.items.data[0];
      const price = priceId ?? item.price.id;
      const amount = (base.object(price) as { unit_amount: number }).unit_amount;
      const start = item.current_period_end;
      const end = start + monthSeconds;
      const id = `in_cycle${String(++sequence).padStart(6, "0")}`;
      const invoice: CycleInvoice = {
        id, object: "invoice", customer: subscription.customer, livemode: subscription.livemode, currency: "usd", billing_reason: "subscription_cycle",
        status: outcome === "paid" ? "paid" : "open", attempted: true, attempt_count: outcome === "paid" ? 0 : 1,
        amount_due: amount, amount_paid: outcome === "paid" ? amount : 0, period_start: item.current_period_start, period_end: start,
        hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, created: start,
        parent: { type: "subscription_details", subscription_details: { subscription: subscriptionId, metadata: subscription.metadata } },
        lines: {
          object: "list", has_more: false, url: `/v1/invoices/${id}/lines`,
          data: [{
            id: `il_cycle${String(sequence).padStart(6, "0")}`, object: "line_item", type: "subscription", subscription: subscriptionId, subscription_item: item.id,
            quantity: 1, proration: false, currency: "usd", amount, discounts: [], discount_amounts: [], tax_amounts: [], period: { start, end },
            price: { id: price, product: item.price.product }, pricing: { price_details: { price } },
            parent: { subscription_item_details: { subscription_item: item.id, proration: false } },
          }],
        },
      };
      invoices.set(id, invoice);
      patches.set(subscriptionId, { ...patches.get(subscriptionId), latestInvoice: id, priceId: price, periodStart: start, periodEnd: end, status: "active" });
      return structuredClone(invoice);
    },
    lapse(subscriptionId, status) {
      current(subscriptionId);
      patches.set(subscriptionId, { ...patches.get(subscriptionId), status });
    },
    cancel(subscriptionId) {
      call("DELETE", `/v1/subscriptions/${subscriptionId}`);
    },
  };
}

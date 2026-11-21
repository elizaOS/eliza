// spec/cloud/billing/subscriptionCommands.md, "Story: Change or cancel my plan without paying twice"
import type { FakeAnswer, FakeHandler } from "../fakes.ts";
import { catalogPrices } from "../profile.ts";
import { fakeSecretKey, parseForm, type StripeFake, type StripeObject } from "./stripe.ts";

const isSubscription = (object: StripeObject): object is Extract<StripeObject, { readonly object: "subscription" }> => object.object === "subscription";

export function stripeRenewalPreview(stripe: StripeFake): FakeHandler {
  return (request) => {
    if (request.method !== "POST" || request.path !== "/v1/invoices/create_preview") return undefined;
    if (request.headers.authorization !== `Bearer ${fakeSecretKey}`) return { status: 401, body: { error: { type: "invalid_request_error", message: "Invalid API Key provided." } } };
    const form = parseForm(request.body);
    const id = typeof form.subscription === "string" ? form.subscription : "";
    const subscription = (() => {
      try {
        return stripe.object(id);
      } catch {
        return undefined;
      }
    })();
    if (subscription === undefined || !isSubscription(subscription) || subscription.customer !== form.customer) {
      return { status: 404, body: { error: { type: "invalid_request_error", code: "resource_missing", message: `No such subscription: '${id}'` } } };
    }
    const item = subscription.items.data[0];
    const amount = item.price.unit_amount;
    return {
      status: 200,
      body: {
        object: "invoice",
        customer: subscription.customer,
        subscription: subscription.id,
        currency: "usd",
        amount_due: amount,
        subtotal: amount,
        total: amount,
        starting_balance: 0,
        period_start: item.current_period_end,
        period_end: item.current_period_end,
        next_payment_attempt: item.current_period_end,
        lines: { object: "list", has_more: false, data: [{ object: "line_item", amount, period: { start: item.current_period_end, end: item.current_period_end + (item.current_period_end - item.current_period_start) }, pricing: { price_details: { price: item.price.id } } }] },
      },
    };
  };
}


export function stripePlanPreview(stripe: StripeFake, respond: (mode: string, answer: FakeAnswer) => FakeAnswer | Promise<FakeAnswer>): FakeHandler {
  return (request) => {
    if (request.path !== "/v1/invoices/create_preview" || request.method !== "POST") return undefined;
    if (request.headers.authorization !== `Bearer ${fakeSecretKey}`) return { status: 401, body: { error: { type: "invalid_request_error" } } };
    const form = new URLSearchParams(request.body);
    const mode = form.get("preview_mode");
    if (mode === null) return undefined;
    const id = form.get("subscription");
    const source = id === null ? undefined : stripe.object(id);
    const item = source && isSubscription(source) ? source.items.data[0] : undefined;
    const target = catalogPrices.find((price) => price.priceId === form.get("subscription_details[items][0][price]"));
    if (!source || !isSubscription(source) || !item || !target || source.customer !== form.get("customer") ||
      item.id !== form.get("subscription_details[items][0][id]") || form.get("subscription_details[items][0][quantity]") !== "1") {
      return { status: 400, body: { error: { type: "invalid_request_error" } } };
    }
    const proration = mode === "next";
    const start = proration ? Number(form.get("subscription_details[proration_date]")) : item.current_period_end;
    const end = proration ? item.current_period_end : start + item.current_period_end - item.current_period_start;
    if (mode !== "recurring" && (!proration || form.get("subscription_details[proration_behavior]") !== "always_invoice" ||
      !Number.isSafeInteger(start) || start < item.current_period_start || start >= end))
      return { status: 400, body: { error: { type: "invalid_request_error" } } };
    const amount = (value: number) => proration
      ? Math.round(value * (end - start) / (item.current_period_end - item.current_period_start))
      : value;
    const line = (price: string, cents: number) => ({
      id: `il_${price}`, amount: cents, currency: "usd", quantity: 1,
      period: { start, end }, pricing: { price_details: { price } },
      parent: { subscription_item_details: { subscription_item: item.id, proration } },
    });
    const charge = line(target.priceId, amount(target.unitAmount));
    const lines = proration ? [line(item.price.id, -amount(item.price.unit_amount)), charge] : [charge];
    return respond(mode, {
      status: 200,
      body: {
        id: "upcoming_in_planchangetest", customer: source.customer, status: "draft",
        amount_due: lines.reduce((sum, each) => sum + each.amount, 0), amount_paid: 0,
        currency: "usd", created: start, livemode: source.livemode, period_start: start, period_end: end,
        parent: { subscription_details: { subscription: source.id } }, lines: { has_more: false, data: lines },
      },
    });
  };
}

export function stripePlanUpgrade(stripe: StripeFake, now: () => number) {
  type Subscription = Extract<StripeObject, { readonly object: "subscription" }>;
  type State = ReturnType<typeof changed>;
  const dispatched = new Map<string, State>();
  const preview = stripePlanPreview(stripe, (_mode, answer) => answer);
  let loseNext = false;
  let showOrigin = false;

  function changed(subscription: Subscription, key: string, revision: number, at: number) {
    const item = subscription.items.data[0];
    const target = catalogPrices[1];
    const targetPrice = { ...item.price, id: target.priceId, unit_amount: target.unitAmount };
    const end = item.current_period_end;
    const fraction = (end - at) / (end - item.current_period_start);
    const charge = Math.round(target.unitAmount * fraction);
    const credit = Math.round(item.price.unit_amount * fraction);
    const due = charge - credit;
    const line = (price: string, amount: number) => ({
      id: `il_${price}`, amount, currency: "usd", quantity: 1,
      period: { start: at, end }, pricing: { price_details: { price } },
      parent: { subscription_item_details: { subscription_item: item.id, proration: true } },
    });
    const invoice = {
      id: `in_upgrade${revision}`, customer: subscription.customer, status: "open", billing_reason: "subscription_update",
      amount_due: due, amount_paid: 0, currency: "usd", created: Math.floor(now() / 1000),
      livemode: false, period_start: at, period_end: end,
      hosted_invoice_url: `https://invoice.stripe.com/i/test-upgrade-${revision}`,
      parent: { subscription_details: { subscription: subscription.id } },
      lines: { has_more: false, data: [line(item.price.id, -credit), line(target.priceId, charge)] },
    };
    return { invoice, targetPrice, subscription, key, requestId: `req_upgrade${revision}` };
  }

  const handler: FakeHandler = (request) => {
    const id = /^\/v1\/subscriptions\/([^/]+)$/.exec(request.path)?.[1];
    if (request.method === "POST" && id !== undefined) {
      const form = new URLSearchParams(request.body);
      if (form.get("payment_behavior") !== "pending_if_incomplete") return stripe.handler(request);
      const subscription = stripe.object(id);
      const key = request.headers["idempotency-key"];
      if (!isSubscription(subscription) || typeof key !== "string" || dispatched.has(id) ||
        request.headers.authorization !== `Bearer ${fakeSecretKey}` || form.get("proration_behavior") !== "always_invoice" ||
        form.get("expand[]") !== "latest_invoice" || form.get("items[0][id]") !== subscription.items.data[0].id ||
        form.get("items[0][price]") !== catalogPrices[1].priceId || form.get("items[0][quantity]") !== "1") {
        return { status: 400, body: { error: { type: "invalid_request_error" } } };
      }
      const entry = changed(subscription, key, dispatched.size + 1, Number(form.get("proration_date")));
      dispatched.set(id, entry);
      if (loseNext) {
        loseNext = false;
        return { status: 503, body: { error: { type: "api_error" } } };
      }
      return { status: 200, headers: { "request-id": entry.requestId, "idempotency-key": key },
        body: { ...subscription, latest_invoice: entry.invoice } };
    }
    if (request.method === "GET" && id !== undefined) {
      const entry = dispatched.get(id);
      if (entry !== undefined) {
        const sub = entry.subscription;
        const items = entry.invoice.status === "paid"
          ? { ...sub.items, data: [{ ...sub.items.data[0], price: entry.targetPrice }] }
          : sub.items;
        return { status: 200, body: { ...sub, items, latest_invoice: entry.invoice.id } };
      }
    }
    if (request.method === "GET" && request.path === "/v1/events") {
      return { status: 200, body: { data: [...dispatched.values()].map((entry, index) => ({
        id: `evt_upgrade${index}`, type: "invoice.created", created: entry.invoice.created,
        livemode: false, request: { id: entry.requestId, idempotency_key: showOrigin ? entry.key : `unrelated-${entry.key}` },
        data: { object: entry.invoice },
      })) } };
    }
    const invoiceId = /^\/v1\/invoices\/([^/]+)$/.exec(request.path)?.[1];
    if (request.method === "GET" && invoiceId !== undefined) {
      const entry = [...dispatched.values()].find((record) => record.invoice.id === invoiceId);
      if (entry !== undefined) return { status: 200, body: entry.invoice };
    }
    return preview(request) ?? stripe.handler(request);
  };

  return {
    handler,
    loseNextReply: () => { loseNext = true; },
    showInvoiceOrigins: () => { showOrigin = true; },
    settle: (id: string, status: "paid" | "void") => {
      const entry = dispatched.get(id);
      if (entry === undefined) throw new Error("Missing fixture upgrade");
      entry.invoice.status = status;
      entry.invoice.amount_paid = status === "paid" ? entry.invoice.amount_due : 0;
    },
  };
}

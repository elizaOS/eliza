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

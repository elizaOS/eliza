// spec/cloud/billing/subscriptionCommands.md, "Story: Change or cancel my plan without paying twice"
import type { FakeHandler } from "../fakes.ts";
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

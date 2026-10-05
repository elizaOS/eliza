/** Supplies read-only historical billing responses through the real Stripe SDK, including invoice lines and captured payment identity. */
import Stripe from "stripe";
export interface HistoricalStripeSubscription {
  id: string;
  customerId: string;
  quantity: number;
  status: "active" | "trialing" | "canceled";
  periodStart: number;
  periodEnd: number;
  trialStart: number | null;
  trialEnd: number | null;
  invoiceId: string | null;
}
export function createImportStripeFixture() {
  const subscriptions = new Map<string, HistoricalStripeSubscription>();
  const requests: {
    method: string;
    path: string;
    account: string | null;
    version: string | null;
  }[] = [];
  let extraInvoiceCustomer: string | null = null;
  let wrongMode = false;
  let beforeRead: (() => Promise<void>) | null = null;
  const price = {
    id: "price_basic",
    object: "price",
    active: true,
    livemode: false,
    product: "prod_basic",
    currency: "usd",
    unit_amount: 3000,
    type: "recurring",
    billing_scheme: "per_unit",
    transform_quantity: null,
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: "licensed",
      trial_period_days: null,
    },
  };
  const project = (row: HistoricalStripeSubscription) => ({
    id: row.id,
    object: "subscription",
    customer: row.customerId,
    livemode: wrongMode,
    metadata: {},
    status: row.status,
    current_period_start: row.periodStart,
    current_period_end: row.periodEnd,
    trial_start: row.trialStart,
    trial_end: row.trialEnd,
    cancel_at_period_end: false,
    canceled_at: row.status === "canceled" ? row.periodStart : null,
    ended_at: row.status === "canceled" ? row.periodStart : null,
    latest_invoice: row.invoiceId,
    pending_update: null,
    items: {
      has_more: false,
      data: [{ id: `si_${row.id.replace("sub_", "")}`, quantity: row.quantity, price }],
    },
  });
  const invoice = (row: HistoricalStripeSubscription) => ({
    id: row.invoiceId,
    object: "invoice",
    customer: row.customerId,
    subscription: row.id,
    livemode: false,
    hosted_invoice_url: null,
    charge: "ch_original",
    payment_intent: `pi_${row.id.replace("sub_", "")}`,
    status: "paid",
    paid: true,
    paid_out_of_band: false,
    amount_paid: 3000,
    amount_due: 3000,
    billing_reason: "subscription_cycle",
    subtotal: 3000,
    subtotal_excluding_tax: 3000,
    total: 3000,
    tax: 0,
    total_discount_amounts: [],
    currency: "usd",
    period_start: row.periodStart,
    period_end: row.periodEnd,
  });
  const stripe = new Stripe("sk_test_historical_fixture", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const url = new URL(String(input)),
        headers = new Headers(init?.headers),
        method = init?.method ?? "GET";
      requests.push({
        method,
        path: url.pathname,
        account: headers.get("stripe-account"),
        version: headers.get("stripe-version"),
      });
      if (method !== "GET")
        throw new Error("Historical billing import attempted a provider mutation");
      if (beforeRead) await beforeRead();
      if (url.pathname === "/v1/balance")
        return Response.json({ object: "balance", livemode: false, available: [], pending: [] });
      if (url.pathname === "/v1/accounts/acct_runtime")
        return Response.json({
          id: "acct_runtime",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          capabilities: { card_payments: "active", transfers: "active" },
          requirements: { disabled_reason: null, currently_due: [] },
        });
      if (url.pathname === "/v1/prices/price_basic") return Response.json(price);
      if (url.pathname === "/v1/products/prod_basic")
        return Response.json({
          id: "prod_basic",
          object: "product",
          active: true,
          livemode: false,
        });
      if (url.pathname.startsWith("/v1/customers/"))
        return Response.json({
          id: url.pathname.split("/")[3],
          object: "customer",
          livemode: false,
          metadata: {},
        });
      const list = (data: object[]) =>
        Response.json({ object: "list", has_more: false, url: url.pathname, data });
      if (url.pathname === "/v1/subscriptions")
        return list(
          [...subscriptions.values()]
            .filter((r) => r.customerId === url.searchParams.get("customer"))
            .map(project),
        );
      if (url.pathname.startsWith("/v1/subscriptions/")) {
        const row = subscriptions.get(url.pathname.split("/")[3]!);
        if (row) return Response.json(project(row));
      }
      if (url.pathname === "/v1/invoices") {
        const data: object[] = [...subscriptions.values()]
          .filter((r) => r.customerId === url.searchParams.get("customer") && r.invoiceId !== null)
          .map(invoice);
        if (extraInvoiceCustomer === url.searchParams.get("customer"))
          data.push({
            id: "in_unrelated",
            customer: extraInvoiceCustomer,
            subscription: null,
            livemode: false,
          });
        return list(data);
      }
      const row = [...subscriptions.values()].find(
        (r) => r.invoiceId === url.pathname.split("/")[3],
      );
      if (row && url.pathname.endsWith("/lines"))
        return list([
          {
            id: "il_original",
            type: "subscription",
            subscription: row.id,
            subscription_item: `si_${row.id.replace("sub_", "")}`,
            price: { id: price.id },
            quantity: row.quantity,
            amount: 3000,
            discount_amounts: [],
            tax_amounts: [],
            period: { start: row.periodStart, end: row.periodEnd },
            proration: false,
          },
        ]);
      if (row && url.pathname.startsWith("/v1/invoices/")) return Response.json(invoice(row));
      if (url.pathname.startsWith("/v1/payment_intents/")) {
        const source = [...subscriptions.values()].find(
          (r) => `pi_${r.id.replace("sub_", "")}` === url.pathname.split("/")[3],
        );
        if (source)
          return Response.json({
            id: url.pathname.split("/")[3],
            object: "payment_intent",
            livemode: false,
            customer: source.customerId,
            currency: "usd",
            amount_received: 3000,
            invoice: source.invoiceId,
            status: "succeeded",
          });
      }
      return Response.json(
        { error: { message: "Historical provider fixture object unavailable" } },
        { status: 404 },
      );
    }),
  });
  return {
    stripe,
    subscriptions,
    requests,
    setExtraInvoiceCustomer(value: string | null) {
      extraInvoiceCustomer = value;
    },
    setWrongMode(value: boolean) {
      wrongMode = value;
    },
    beforeRead(hook: (() => Promise<void>) | null) {
      beforeRead = hook;
    },
  };
}

/** Exercises production billing adapters through the real Stripe SDK and controlled HTTP responses. */
import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import {
  type BillingProviderMerchant,
  type BillingProviderPlan,
  type BillingProviderScope,
  createGenericBillingProvider,
  type DurableProviderIntent,
} from "./generic-billing-provider";

const scope: BillingProviderScope = {
  scopeId: "scope-one",
  appId: "app-one",
  billingAccountId: "buyer-one",
};
const merchant: BillingProviderMerchant = {
  merchantId: "merchant-one",
  kind: "connected",
  stripeAccountId: "acct_one",
  livemode: false,
};
const intent: DurableProviderIntent = {
  commandId: "command-one",
  idempotencyKey: "command-one:provider",
  requestDigest: "a".repeat(64),
};
const plan: BillingProviderPlan = {
  planRevisionId: "revision-one",
  priceId: "price_one",
  productId: "prod_one",
  amountCents: 1500,
  currency: "usd",
  interval: "month",
  intervalCount: 1,
  minimumQuantity: 1,
  maximumQuantity: 100,
  trialDays: 7,
};
const tags = {
  eliza_billing_scope_id: scope.scopeId,
  eliza_app_id: scope.appId,
  eliza_billing_account_id: scope.billingAccountId,
  eliza_merchant_id: merchant.merchantId,
};

function fixture(binding = merchant) {
  const requests: {
    path: string;
    method: string;
    headers: Headers;
    body: URLSearchParams;
    query: URLSearchParams;
  }[] = [];
  const state = {
    foreign: false,
    livemode: false,
    priceAmount: 1500,
    trial: false,
    basil: false,
    pending: false,
    resumePending: false,
    paused: false,
    subscriptionStatus: null as string | null,
    latestInvoiceId: "in_one",
    paymentStatus: null as string | null,
    payFailure: null as "card" | "transport" | null,
    payTimeoutAfterSuccess: false,
    canceled: false,
    cancelAtPeriodEnd: false,
    expired: false,
    quantity: 3,
    priceId: "price_one",
    portalUpdates: true,
    invoiceAmount: 1500,
    amountRefunded: 0,
    invoiceCreated: 1700000100,
    invoiceUrl: "https://invoice.stripe.com/i/fixture",
    invoiceCustomer: "cus_one",
    invoiceLivemode: false,
    invoiceStatus: "paid" as "paid" | "open" | "void",
    invoiceReason: "subscription_cycle",
    pendingPrice: "price_two",
    pendingQuantity: 4,
    invoiceSubscription: "sub_one",
    page: false,
    customerFailure: false,
    customerMissing: false,
    deletedCustomer: false,
    contradictoryTombstone: false,
    credentialLivemode: false,
    wrongCustomerId: false,
    setupComplete: false,
    foreignPaymentMethod: false,
    missingMetadata: false,
    changedPreview: false,
    delayedTrialStart: false,
    outOfBand: false,
    foreignInvoicePayment: false,
    missingCommand: false,
    checkoutMode: "subscription" as "subscription" | "setup",
    duplicateCheckout: false,
    wrongCheckoutQuantity: false,
    wrongCheckoutUrl: false,
    refundDiscovery: "found" as
      | "found"
      | "absent"
      | "wrong-digest"
      | "wrong-scope"
      | "duplicate"
      | "later-page",
  };
  const price = (priceId = state.priceId) => ({
    id: priceId,
    object: "price",
    active: true,
    livemode: false,
    product: "prod_one",
    currency: "usd",
    unit_amount: state.priceAmount,
    type: "recurring",
    billing_scheme: "per_unit",
    transform_quantity: null,
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: "licensed",
      trial_period_days: null,
    },
  });
  const subscription = (subscriptionId = "sub_one") => ({
    id: subscriptionId,
    object: "subscription",
    customer: "cus_one",
    livemode: state.livemode,
    metadata: state.missingMetadata
      ? {}
      : {
          ...tags,
          eliza_command_id: state.missingCommand ? "other-command" : intent.commandId,
          eliza_request_digest: intent.requestDigest,
          eliza_plan_revision_id: plan.planRevisionId,
        },
    status:
      state.subscriptionStatus ??
      (state.canceled ? "canceled" : state.paused ? "paused" : state.trial ? "trialing" : "active"),
    ...(state.basil ? {} : { current_period_start: 1700000000, current_period_end: 1702592000 }),
    trial_start: state.trial ? (state.delayedTrialStart ? 1700000030 : 1700000000) : null,
    trial_end: state.trial ? 1700604800 : null,
    cancel_at_period_end: state.cancelAtPeriodEnd,
    canceled_at: state.canceled ? 1700000100 : null,
    ended_at: state.canceled ? 1700000100 : null,
    latest_invoice: state.latestInvoiceId,
    pending_update: state.resumePending
      ? { expires_at: 1700100000, subscription_items: null }
      : state.pending
        ? {
            expires_at: 1700100000,
            subscription_items: [
              { id: "si_one", price: state.pendingPrice, quantity: state.pendingQuantity },
            ],
          }
        : null,
    items: {
      has_more: false,
      data: [
        {
          id: "si_one",
          quantity: state.quantity,
          price: price(),
          ...(state.basil
            ? { current_period_start: 1700000000, current_period_end: 1702592000 }
            : {}),
        },
      ],
    },
  });
  const checkout = () => ({
    id: "cs_one",
    object: "checkout.session",
    mode: "subscription",
    invoice: null,
    success_url: state.wrongCheckoutUrl
      ? "https://wrong.test/success"
      : "https://app.example/success",
    cancel_url: "https://app.example/cancel",
    payment_method_collection: state.trial ? "if_required" : "always",
    customer: "cus_one",
    subscription: null,
    livemode: false,
    metadata: state.missingMetadata
      ? {}
      : {
          ...tags,
          eliza_command_id: state.missingCommand ? "other-command" : intent.commandId,
          eliza_request_digest: intent.requestDigest,
          eliza_plan_revision_id: plan.planRevisionId,
          eliza_trial_start: state.trial ? "1700000000" : "none",
          eliza_trial_end: state.trial ? "1700604800" : "none",
        },
    status: state.expired ? "expired" : "open",
    payment_status: "no_payment_required",
    url: "https://checkout.stripe.com/c/pay/fixture",
    expires_at: 1700001000,
  });
  const setupCheckout = () => ({
    id: "cs_setup",
    object: "checkout.session",
    mode: "setup",
    customer: "cus_one",
    livemode: state.livemode,
    metadata: state.missingMetadata
      ? {}
      : {
          ...tags,
          eliza_subscription_id: "sub_one",
          eliza_command_id: state.missingCommand ? "other-command" : intent.commandId,
          eliza_request_digest: intent.requestDigest,
        },
    status: state.expired ? "expired" : state.setupComplete ? "complete" : "open",
    url: "https://checkout.stripe.com/c/setup/fixture",
    setup_intent: "seti_one",
    expires_at: 1700001000,
    success_url: state.wrongCheckoutUrl
      ? "https://wrong.test/success"
      : "https://app.example/success",
    cancel_url: "https://app.example/cancel",
    currency: "usd",
  });
  const stripe = new Stripe("sk_test_controlled_fixture", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = new URLSearchParams(String(init?.body ?? ""));
      requests.push({
        path: url.pathname,
        method,
        headers: new Headers(init?.headers),
        body,
        query: url.searchParams,
      });
      let result: unknown;
      if (url.pathname === "/v1/balance")
        result = { object: "balance", livemode: state.credentialLivemode };
      else if (url.pathname === "/v1/accounts/acct_one")
        result = {
          id: "acct_one",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          capabilities: { card_payments: "active", transfers: "active" },
          requirements: { disabled_reason: null, currently_due: [] },
        };
      else if (url.pathname === "/v1/customers" && method === "GET")
        result = {
          object: "list",
          has_more: false,
          url: "/v1/customers",
          data: [
            {
              id: "cus_one",
              object: "customer",
              livemode: false,
              metadata: {
                ...tags,
                eliza_command_id: state.missingCommand ? "other-command" : intent.commandId,
                eliza_request_digest: intent.requestDigest,
              },
            },
          ],
        };
      else if (url.pathname === "/v1/customers" || url.pathname === "/v1/customers/cus_one") {
        if (state.customerMissing)
          return Response.json(
            {
              error: {
                type: "invalid_request_error",
                code: "resource_missing",
                message: "controlled missing customer",
              },
            },
            { status: 404 },
          );
        if (state.customerFailure)
          return Response.json(
            { error: { type: "api_error", message: "controlled unavailability" } },
            { status: 503 },
          );
        result = state.deletedCustomer
          ? {
              id: state.wrongCustomerId ? "cus_other" : "cus_one",
              object: "customer",
              deleted: true,
              ...(state.contradictoryTombstone
                ? { livemode: true, metadata: { eliza_app_id: "foreign-app" } }
                : {}),
            }
          : {
              id: state.wrongCustomerId ? "cus_other" : "cus_one",
              object: "customer",
              livemode: state.livemode,
              metadata: state.missingMetadata
                ? {}
                : { ...tags, ...(state.foreign ? { eliza_app_id: "other-app" } : {}) },
            };
      } else if (url.pathname.startsWith("/v1/prices/"))
        result = price(url.pathname.split("/").at(-1));
      else if (url.pathname === "/v1/products/prod_one")
        result = { id: "prod_one", object: "product", active: true, livemode: false };
      else if (url.pathname === "/v1/subscriptions" && method === "POST") {
        state.trial = true;
        result = subscription();
      } else if (url.pathname === "/v1/subscriptions" && method === "GET")
        result = {
          object: "list",
          has_more: state.page && !url.searchParams.has("starting_after"),
          url: "/v1/subscriptions",
          data: [subscription(url.searchParams.has("starting_after") ? "sub_two" : "sub_one")],
        };
      else if (url.pathname === "/v1/subscriptions/sub_one/resume") result = subscription();
      else if (url.pathname === "/v1/subscriptions/sub_one") {
        if (method === "DELETE") state.canceled = true;
        if (body.has("cancel_at_period_end"))
          state.cancelAtPeriodEnd = body.get("cancel_at_period_end") === "true";
        if (method === "POST" && !state.pending && body.has("items[0][price]")) {
          state.priceId = body.get("items[0][price]")!;
          state.quantity = Number(body.get("items[0][quantity]"));
        }
        result = subscription();
      } else if (url.pathname === "/v1/checkout/sessions" && method === "GET") {
        const session = state.checkoutMode === "setup" ? setupCheckout() : checkout();
        result = {
          object: "list",
          has_more: false,
          url: "/v1/checkout/sessions",
          data: [session, ...(state.duplicateCheckout ? [{ ...session, id: "cs_duplicate" }] : [])],
        };
      } else if (
        url.pathname.startsWith("/v1/checkout/sessions/") &&
        url.pathname.endsWith("/line_items")
      ) {
        result = {
          object: "list",
          has_more: false,
          url: url.pathname,
          data: [{ price: price(), quantity: state.wrongCheckoutQuantity ? 99 : state.quantity }],
        };
      } else if (url.pathname === "/v1/checkout/sessions/cs_setup/expire") {
        state.expired = true;
        result = setupCheckout();
      } else if (
        (url.pathname === "/v1/checkout/sessions" && body.get("mode") === "setup") ||
        url.pathname === "/v1/checkout/sessions/cs_setup"
      )
        result = setupCheckout();
      else if (url.pathname === "/v1/setup_intents/seti_one")
        result = {
          id: "seti_one",
          object: "setup_intent",
          customer: "cus_one",
          livemode: false,
          metadata: state.missingMetadata
            ? {}
            : {
                ...tags,
                eliza_subscription_id: "sub_one",
                eliza_command_id: intent.commandId,
                eliza_request_digest: intent.requestDigest,
              },
          status: "succeeded",
          payment_method: "pm_one",
        };
      else if (url.pathname === "/v1/payment_methods/pm_one")
        result = {
          id: "pm_one",
          object: "payment_method",
          customer: state.foreignPaymentMethod ? "cus_other" : "cus_one",
          livemode: false,
        };
      else if (
        url.pathname === "/v1/checkout/sessions" ||
        url.pathname === "/v1/checkout/sessions/cs_one"
      )
        result = checkout();
      else if (url.pathname === "/v1/checkout/sessions/cs_one/expire") {
        state.expired = true;
        result = checkout();
      } else if (url.pathname === "/v1/billing_portal/configurations") {
        state.portalUpdates = body.get("features[subscription_update][enabled]") === "true";
        result = { id: "bpc_one", object: "billing_portal.configuration" };
      } else if (url.pathname === "/v1/billing_portal/sessions")
        result = {
          id: "bps_one",
          object: "billing_portal.session",
          customer: "cus_one",
          livemode: false,
          url: "https://billing.stripe.com/p/session/fixture",
        };
      else if (url.pathname === "/v1/invoices/create_preview") {
        const recurring = body.get("preview_mode") === "recurring";
        const amount = recurring || state.trial ? 6000 : state.changedPreview ? 550 : 500;
        result = {
          id: `upcoming_in_${requests.length}`,
          object: "invoice",
          hosted_invoice_url: "https://invoice.stripe.com/i/fixture",
          livemode: false,
          customer: "cus_one",
          subscription: state.invoiceSubscription,
          charge: null,
          payment_intent: null,
          status: "draft",
          paid: false,
          paid_out_of_band: false,
          amount_paid: 0,
          amount_due: amount + 50,
          billing_reason: "subscription_update",
          subtotal: amount,
          subtotal_excluding_tax: amount,
          total: amount + 50,
          tax: 50,
          total_discount_amounts: [],
          currency: "usd",
          period_start: 1700000000,
          period_end: 1702592000,
          automatic_tax: { enabled: true, status: "complete" },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${requests.length}`,
                type: "subscription",
                subscription: state.invoiceSubscription,
                subscription_item: "si_one",
                price: { id: "price_two" },
                quantity: 4,
                amount,
                discount_amounts: [],
                tax_amounts: [{ amount: 50 }],
                period: {
                  start: recurring || state.trial ? 1702592000 : 1700000100,
                  end: 1702592000,
                },
                proration: !recurring && !state.trial,
              },
            ],
          },
        };
      } else if (url.pathname === "/v1/invoices/in_one/pay") {
        if (state.payFailure === "transport") throw new Error("controlled network failure");
        if (state.payFailure === "card") {
          state.paymentStatus = "requires_action";
          return Response.json(
            {
              error: {
                type: "card_error",
                code: "invoice_payment_intent_requires_action",
                message: "Authentication required",
              },
            },
            { status: 402 },
          );
        }
        state.invoiceStatus = "paid";
        state.paymentStatus = "succeeded";
        state.paused = false;
        state.resumePending = false;
        if (state.payTimeoutAfterSuccess) throw new Error("controlled lost successful response");
        result = { id: "in_one", object: "invoice" };
      } else if (url.pathname === "/v1/invoices/in_one")
        result = {
          id: "in_one",
          object: "invoice",
          hosted_invoice_url: state.invoiceUrl,
          created: state.invoiceCreated,
          livemode: state.invoiceLivemode,
          customer: state.invoiceCustomer,
          subscription: state.invoiceSubscription,
          charge: state.invoiceAmount && state.invoiceStatus === "paid" ? "ch_one" : null,
          payment_intent: state.invoiceAmount ? "pi_one" : null,
          status: state.invoiceStatus,
          paid: state.invoiceStatus === "paid",
          paid_out_of_band: state.outOfBand,
          amount_paid: state.invoiceStatus === "paid" ? state.invoiceAmount : 0,
          amount_due: state.invoiceAmount,
          billing_reason: state.invoiceReason,
          subtotal: state.invoiceAmount,
          subtotal_excluding_tax: state.invoiceAmount,
          total: state.invoiceAmount,
          tax: 0,
          total_discount_amounts: [],
          currency: "usd",
          period_start: 1700000000,
          period_end: 1702592000,
          lines: {
            has_more: false,
            data: [
              {
                id: "il_one",
                price: { id: "price_one" },
                quantity: 3,
                amount: state.invoiceAmount,
                period: { start: 1700000000, end: 1702592000 },
                proration: false,
              },
            ],
          },
        };
      else if (url.pathname === "/v1/invoices/in_one/lines")
        result = {
          object: "list",
          has_more: false,
          url: "/v1/invoices/in_one/lines",
          data: [
            {
              id: "il_one",
              type: "subscription",
              subscription: "sub_one",
              subscription_item: "si_one",
              price: { id: "price_one" },
              quantity: 3,
              amount: state.invoiceAmount,
              discount_amounts: [],
              tax_amounts: [],
              period: { start: 1700000000, end: 1702592000 },
              proration: false,
            },
          ],
        };
      else if (url.pathname === "/v1/payment_intents/pi_one")
        result = {
          id: "pi_one",
          object: "payment_intent",
          livemode: false,
          customer: "cus_one",
          currency: "usd",
          amount_received: state.invoiceStatus === "paid" ? state.invoiceAmount : 0,
          invoice: state.foreignInvoicePayment ? "in_other" : "in_one",
          status:
            state.paymentStatus ??
            ({ paid: "succeeded", open: "requires_action", void: "canceled" } as const)[
              state.invoiceStatus
            ],
        };
      else if (url.pathname === "/v1/charges/ch_one")
        result = {
          id: "ch_one",
          customer: "cus_one",
          invoice: "in_one",
          livemode: false,
          amount: 1500,
          amount_refunded: state.amountRefunded,
          paid: true,
          currency: "usd",
        };
      else if (url.pathname === "/v1/refunds" && method === "GET") {
        const refund = {
          id: "re_one",
          metadata: {
            ...tags,
            eliza_app_id: state.refundDiscovery === "wrong-scope" ? "app_other" : scope.appId,
            eliza_command_id: intent.commandId,
            eliza_request_digest:
              state.refundDiscovery === "wrong-digest" ? "b".repeat(64) : intent.requestDigest,
          },
        };
        const firstPage =
          state.refundDiscovery === "later-page" && !url.searchParams.has("starting_after");
        result = {
          object: "list",
          url: "/v1/refunds",
          has_more: firstPage,
          data: firstPage
            ? [{ id: "re_earlier", metadata: { eliza_command_id: "other-command" } }]
            : state.refundDiscovery === "absent"
              ? []
              : state.refundDiscovery === "duplicate"
                ? [refund, { ...refund, id: "re_two" }]
                : [refund],
        };
      } else if (
        url.pathname === "/v1/refunds" ||
        url.pathname === "/v1/refunds/re_one" ||
        url.pathname === "/v1/refunds/re_two"
      )
        result = {
          id: url.pathname.endsWith("/re_two") ? "re_two" : "re_one",
          object: "refund",
          charge: "ch_one",
          amount: method === "GET" ? 500 : Number(body.get("amount")),
          currency: "usd",
          status: "succeeded",
        };
      else throw new Error(`Unexpected provider fixture request ${method} ${url.pathname}`);
      return Response.json(result, { headers: { "request-id": "req_controlled_fixture" } });
    }),
  });
  return { stripe, provider: createGenericBillingProvider(stripe, binding), requests, state };
}

const trialClaim = { startsAt: 1700000000, endsAt: 1700604800 };
const subscriptionInput = { subscriptionId: "sub_one", customerId: "cus_one", plan };
describe("generic billing provider wire contract", () => {
  test("reads Acacia subscription periods through SDK and rejects Basil-shaped data", async () => {
    const f = fixture();
    const observed = await f.provider.retrieveSubscription(scope, subscriptionInput);
    expect(observed.value.currentPeriodStart).toBe(1700000000);
    expect(observed.value.currentPeriodEnd).toBe(1702592000);
    expect(
      f.requests.every(
        (request) =>
          request.headers.get("stripe-version") === "2024-11-20.acacia" &&
          request.headers.get("stripe-account") === "acct_one",
      ),
    ).toBe(true);
    f.state.basil = true;
    await expect(f.provider.retrieveSubscription(scope, subscriptionInput)).rejects.toMatchObject({
      code: "BILLING_PROVIDER_WIRE_SHAPE",
    });
  });
  test("durable customer ownership spans product families and permits absent metadata only with a binding", async () => {
    const f = fixture();
    const otherFamily = { ...scope, scopeId: "scope-two" };
    await f.provider.retrieveCustomer(otherFamily, "cus_one");
    f.state.missingMetadata = true;
    await expect(f.provider.retrieveCustomer(scope, "cus_one")).rejects.toMatchObject({
      code: "BILLING_PROVIDER_SCOPE",
    });
    const calls: string[] = [];
    const provider = createGenericBillingProvider(f.stripe, merchant, {
      resolveBinding: async (input) => {
        calls.push(input.objectType);
        expect(input.merchantId).toBe(merchant.merchantId);
        expect(input.livemode).toBe(false);
        return {
          appId: scope.appId,
          billingAccountId: scope.billingAccountId,
          scopeId: input.objectType === "customer" ? null : scope.scopeId,
        };
      },
    });
    await provider.retrieveCustomer(otherFamily, "cus_one");
    await provider.retrieveSubscription(scope, subscriptionInput);
    expect(calls).toContain("subscription");
    await expect(
      provider.retrieveSubscription(otherFamily, subscriptionInput),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_BINDING" });
    const unbound = createGenericBillingProvider(f.stripe, merchant, {
      resolveBinding: async () => null,
    });
    await expect(unbound.retrieveCustomer(scope, "cus_one")).rejects.toMatchObject({
      code: "BILLING_PROVIDER_BINDING",
    });
    f.state.missingMetadata = false;
    f.state.foreign = true;
    await expect(provider.retrieveCustomer(scope, "cus_one")).rejects.toMatchObject({
      code: "BILLING_PROVIDER_SCOPE",
    });
  });
  test("delayed trial dispatch retains the original claim end and rejects a reset interval", async () => {
    const f = fixture();
    f.state.delayedTrialStart = true;
    const result = await f.provider.startTrial(
      scope,
      { customerId: "cus_one", plan, quantity: 3, trialClaim },
      intent,
    );
    expect(result.value.trialStart).toBe(1700000030);
    expect(result.value.trialEnd).toBe(trialClaim.endsAt);
    const g = fixture();
    await expect(
      g.provider.startTrial(
        scope,
        {
          customerId: "cus_one",
          plan,
          quantity: 3,
          trialClaim: { ...trialClaim, endsAt: trialClaim.endsAt + 30 },
        },
        intent,
      ),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_TRIAL_CLAIM" });
    expect(
      g.requests.some(
        (request) => request.path === "/v1/subscriptions" && request.method === "POST",
      ),
    ).toBe(false);
  });
  test("unknown creation recovery uses the original durable intent and never treats absence as a new-create authorization", async () => {
    const f = fixture();
    f.state.trial = true;
    const recoveredCustomer = await f.provider.discoverCreatedCustomer(scope, intent);
    expect(recoveredCustomer.value).toEqual({ status: "found", object: { customerId: "cus_one" } });
    const input = { customerId: "cus_one", plan, quantity: 3, trialClaim };
    const recovered = await f.provider.discoverCreatedSubscription(scope, input, intent);
    expect(recovered.value.status).toBe("found");
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    f.state.missingCommand = true;
    expect((await f.provider.discoverCreatedSubscription(scope, input, intent)).value.status).toBe(
      "not_observed",
    );
    f.state.missingCommand = false;
    f.state.page = true;
    await expect(
      f.provider.discoverCreatedSubscription(scope, input, intent),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_DISCOVERY_CONFLICT" });
    f.state.page = false;
    await expect(
      f.provider.discoverCreatedSubscription(scope, { ...input, quantity: 4 }, intent),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_DISCOVERY_CONFLICT" });
  });
  test("scope listing skips another durably bound product family but fails on unbound subscriptions", async () => {
    const f = fixture();
    f.state.page = true;
    const provider = createGenericBillingProvider(f.stripe, merchant, {
      resolveBinding: async (input) => ({
        appId: scope.appId,
        billingAccountId: scope.billingAccountId,
        scopeId:
          input.objectType === "customer"
            ? null
            : input.objectId === "sub_two"
              ? "scope-two"
              : scope.scopeId,
      }),
    });
    const result = await provider.listSubscriptions(scope, {
      customerId: "cus_one",
      plans: [plan],
    });
    expect(result.value.map((item) => item.subscriptionId)).toEqual(["sub_one"]);
    const unknown = createGenericBillingProvider(f.stripe, merchant, {
      resolveBinding: async (input) =>
        input.objectType === "customer" ? { ...scope, scopeId: null } : null,
    });
    await expect(
      unknown.listSubscriptions(scope, { customerId: "cus_one", plans: [plan] }),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_UNBOUND_SUBSCRIPTION" });
  });
  test("paid updates revalidate reviewed taxes and prorations and keep the same proration timestamp", async () => {
    const input = {
      subscriptionId: "sub_one",
      customerId: "cus_one",
      currentPlan: plan,
      targetPlan: { ...plan, priceId: "price_two", planRevisionId: "revision-two" },
      quantity: 4,
      minimumSeats: 3,
      prorationDate: 1700000100,
    };
    const f = fixture();
    const quote = await f.provider.previewSubscriptionUpdate(scope, input);
    expect(quote.value.dueNowCents).toBe(550);
    expect(quote.value.nextInvoice.prorationCents).toBe(500);
    expect(quote.value.nextInvoice.taxCents).toBe(50);
    expect(quote.value.recurringInvoice?.amountDueCents).toBe(6050);
    const result = await f.provider.updateSubscription(
      scope,
      { ...input, reviewedPreview: quote.value },
      intent,
    );
    expect(result.value.quantity).toBe(4);
    const update = f.requests.find(
      (request) => request.path === "/v1/subscriptions/sub_one" && request.method === "POST",
    )!;
    expect(update.body.get("proration_date")).toBe(String(input.prorationDate));
    expect(update.body.get("payment_behavior")).toBe("pending_if_incomplete");
    const g = fixture();
    const oldQuote = await g.provider.previewSubscriptionUpdate(scope, input);
    g.state.changedPreview = true;
    await expect(
      g.provider.updateSubscription(scope, { ...input, reviewedPreview: oldQuote.value }, intent),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_QUOTE_CHANGED" });
    expect(
      g.requests.some(
        (request) => request.path === "/v1/subscriptions/sub_one" && request.method === "POST",
      ),
    ).toBe(false);
  });
  test("pending upgrade authenticates only the original reviewed invoice without another update POST", async () => {
    const f = fixture();
    const input = {
      subscriptionId: "sub_one",
      customerId: "cus_one",
      currentPlan: plan,
      targetPlan: { ...plan, priceId: "price_two", planRevisionId: "revision-two" },
      quantity: 4,
      minimumSeats: 3,
      prorationDate: 1700000100,
    };
    const quote = await f.provider.previewSubscriptionUpdate(scope, input);
    Object.assign(f.state, {
      pending: true,
      invoiceStatus: "open",
      invoiceAmount: 550,
      invoiceReason: "subscription_update",
    });
    const request = {
      ...input,
      invoiceId: null,
      dispatchedAt: 1700000100,
      reviewedPreview: quote.value,
    };
    const result = await f.provider.inspectUpdatePayment(scope, request);
    expect(result.action).toMatchObject({
      kind: "payment",
      invoiceId: "in_one",
      customerId: "cus_one",
      subscriptionId: "sub_one",
      url: f.state.invoiceUrl,
    });
    expect(result.subscription.value.quantity).toBe(3);
    expect(result.applied).toBe(false);
    expect(
      f.requests.filter((r) => r.method === "POST" && r.path.startsWith("/v1/subscriptions")),
    ).toHaveLength(0);
    for (const change of [
      { invoiceSubscription: "sub_foreign" },
      { invoiceCustomer: "cus_foreign" },
      { invoiceLivemode: true },
      { invoiceCreated: 1700000099 },
      { invoiceReason: "subscription_cycle" },
      { invoiceAmount: 551 },
      { pendingPrice: "price_foreign" },
      { pendingQuantity: 5 },
      { foreignInvoicePayment: true },
      { invoiceUrl: "https://invoice.stripe.com.evil.test/i/phishing" },
      { invoiceUrl: "https://secret@invoice.stripe.com/i/phishing" },
    ]) {
      const before = { ...f.state };
      Object.assign(f.state, change);
      await expect(f.provider.inspectUpdatePayment(scope, request)).rejects.toThrow();
      Object.assign(f.state, before);
    }
    await expect(
      f.provider.inspectUpdatePayment(scope, { ...request, invoiceId: "in_other" }),
    ).rejects.toThrow();
    Object.assign(f.state, {
      pending: false,
      resumePending: false,
      paused: false,
      subscriptionStatus: null as string | null,
      latestInvoiceId: "in_one",
      paymentStatus: null as string | null,
      payFailure: null as "card" | "transport" | null,
      payTimeoutAfterSuccess: false,
      priceId: "price_two",
      quantity: 4,
      invoiceStatus: "paid",
    });
    expect(
      (await f.provider.inspectUpdatePayment(scope, { ...request, invoiceId: "in_one" })).applied,
    ).toBe(true);
  });
  test("platform and connected merchant requests carry the stored account and environment", async () => {
    for (const kind of ["platform", "connected"] as const) {
      const f = fixture({ ...merchant, kind });
      const observation = await f.provider.createCustomer(scope, intent);
      expect(observation.value.customerId).toBe("cus_one");
      expect(observation.inputDigest).toBe(intent.requestDigest);
      expect(
        f.requests.find((request) => request.method === "POST")?.headers.get("idempotency-key"),
      ).toBe(intent.idempotencyKey);
      expect(
        f.requests.find((request) => request.method === "POST")?.headers.get("stripe-account"),
      ).toBe("acct_one");
      expect(
        f.requests
          .find((request) => request.method === "POST")
          ?.body.get("metadata[eliza_billing_scope_id]"),
      ).toBe(scope.scopeId);
      f.state.livemode = true;
      await expect(f.provider.retrieveCustomer(scope, "cus_one")).rejects.toMatchObject({
        code: "BILLING_PROVIDER_MODE",
      });
    }
  });
  test("foreign customer ownership and wrong catalog price prevent checkout dispatch", async () => {
    for (const mismatch of ["scope", "price"]) {
      const f = fixture();
      if (mismatch === "scope") f.state.foreign = true;
      else f.state.priceAmount = 999;
      await expect(
        f.provider.createCheckout(
          scope,
          {
            customerId: "cus_one",
            plan,
            quantity: 3,
            successUrl: "https://app.example.test/paid",
            cancelUrl: "https://app.example.test/cancel",
            trial: true,
            trialClaim,
          },
          intent,
        ),
      ).rejects.toThrow();
      expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    }
  });
  test("starts exactly seven days without a payment method and pauses without one", async () => {
    const f = fixture();
    const value = await f.provider.startTrial(
      scope,
      { customerId: "cus_one", plan, quantity: 3, trialClaim },
      intent,
    );
    expect(value.value.trialEnd! - value.value.trialStart!).toBe(7 * 86400);
    const request = f.requests.find(
      (request) => request.path === "/v1/subscriptions" && request.method === "POST",
    )!;
    expect(request.body.get("trial_end")).toBe(String(trialClaim.endsAt));
    expect(request.body.has("trial_period_days")).toBe(false);
    expect(request.body.get("trial_settings[end_behavior][missing_payment_method]")).toBe("pause");
    expect(request.body.has("default_payment_method")).toBe(false);
  });
  test("trial checkout accepts no-payment-required and expiry reads provider state", async () => {
    const f = fixture();
    const value = await f.provider.createCheckout(
      scope,
      {
        customerId: "cus_one",
        plan,
        quantity: 3,
        successUrl: "https://app.example.test/paid",
        cancelUrl: "https://app.example.test/cancel",
        trial: true,
        trialClaim,
      },
      intent,
    );
    expect(value.value.paymentStatus).toBe("no_payment_required");
    expect(
      f.requests
        .find((request) => request.path === "/v1/checkout/sessions")
        ?.body.get("subscription_data[trial_end]"),
    ).toBe(String(trialClaim.endsAt));
    const expired = await f.provider.expireCheckout(
      scope,
      { sessionId: "cs_one", customerId: "cus_one" },
      intent,
    );
    expect(expired.value.status).toBe("expired");
  });
  test("lists every subscription page without losing history", async () => {
    const f = fixture();
    f.state.page = true;
    const value = await f.provider.listSubscriptions(scope, {
      customerId: "cus_one",
      plans: [plan],
    });
    expect(value.value.map((subscription) => subscription.subscriptionId)).toEqual([
      "sub_one",
      "sub_two",
    ]);
    expect(
      f.requests
        .filter((request) => request.path === "/v1/subscriptions")
        .at(-1)
        ?.query.get("starting_after"),
    ).toBe("sub_one");
  });
  test("plan changes preserve trial identity and enforce authoritative occupied seats", async () => {
    const f = fixture();
    f.state.trial = true;
    const targetPlan = { ...plan, planRevisionId: "revision-two", priceId: "price_two" };
    const requestInput = {
      subscriptionId: "sub_one",
      customerId: "cus_one",
      currentPlan: plan,
      targetPlan,
      quantity: 4,
      minimumSeats: 3,
      prorationDate: 1700000100,
    };
    const quote = await f.provider.previewSubscriptionUpdate(scope, requestInput);
    expect(quote.value.dueNowCents).toBe(0);
    expect(quote.value.recurringBasis).toBe("trial_renewal");
    const value = await f.provider.updateSubscription(
      scope,
      { ...requestInput, reviewedPreview: quote.value },
      intent,
    );
    expect(value.value.status).toBe("trialing");
    expect(value.value.trialEnd).toBe(1700604800);
    expect(value.value.quantity).toBe(4);
    const request = f.requests.find(
      (request) => request.path === "/v1/subscriptions/sub_one" && request.method === "POST",
    )!;
    expect(request.body.get("trial_end")).toBe("1700604800");
    expect(request.body.get("proration_behavior")).toBe("none");
    const g = fixture();
    await expect(
      g.provider.updateSubscription(
        scope,
        {
          subscriptionId: "sub_one",
          customerId: "cus_one",
          currentPlan: plan,
          targetPlan,
          quantity: 2,
          minimumSeats: 3,
          prorationDate: 1700000100,
          reviewedPreview: quote.value,
        },
        intent,
      ),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_QUANTITY" });
    expect(g.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });
  test("portal always disables plan and quantity changes that could bypass the seat fence", async () => {
    for (const trial of [true, false]) {
      const f = fixture();
      f.state.trial = trial;
      const value = await f.provider.createPortal(
        scope,
        {
          subscriptionId: "sub_one",
          customerId: "cus_one",
          currentPlan: plan,
          availablePlans: [plan],
          minimumSeats: 3,
          returnUrl: "https://app.example.test/settings",
        },
        intent,
      );
      expect(value.value.subscriptionUpdatesEnabled).toBe(false);
      const configuration = f.requests.find(
        (request) => request.path === "/v1/billing_portal/configurations",
      )!;
      expect(configuration.body.get("features[subscription_update][enabled]")).toBe("false");
      expect(
        f.requests
          .find((request) => request.path === "/v1/billing_portal/sessions")
          ?.body.get("customer"),
      ).toBe("cus_one");
    }
  });
  test("cancellation observes current provider state without invoice or proration creation", async () => {
    const f = fixture();
    const value = await f.provider.cancelSubscription(
      scope,
      { ...subscriptionInput, atPeriodEnd: false },
      intent,
    );
    expect(value.value.status).toBe("canceled");
    const request = f.requests.find((request) => request.method === "DELETE")!;
    expect(request.query.get("invoice_now")).toBe("false");
    expect(request.query.get("prorate")).toBe("false");
  });
  test("invoice observation keeps zero-value trial distinct from positive paid renewal", async () => {
    const f = fixture();
    f.state.invoiceAmount = 0;
    const zero = await f.provider.retrieveInvoice(scope, {
      ...subscriptionInput,
      invoiceId: "in_one",
    });
    expect(zero.value.paid).toBe(true);
    expect(zero.value.amountPaidCents).toBe(0);
    expect(zero.value.paymentIntentId).toBeNull();
    f.state.invoiceAmount = 1500;
    const paid = await f.provider.retrieveInvoice(scope, {
      ...subscriptionInput,
      invoiceId: "in_one",
    });
    expect(paid.value.amountPaidCents).toBe(1500);
    expect(paid.value.paymentIntentId).toBe("pi_one");
    expect(paid.value.payment?.amountReceivedCents).toBe(1500);
    expect(paid.value.payment?.status).toBe("succeeded");
    f.state.outOfBand = true;
    const external = await f.provider.retrieveInvoice(scope, {
      ...subscriptionInput,
      invoiceId: "in_one",
    });
    expect(external.value.paidOutOfBand).toBe(true);
    f.state.foreignInvoicePayment = true;
    await expect(
      f.provider.retrieveInvoice(scope, { ...subscriptionInput, invoiceId: "in_one" }),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_INVOICE_PAYMENT" });
    f.state.foreignInvoicePayment = false;
    f.state.invoiceSubscription = "sub_other";
    await expect(
      f.provider.retrieveInvoice(scope, { ...subscriptionInput, invoiceId: "in_one" }),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_INVOICE" });
  });
  test("refund targets the original merchant charge and never creates Cloud credit", async () => {
    const f = fixture();
    const value = await f.provider.refund(
      scope,
      { ...subscriptionInput, invoiceId: "in_one", amountCents: 500 },
      intent,
    );
    expect(value.value.amountCents).toBe(500);
    const request = f.requests.find((request) => request.path === "/v1/refunds")!;
    expect(request.body.get("charge")).toBe("ch_one");
    expect(request.headers.get("stripe-account")).toBe("acct_one");
    expect(request.headers.get("idempotency-key")).toBe(intent.idempotencyKey);
    expect(request.body.get("metadata[eliza_request_digest]")).toBe(intent.requestDigest);
    const read = await f.provider.retrieveRefund(scope, {
      ...subscriptionInput,
      invoiceId: "in_one",
      refundId: "re_one",
    });
    expect(read.value.amountCents).toBe(500);
    expect(read.value.status).toBe("succeeded");
  });
  test("refund review derives remaining funds from the original charge without writing", async () => {
    const f = fixture();
    f.state.amountRefunded = 1000;
    const input = { ...subscriptionInput, invoiceId: "in_one" };
    const preview = await f.provider.previewRefund(scope, input);
    expect(preview.value.amountPaidCents).toBe(1500);
    expect(preview.value.amountAvailableCents).toBe(500);
    f.state.amountRefunded = 1500;
    expect((await f.provider.previewRefund(scope, input)).value.amountAvailableCents).toBe(0);
    f.state.amountRefunded = 1600;
    await expect(f.provider.previewRefund(scope, input)).rejects.toMatchObject({
      code: "BILLING_PROVIDER_REFUND",
    });
    expect(f.requests.some((row) => row.method === "POST")).toBe(false);
  });
  test("refunds retain historical invoice authority after the subscription changes price", async () => {
    const f = fixture();
    f.state.priceId = "price_two";
    const refunded = await f.provider.refund(
      scope,
      { ...subscriptionInput, invoiceId: "in_one", amountCents: 500 },
      intent,
    );
    expect(refunded.value.chargeId).toBe("ch_one");
    expect(refunded.value.amountCents).toBe(500);
    f.state.invoiceSubscription = "sub_other";
    await expect(
      f.provider.refund(
        scope,
        { ...subscriptionInput, invoiceId: "in_one", amountCents: 500 },
        intent,
      ),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_INVOICE" });
    expect(
      f.requests.filter((row) => row.path === "/v1/refunds" && row.method === "POST"),
    ).toHaveLength(1);
  });
  test("refund discovery recovers the original provider object without creating another refund", async () => {
    const f = fixture();
    const input = { ...subscriptionInput, invoiceId: "in_one", amountCents: 500 };
    const found = await f.provider.discoverCreatedRefund(scope, input, intent);
    expect(found.value).toMatchObject({
      status: "found",
      object: { refundId: "re_one", chargeId: "ch_one", amountCents: 500 },
    });
    const request = f.requests.find((row) => row.path === "/v1/refunds");
    expect(request?.query.get("charge")).toBe("ch_one");
    expect(request?.headers.get("stripe-account")).toBe("acct_one");
    expect(f.requests.some((row) => row.method === "POST" && row.path === "/v1/refunds")).toBe(
      false,
    );
    f.state.refundDiscovery = "absent";
    expect((await f.provider.discoverCreatedRefund(scope, input, intent)).value).toEqual({
      status: "absent",
    });
    f.state.refundDiscovery = "later-page";
    expect((await f.provider.discoverCreatedRefund(scope, input, intent)).value.status).toBe(
      "found",
    );
    expect(
      f.requests.some(
        (row) => row.path === "/v1/refunds" && row.query.get("starting_after") === "re_earlier",
      ),
    ).toBe(true);
  });
  test("refund discovery rejects conflicting ownership, digest, amount and ambiguous results", async () => {
    const f = fixture();
    const input = { ...subscriptionInput, invoiceId: "in_one", amountCents: 500 };
    for (const state of ["wrong-digest", "wrong-scope", "duplicate"] as const) {
      f.state.refundDiscovery = state;
      await expect(f.provider.discoverCreatedRefund(scope, input, intent)).rejects.toMatchObject({
        code: "BILLING_PROVIDER_DISCOVERY_CONFLICT",
      });
    }
    f.state.refundDiscovery = "found";
    await expect(
      f.provider.discoverCreatedRefund(scope, { ...input, amountCents: 600 }, intent),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_DISCOVERY_CONFLICT" });
  });
  test("signed events validate connected account, mode and explicit webhook API version", async () => {
    const f = fixture();
    const secret = "whsec_local_signed_fixture";
    for (const wrong of [null, "account", "mode", "version"] as const) {
      const payload = JSON.stringify({
        id: "evt_one",
        object: "event",
        type: "customer.subscription.updated",
        created: 1700000000,
        api_version: wrong === "version" ? "2025-03-31.basil" : "2024-11-20.acacia",
        account: wrong === "account" ? "acct_other" : "acct_one",
        livemode: wrong === "mode",
        data: { object: { id: "sub_one", object: "subscription" } },
      });
      const signature = await f.stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
      if (wrong)
        await expect(f.provider.verifyWebhook(payload, signature, secret)).rejects.toThrow();
      else
        expect((await f.provider.verifyWebhook(payload, signature, secret)).objectId).toBe(
          "sub_one",
        );
      await expect(f.provider.verifyWebhook(`${payload} `, signature, secret)).rejects.toThrow();
    }
  });
  test("collects a payment method on the same subscription and rejects another customer's method", async () => {
    const f = fixture();
    f.state.trial = true;
    const setup = await f.provider.createPaymentMethodCheckout(
      scope,
      {
        ...subscriptionInput,
        successUrl: "https://app.example.test/return",
        cancelUrl: "https://app.example.test/cancel",
      },
      intent,
    );
    expect(setup.value.sessionId).toBe("cs_setup");
    const setupRequest = f.requests.find((request) => request.path === "/v1/checkout/sessions")!;
    expect(setupRequest.body.get("mode")).toBe("setup");
    f.state.setupComplete = true;
    const completed = await f.provider.applyPaymentMethodCheckout(
      scope,
      { ...subscriptionInput, sessionId: "cs_setup" },
      intent,
    );
    expect(completed.value.subscriptionId).toBe("sub_one");
    expect(completed.value.trialEnd).toBe(1700604800);
    expect(
      f.requests
        .find(
          (request) => request.path === "/v1/subscriptions/sub_one" && request.method === "POST",
        )
        ?.body.get("default_payment_method"),
    ).toBe("pm_one");
    const other = fixture();
    other.state.setupComplete = true;
    other.state.foreignPaymentMethod = true;
    await expect(
      other.provider.applyPaymentMethodCheckout(
        scope,
        { ...subscriptionInput, sessionId: "cs_setup" },
        intent,
      ),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_SETUP" });
    expect(other.requests.some((request) => request.method === "POST")).toBe(false);
  });
  test("setup Checkout status and expiry preserve durable ownership when optional metadata is removed", async () => {
    const f = fixture();
    f.state.trial = true;
    const provider = createGenericBillingProvider(f.stripe, merchant, {
      resolveBinding: async (input) =>
        ["cus_one", "sub_one", "cs_setup"].includes(input.objectId)
          ? {
              appId: scope.appId,
              billingAccountId: scope.billingAccountId,
              scopeId: input.objectType === "customer" ? null : scope.scopeId,
            }
          : null,
    });
    f.state.missingMetadata = true;
    const input = { ...subscriptionInput, sessionId: "cs_setup" };
    const read = await provider.readPaymentMethodCheckout(scope, input);
    expect(read.value).toMatchObject({
      mode: "setup",
      sessionId: "cs_setup",
      subscriptionId: "sub_one",
      expiresAt: 1700001000,
      status: "open",
      setupIntentId: "seti_one",
    });
    const expired = await provider.expireCheckout(scope, { ...input, mode: "setup" }, intent);
    expect(expired.value).toMatchObject({
      mode: "setup",
      status: "expired",
      expiresAt: 1700001000,
    });
    expect(
      f.requests.filter((request) => request.path === "/v1/checkout/sessions/cs_setup/expire"),
    ).toHaveLength(1);
    await provider.expireCheckout(scope, { ...input, mode: "setup" }, intent);
    expect(
      f.requests.filter((request) => request.path === "/v1/checkout/sessions/cs_setup/expire"),
    ).toHaveLength(1);
    f.state.expired = false;
    f.state.setupComplete = true;
    const applied = await provider.applyPaymentMethodCheckout(scope, input, intent);
    expect(applied.value).toMatchObject({ subscriptionId: "sub_one", trialEnd: trialClaim.endsAt });
    const unbound = createGenericBillingProvider(f.stripe, merchant, {
      resolveBinding: async () => null,
    });
    await expect(unbound.readPaymentMethodCheckout(scope, input)).rejects.toMatchObject({
      code: "BILLING_PROVIDER_BINDING",
    });
  });
  test("Checkout discovery reads full immutable line evidence without repeating a create and rejects contradictory or duplicate candidates", async () => {
    const f = fixture();
    const input = {
      customerId: "cus_one",
      plan,
      quantity: 3,
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      trial: false,
    };
    const recovered = await f.provider.discoverCreatedCheckout(scope, input, intent);
    expect(recovered.value).toMatchObject({
      status: "found",
      object: { mode: "subscription", sessionId: "cs_one", expiresAt: 1700001000, invoiceId: null },
    });
    expect(
      f.requests.some((request) => request.path === "/v1/checkout/sessions/cs_one/line_items"),
    ).toBe(true);
    f.state.wrongCheckoutQuantity = true;
    await expect(f.provider.discoverCreatedCheckout(scope, input, intent)).rejects.toMatchObject({
      code: "BILLING_PROVIDER_DISCOVERY_CONFLICT",
    });
    f.state.wrongCheckoutQuantity = false;
    f.state.wrongCheckoutUrl = true;
    await expect(f.provider.discoverCreatedCheckout(scope, input, intent)).rejects.toMatchObject({
      code: "BILLING_PROVIDER_DISCOVERY_CONFLICT",
    });
    f.state.wrongCheckoutUrl = false;
    f.state.duplicateCheckout = true;
    await expect(f.provider.discoverCreatedCheckout(scope, input, intent)).rejects.toMatchObject({
      code: "BILLING_PROVIDER_DISCOVERY_CONFLICT",
    });
    f.state.duplicateCheckout = false;
    f.state.missingCommand = true;
    expect((await f.provider.discoverCreatedCheckout(scope, input, intent)).value).toEqual({
      status: "not_observed",
    });
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    f.state.missingCommand = false;
    f.state.trial = true;
    expect(
      (
        await f.provider.discoverCreatedCheckout(
          scope,
          { ...input, trial: true, trialClaim },
          intent,
        )
      ).value.status,
    ).toBe("found");
    await expect(
      f.provider.discoverCreatedCheckout(
        scope,
        {
          ...input,
          trial: true,
          trialClaim: { startsAt: trialClaim.startsAt + 1, endsAt: trialClaim.endsAt + 1 },
        },
        intent,
      ),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_DISCOVERY_CONFLICT" });
  });
  test("setup discovery binds the original subscription and command while invoice observations carry the authoritative hosted payment link", async () => {
    const f = fixture();
    f.state.checkoutMode = "setup";
    const input = {
      ...subscriptionInput,
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
    };
    expect(
      (await f.provider.discoverCreatedPaymentMethodCheckout(scope, input, intent)).value,
    ).toMatchObject({
      status: "found",
      object: {
        mode: "setup",
        subscriptionId: "sub_one",
        setupIntentId: "seti_one",
        expiresAt: 1700001000,
      },
    });
    f.state.duplicateCheckout = true;
    await expect(
      f.provider.discoverCreatedPaymentMethodCheckout(scope, input, intent),
    ).rejects.toMatchObject({ code: "BILLING_PROVIDER_DISCOVERY_CONFLICT" });
    f.state.duplicateCheckout = false;
    f.state.missingCommand = true;
    expect(
      (await f.provider.discoverCreatedPaymentMethodCheckout(scope, input, intent)).value,
    ).toEqual({ status: "not_observed" });
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    const invoice = await f.provider.retrieveInvoice(scope, {
      ...subscriptionInput,
      invoiceId: "in_one",
    });
    expect(invoice.value.hostedInvoiceUrl).toBe("https://invoice.stripe.com/i/fixture");
  });
  test("provider outages fail explicitly before a subscription mutation", async () => {
    const f = fixture();
    f.state.customerFailure = true;
    await expect(
      f.provider.startTrial(
        scope,
        { customerId: "cus_one", plan, quantity: 3, trialClaim },
        intent,
      ),
    ).rejects.toThrow();
    expect(f.requests.some((request) => request.path === "/v1/subscriptions")).toBe(false);
  });
});

test("one current subscription response selects and validates its immutable family catalog revision", async () => {
  const f = fixture();
  f.state.priceId = "price_two";
  const second = { ...plan, planRevisionId: "revision-two", priceId: "price_two" };
  const result = await f.provider.retrieveSubscriptionFromCatalog(scope, {
    subscriptionId: "sub_one",
    customerId: "cus_one",
    plans: [plan, second],
  });
  expect(result.planRevisionId).toBe(second.planRevisionId);
  expect(result.subscription.value.priceId).toBe(second.priceId);
  expect(f.requests.filter((request) => request.path === "/v1/subscriptions/sub_one")).toHaveLength(
    1,
  );
  await expect(
    f.provider.retrieveSubscriptionFromCatalog(scope, {
      subscriptionId: "sub_one",
      customerId: "cus_one",
      plans: [plan],
    }),
  ).rejects.toThrow("exactly one immutable app plan");
  await expect(
    f.provider.retrieveSubscriptionFromCatalog(scope, {
      subscriptionId: "sub_one",
      customerId: "cus_one",
      plans: [second, { ...second, amountCents: 1 }],
    }),
  ).rejects.toThrow("exactly one immutable app plan");
  f.state.priceAmount = 1;
  await expect(
    f.provider.retrieveSubscriptionFromCatalog(scope, {
      subscriptionId: "sub_one",
      customerId: "cus_one",
      plans: [second],
    }),
  ).rejects.toThrow();
});

test("customer lifecycle observation requires durable ownership and explicit matching deletion evidence", async () => {
  const f = fixture();
  const provider = createGenericBillingProvider(f.stripe, merchant, {
    async resolveBinding(input) {
      return input.objectType === "customer" &&
        input.objectId === "cus_one" &&
        input.merchantId === merchant.merchantId &&
        input.providerAccountId === merchant.stripeAccountId &&
        !input.livemode
        ? { appId: scope.appId, billingAccountId: scope.billingAccountId, scopeId: null }
        : null;
    },
  });
  await expect(f.provider.inspectBoundCustomer(scope, "cus_one")).rejects.toMatchObject({
    code: "BILLING_PROVIDER_BINDING",
  });
  expect(f.requests).toHaveLength(0);
  expect((await provider.inspectBoundCustomer(scope, "cus_one")).value.status).toBe("present");
  f.state.deletedCustomer = true;
  expect((await provider.inspectBoundCustomer(scope, "cus_one")).value).toEqual({
    customerId: "cus_one",
    status: "deleted",
  });
  f.state.contradictoryTombstone = true;
  await expect(provider.inspectBoundCustomer(scope, "cus_one")).rejects.toMatchObject({
    code: "BILLING_PROVIDER_WIRE_SHAPE",
  });
  f.state.contradictoryTombstone = false;
  f.state.wrongCustomerId = true;
  await expect(provider.inspectBoundCustomer(scope, "cus_one")).rejects.toMatchObject({
    code: "BILLING_PROVIDER_SCOPE",
  });
  f.state.wrongCustomerId = false;
  f.state.customerFailure = true;
  await expect(provider.inspectBoundCustomer(scope, "cus_one")).rejects.toThrow();
  f.state.customerFailure = false;
  f.state.customerMissing = true;
  await expect(provider.inspectBoundCustomer(scope, "cus_one")).rejects.toThrow();
  f.state.customerMissing = false;
  f.state.deletedCustomer = false;
  f.state.livemode = true;
  await expect(provider.inspectBoundCustomer(scope, "cus_one")).rejects.toMatchObject({
    code: "BILLING_PROVIDER_MODE",
  });
  const requestsBeforeForeign = f.requests.length;
  await expect(
    provider.inspectBoundCustomer({ ...scope, billingAccountId: "foreign-buyer" }, "cus_one"),
  ).rejects.toMatchObject({ code: "BILLING_PROVIDER_BINDING" });
  expect(f.requests).toHaveLength(requestsBeforeForeign);
  expect(
    f.requests.every(
      (request) =>
        request.method === "GET" &&
        request.headers.get("stripe-account") === merchant.stripeAccountId,
    ),
  ).toBe(true);
});

test("deleted customer observation checks fresh credential mode before customer retrieval", async () => {
  const f = fixture();
  f.state.deletedCustomer = true;
  f.state.credentialLivemode = true;
  const provider = createGenericBillingProvider(f.stripe, merchant, {
    async resolveBinding() {
      return { appId: scope.appId, billingAccountId: scope.billingAccountId, scopeId: null };
    },
  });
  await expect(provider.inspectBoundCustomer(scope, "cus_one")).rejects.toMatchObject({
    code: "BILLING_PROVIDER_MODE",
  });
  expect(f.requests.some((request) => request.path.startsWith("/v1/customers"))).toBe(false);
});

describe("paused trial resume invoice", () => {
  function resumeFixture() {
    const f = fixture();
    Object.assign(f.state, {
      setupComplete: true,
      paused: true,
      resumePending: true,
      invoiceStatus: "open",
      invoiceAmount: 4500,
      paymentStatus: "requires_confirmation",
    });
    const input = {
      sessionId: "cs_setup",
      subscriptionId: "sub_one",
      customerId: "cus_one",
      plan,
      quantity: 3,
      invoiceId: "in_one",
      previousInvoiceId: "in_before",
      dispatchedAt: 1700000100,
    };
    return { ...f, input };
  }
  test("inspection is read-only and payment collects the persisted resumption invoice once", async () => {
    const f = resumeFixture();
    const inspected = await f.provider.inspectPaymentMethodResume(scope, f.input);
    expect(inspected).toMatchObject({
      applied: false,
      settled: false,
      payable: true,
      action: { invoiceId: "in_one" },
    });
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    const result = await f.provider.payPaymentMethodResumeInvoice(scope, f.input, intent);
    expect(result).toMatchObject({
      applied: true,
      settled: true,
      payable: false,
      action: null,
      subscription: { value: { subscriptionId: "sub_one", status: "active" } },
    });
    await f.provider.payPaymentMethodResumeInvoice(scope, f.input, intent);
    const writes = f.requests.filter((request) => request.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/v1/invoices/in_one/pay");
    expect(writes[0]?.headers.get("Idempotency-Key")).toBe(intent.idempotencyKey);
    expect(writes[0]?.body.get("payment_method")).toBe("pm_one");
  });
  test("foreign, prior, replaced and old invoices fail before payment", async () => {
    for (const mismatch of [
      "customer",
      "mode",
      "subscription",
      "prior",
      "replaced",
      "old",
      "quantity",
      "method",
      "incomplete",
    ] as const) {
      const f = resumeFixture();
      if (mismatch === "customer") f.state.invoiceCustomer = "cus_other";
      if (mismatch === "mode") f.state.invoiceLivemode = true;
      if (mismatch === "subscription") f.state.invoiceSubscription = "sub_other";
      if (mismatch === "prior") f.input.previousInvoiceId = "in_one";
      if (mismatch === "replaced") f.state.latestInvoiceId = "in_replacement";
      if (mismatch === "old") f.input.dispatchedAt += 1;
      if (mismatch === "quantity") f.input.quantity = 2;
      if (mismatch === "method") f.state.foreignPaymentMethod = true;
      if (mismatch === "incomplete") f.state.setupComplete = false;
      await expect(
        f.provider.payPaymentMethodResumeInvoice(scope, f.input, intent),
      ).rejects.toThrow();
      expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    }
  });
  test("authentication failure remains a hosted payment action without granting access", async () => {
    const f = resumeFixture();
    f.state.payFailure = "card";
    const result = await f.provider.payPaymentMethodResumeInvoice(scope, f.input, intent);
    expect(result).toMatchObject({
      applied: false,
      settled: false,
      payable: false,
      action: { kind: "payment", invoiceId: "in_one" },
      invoice: { value: { payment: { status: "requires_action" } } },
    });
    await f.provider.payPaymentMethodResumeInvoice(scope, f.input, intent);
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });
  test("ambiguous payment transport error remains recoverable by observing the same invoice", async () => {
    const f = resumeFixture();
    f.state.payTimeoutAfterSuccess = true;
    await expect(
      f.provider.payPaymentMethodResumeInvoice(scope, f.input, intent),
    ).rejects.toThrow();
    expect((await f.provider.payPaymentMethodResumeInvoice(scope, f.input, intent)).applied).toBe(
      true,
    );
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });
  test("processing and void invoice observations never dispatch payment or grant access", async () => {
    for (const state of ["processing", "void"] as const) {
      const f = resumeFixture();
      if (state === "processing") f.state.paymentStatus = "processing";
      else {
        f.state.invoiceStatus = "void";
        f.state.paymentStatus = "canceled";
      }
      const result = await f.provider.payPaymentMethodResumeInvoice(scope, f.input, intent);
      expect(result).toMatchObject({
        payable: false,
        applied: false,
        settled: false,
        action: null,
      });
      expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    }
  });
});

test("ambiguous resume replay keeps its original endpoint, body and idempotency after status transitions", async () => {
  const f = fixture();
  const input = { subscriptionId: "sub_one", customerId: "cus_one", plan };
  for (const status of ["paused", "active", "past_due"]) {
    f.state.subscriptionStatus = status;
    const result = await f.provider.replayPausedSubscriptionResume(scope, input, intent);
    expect(result.value.subscriptionId).toBe("sub_one");
  }
  const writes = f.requests.filter((request) => request.method === "POST");
  expect(writes).toHaveLength(3);
  for (const request of writes) {
    expect(request.path).toBe("/v1/subscriptions/sub_one/resume");
    expect(request.body.toString()).toBe("billing_cycle_anchor=now");
    expect(request.headers.get("Idempotency-Key")).toBe(intent.idempotencyKey);
  }
  f.state.livemode = true;
  await expect(f.provider.replayPausedSubscriptionResume(scope, input, intent)).rejects.toThrow();
  expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(3);
});

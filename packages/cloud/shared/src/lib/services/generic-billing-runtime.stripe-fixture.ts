/** Supplies controlled Stripe HTTP responses while retaining the production SDK, ownership checks and runtime. */
import Stripe from "stripe";

export function createRuntimeStripeFixture() {
  const requests: { method: string; path: string; body: URLSearchParams; key: string | null }[] =
    [];
  const customers = new Map<
    string,
    { id: string; object: "customer"; livemode: boolean; metadata: Record<string, string> }
  >();
  const subscriptions = new Map<
    string,
    {
      id: string;
      customer: string;
      metadata: Record<string, string>;
      quantity: number;
      startsAt: number;
      endsAt: number;
      canceled: boolean;
      cancelAtPeriodEnd: boolean;
      trial: boolean;
      invoiceId: string | null;
      paused?: boolean;
      trialStart?: number;
      trialEnd?: number;
      defaultPaymentMethod?: string;
    }
  >();
  const checkouts = new Map<
    string,
    {
      id: string;
      customer: string;
      metadata: Record<string, string>;
      quantity: number;
      expiresAt: number;
      expired: boolean;
      successUrl: string;
      cancelUrl: string;
      subscriptionId: string | null;
      mode?: "subscription" | "setup";
      setupIntentId?: string;
    }
  >();
  const updateInvoices = new Map<
    string,
    {
      subscriptionId: string;
      quantity: number;
      amount: number;
      created: number;
      prorationDate: number;
      status: "open" | "paid" | "void";
      pending: boolean;
    }
  >();
  const setupIntents = new Map<
    string,
    {
      id: string;
      object: "setup_intent";
      customer: string;
      livemode: boolean;
      metadata: Record<string, string>;
      status: "succeeded";
      payment_method: string;
    }
  >();
  const paymentMethods = new Map<
    string,
    { id: string; object: "payment_method"; customer: string; livemode: boolean }
  >();
  const resumeInvoices = new Map<
    string,
    {
      subscriptionId: string;
      created: number;
      expiresAt: number;
      status: "open" | "paid";
      paymentStatus: "requires_confirmation" | "requires_action" | "succeeded";
    }
  >();
  let resumePaymentOutcome: "paid" | "requires_action" = "paid";
  let loseNextResumePaymentResponse = false;
  function settleResumePayment(subscriptionId: string) {
    const row = subscriptions.get(subscriptionId);
    const invoice = row?.invoiceId ? resumeInvoices.get(row.invoiceId) : undefined;
    if (!row || !invoice) throw new Error("No resume invoice to settle");
    invoice.status = "paid";
    invoice.paymentStatus = "succeeded";
    row.paused = false;
  }
  const refunds = new Map<
    string,
    {
      id: string;
      object: "refund";
      charge: string;
      amount: number;
      currency: string;
      metadata: Record<string, string>;
      status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
    }
  >();
  let loseNextRefundResponse = false;
  let loseNextCheckoutResponse = false;
  let loseNextUpdateResponse = false;
  let loseNextSubscriptionResponse = false;
  function metadata(body: URLSearchParams) {
    return Object.fromEntries(
      [...body]
        .filter(([key]) => /^metadata\[[^\]]+\]$/.test(key))
        .map(([key, value]) => [key.slice(9, -1), value]),
    );
  }
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
  function subscription(row: NonNullable<ReturnType<typeof subscriptions.get>>) {
    return {
      id: row.id,
      object: "subscription",
      customer: row.customer,
      livemode: false,
      metadata: row.metadata,
      status: row.canceled ? "canceled" : row.paused ? "paused" : row.trial ? "trialing" : "active",
      default_payment_method: row.defaultPaymentMethod ?? null,
      current_period_start: row.startsAt,
      current_period_end: row.endsAt,
      trial_start: row.trialStart ?? (row.trial ? row.startsAt : null),
      trial_end: row.trialEnd ?? (row.trial ? row.endsAt : null),
      cancel_at_period_end: row.cancelAtPeriodEnd,
      canceled_at: row.canceled ? Math.floor(Date.now() / 1000) : null,
      ended_at: row.canceled ? Math.floor(Date.now() / 1000) : null,
      latest_invoice: row.invoiceId,
      pending_update:
        row.invoiceId && resumeInvoices.get(row.invoiceId)?.status === "open"
          ? { expires_at: resumeInvoices.get(row.invoiceId)!.expiresAt, subscription_items: null }
          : row.invoiceId && updateInvoices.get(row.invoiceId)?.pending
            ? {
                expires_at: updateInvoices.get(row.invoiceId)!.created + 82800,
                subscription_items: [
                  {
                    id: `si_${row.id.replace("sub_", "")}`,
                    price: price.id,
                    quantity: updateInvoices.get(row.invoiceId)!.quantity,
                  },
                ],
              }
            : null,
      items: {
        has_more: false,
        data: [{ id: `si_${row.id.replace("sub_", "")}`, quantity: row.quantity, price }],
      },
    };
  }
  function checkout(row: NonNullable<ReturnType<typeof checkouts.get>>) {
    return {
      id: row.id,
      object: "checkout.session",
      mode: row.mode ?? "subscription",
      customer: row.customer,
      livemode: false,
      metadata: row.metadata,
      subscription: row.subscriptionId,
      invoice: row.subscriptionId ? subscriptions.get(row.subscriptionId)!.invoiceId : null,
      status: row.expired
        ? "expired"
        : row.subscriptionId || row.setupIntentId
          ? "complete"
          : "open",
      setup_intent: row.setupIntentId ?? null,
      currency: "usd",
      payment_status: row.subscriptionId ? "paid" : "no_payment_required",
      payment_method_collection: row.metadata.eliza_trial_end === "none" ? "always" : "if_required",
      url: row.setupIntentId ? null : `https://checkout.stripe.com/c/pay/${row.id}`,
      expires_at: row.expiresAt,
      success_url: row.successUrl,
      cancel_url: row.cancelUrl,
    };
  }
  function updateInvoice(
    id: string,
    row: NonNullable<ReturnType<typeof subscriptions.get>>,
    value: NonNullable<ReturnType<typeof updateInvoices.get>>,
  ) {
    return {
      id,
      object: "invoice",
      created: value.created,
      hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
      livemode: false,
      customer: row.customer,
      subscription: row.id,
      charge: null,
      payment_intent: id.replace("in_", "pi_"),
      status: value.status,
      paid: value.status === "paid",
      paid_out_of_band: false,
      amount_paid: value.status === "paid" ? value.amount : 0,
      amount_due: value.amount,
      billing_reason: "subscription_update",
      subtotal: value.amount,
      subtotal_excluding_tax: value.amount,
      total: value.amount,
      tax: 0,
      total_discount_amounts: [],
      currency: "usd",
      period_start: row.startsAt,
      period_end: row.endsAt,
      automatic_tax: { enabled: false, status: null },
      lines: {
        object: "list",
        has_more: false,
        url: `/v1/invoices/${id}/lines`,
        data: [
          {
            id: `il_${id}`,
            type: "subscription",
            subscription: row.id,
            subscription_item: `si_${row.id.replace("sub_", "")}`,
            price: { id: price.id },
            quantity: value.quantity,
            amount: value.amount,
            discount_amounts: [],
            tax_amounts: [],
            period: { start: value.prorationDate, end: row.endsAt },
            proration: true,
          },
        ],
      },
    };
  }
  const resumeResponses = new Map<string, ReturnType<typeof subscription>>();
  const stripe = new Stripe("sk_test_controlled_runtime", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(
      Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          const body = new URLSearchParams(String(init?.body ?? ""));
          requests.push({
            method,
            path: url.pathname,
            body,
            key: new Headers(init?.headers).get("idempotency-key"),
          });
          if (url.pathname.startsWith("/v1/charges/")) {
            const id = url.pathname.split("/")[3]!;
            const row = [...subscriptions.values()].find(
              (row) => row.invoiceId === id.replace("ch_", "in_"),
            );
            if (!row) throw new Error("Unknown original charge");
            return Response.json({
              id,
              customer: row.customer,
              invoice: row.invoiceId,
              livemode: false,
              amount: row.quantity * 3000,
              amount_refunded: [...refunds.values()]
                .filter((refund) => refund.charge === id)
                .reduce((sum, refund) => sum + refund.amount, 0),
              paid: true,
              currency: "usd",
            });
          }
          if (url.pathname === "/v1/refunds" && method === "GET")
            return Response.json({
              object: "list",
              url: "/v1/refunds",
              has_more: false,
              data: [...refunds.values()].filter(
                (refund) => refund.charge === url.searchParams.get("charge"),
              ),
            });
          if (url.pathname === "/v1/refunds" && method === "POST") {
            const refund = {
              id: `re_runtime${refunds.size + 1}`,
              object: "refund" as const,
              charge: body.get("charge")!,
              amount: Number(body.get("amount")),
              currency: "usd",
              metadata: metadata(body),
              status: "pending" as const,
            };
            refunds.set(refund.id, refund);
            if (loseNextRefundResponse) {
              loseNextRefundResponse = false;
              return Response.json(
                { error: { type: "api_error", message: "Refund response lost after acceptance" } },
                { status: 500 },
              );
            }
            return Response.json(refund);
          }
          if (url.pathname.startsWith("/v1/refunds/")) {
            const refund = refunds.get(url.pathname.split("/")[3]!);
            if (!refund) throw new Error("Unknown refund receipt");
            return Response.json(refund);
          }
          if (url.pathname === "/v1/billing_portal/configurations" && method === "POST")
            return Response.json({ id: "bpc_runtime", object: "billing_portal.configuration" });
          if (url.pathname === "/v1/billing_portal/sessions" && method === "POST")
            return Response.json({
              id: "bps_runtime",
              object: "billing_portal.session",
              customer: body.get("customer"),
              livemode: false,
              url: "https://billing.stripe.com/p/session/runtime",
            });
          if (url.pathname === "/v1/balance")
            return Response.json({ object: "balance", livemode: false });
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
          if (url.pathname === "/v1/customers" && method === "POST") {
            const row = {
              id: `cus_runtime${customers.size + 1}`,
              object: "customer" as const,
              livemode: false,
              metadata: metadata(body),
            };
            customers.set(row.id, row);
            return Response.json(row);
          }
          if (url.pathname === "/v1/customers")
            return Response.json({
              object: "list",
              has_more: false,
              url: url.pathname,
              data: [...customers.values()],
            });
          if (url.pathname.startsWith("/v1/setup_intents/"))
            return Response.json(setupIntents.get(url.pathname.split("/")[3]!) ?? null);
          if (url.pathname.startsWith("/v1/payment_methods/"))
            return Response.json(paymentMethods.get(url.pathname.split("/")[3]!) ?? null);
          if (url.pathname.startsWith("/v1/customers/"))
            return Response.json(customers.get(url.pathname.split("/")[3]!) ?? null);
          if (url.pathname === "/v1/subscriptions" && method === "POST") {
            const endsAt = Number(body.get("trial_end"));
            const row = {
              id: `sub_runtime${subscriptions.size + 1}`,
              customer: body.get("customer")!,
              metadata: metadata(body),
              quantity: Number(body.get("items[0][quantity]")),
              startsAt: endsAt - 604800,
              endsAt,
              canceled: false,
              cancelAtPeriodEnd: false,
              trial: true,
              invoiceId: null,
            };
            subscriptions.set(row.id, row);
            if (loseNextSubscriptionResponse) {
              loseNextSubscriptionResponse = false;
              return Response.json(
                { error: { type: "api_error", message: "Response lost after provider creation" } },
                { status: 503 },
              );
            }
            return Response.json(subscription(row));
          }
          if (url.pathname === "/v1/subscriptions")
            return Response.json({
              object: "list",
              has_more: false,
              url: url.pathname,
              data: [...subscriptions.values()]
                .filter((row) => row.customer === url.searchParams.get("customer"))
                .map(subscription),
            });
          if (url.pathname.startsWith("/v1/subscriptions/")) {
            const row = subscriptions.get(url.pathname.split("/")[3]!);
            if (row) {
              if (method === "DELETE") row.canceled = true;
              if (method === "POST" && body.has("cancel_at_period_end"))
                row.cancelAtPeriodEnd = body.get("cancel_at_period_end") === "true";
              else if (method === "POST" && body.has("default_payment_method")) {
                const method = paymentMethods.get(body.get("default_payment_method")!);
                if (!method || method.customer !== row.customer)
                  throw new Error("Setup payment method is not owned by the subscription customer");
                row.defaultPaymentMethod = method.id;
              } else if (method === "POST" && url.pathname.endsWith("/resume")) {
                const key = new Headers(init?.headers).get("idempotency-key");
                if (!key) throw new Error("Resume requires an idempotency key");
                const cached = resumeResponses.get(key);
                if (cached) return Response.json(cached);
                if (!row.paused || !row.defaultPaymentMethod)
                  throw new Error(
                    "Resume requires the original paused subscription and attached method",
                  );
                if (row.invoiceId && resumeInvoices.has(row.invoiceId))
                  throw new Error("A second resume was dispatched while its invoice was pending");
                const id = `in_resume${resumeInvoices.size + 1}`;
                const created = Math.floor(Date.now() / 1000);
                // Provider service periods advance past the trial while PostgreSQL keeps its real clock.
                row.startsAt = Math.max(created, row.trialEnd ?? created);
                row.endsAt = row.startsAt + 2592000;
                row.invoiceId = id;
                resumeInvoices.set(id, {
                  subscriptionId: row.id,
                  created,
                  expiresAt: created + 82800,
                  status: "open",
                  paymentStatus: "requires_confirmation",
                });
                resumeResponses.set(key, subscription(row));
              } else if (method === "POST") {
                if (row.invoiceId && updateInvoices.get(row.invoiceId)?.pending)
                  throw new Error("A second update was dispatched while payment was pending");
                const quantity = Number(body.get("items[0][quantity]"));
                const id = `in_update${updateInvoices.size + 1}`;
                updateInvoices.set(id, {
                  subscriptionId: row.id,
                  quantity,
                  amount: (quantity - row.quantity) * 1500,
                  created: Math.floor(Date.now() / 1000),
                  prorationDate: Number(body.get("proration_date")),
                  status: "open",
                  pending: true,
                });
                row.invoiceId = id;
                if (loseNextUpdateResponse) {
                  loseNextUpdateResponse = false;
                  return Response.json(
                    {
                      error: {
                        type: "api_error",
                        message: "Update response lost after acceptance",
                      },
                    },
                    { status: 503 },
                  );
                }
              }
              return Response.json(subscription(row));
            }
          }
          if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
            const row = {
              id: `cs_runtime${checkouts.size + 1}`,
              customer: body.get("customer")!,
              metadata: metadata(body),
              quantity: Number(body.get("line_items[0][quantity]")),
              expiresAt: Math.floor(Date.now() / 1000) + 1800,
              expired: false,
              successUrl: body.get("success_url")!,
              cancelUrl: body.get("cancel_url")!,
              subscriptionId: null,
              mode: body.get("mode") === "setup" ? ("setup" as const) : ("subscription" as const),
            };
            checkouts.set(row.id, row);
            if (loseNextCheckoutResponse) {
              loseNextCheckoutResponse = false;
              return Response.json(
                {
                  error: { type: "api_error", message: "Checkout response lost after acceptance" },
                },
                { status: 500 },
              );
            }
            return Response.json(checkout(row));
          }
          if (url.pathname === "/v1/checkout/sessions")
            return Response.json({
              object: "list",
              has_more: false,
              url: url.pathname,
              data: [...checkouts.values()]
                .filter((row) => row.customer === url.searchParams.get("customer"))
                .map(checkout),
            });
          if (url.pathname.startsWith("/v1/checkout/sessions/")) {
            const row = checkouts.get(url.pathname.split("/")[4]!);
            if (row) {
              if (url.pathname.endsWith("/expire")) row.expired = true;
              if (url.pathname.endsWith("/line_items"))
                return Response.json({
                  object: "list",
                  has_more: false,
                  url: url.pathname,
                  data: [{ price, quantity: row.quantity }],
                });
              return Response.json(checkout(row));
            }
          }
          if (url.pathname === "/v1/invoices/create_preview") {
            const row = subscriptions.get(body.get("subscription")!);
            if (!row) throw new Error("Preview requires a known subscription");
            const quantity = Number(body.get("subscription_details[items][0][quantity]"));
            const recurring = body.get("preview_mode") === "recurring";
            const preview = updateInvoice("upcoming_in_preview", row, {
              subscriptionId: row.id,
              quantity,
              amount: recurring ? quantity * 3000 : (quantity - row.quantity) * 1500,
              created: Math.floor(Date.now() / 1000),
              prorationDate: recurring
                ? row.endsAt
                : Number(body.get("subscription_details[proration_date]")),
              status: "open",
              pending: false,
            });
            return Response.json({ ...preview, status: "draft", payment_intent: null });
          }
          if (url.pathname.startsWith("/v1/invoices/")) {
            const id = url.pathname.split("/")[3]!;
            const row = [...subscriptions.values()].find(
              (subscription) => subscription.invoiceId === id,
            );
            if (row) {
              const update = updateInvoices.get(id);
              if (update) {
                const value = updateInvoice(id, row, update);
                return Response.json(url.pathname.endsWith("/lines") ? value.lines : value);
              }
              const resume = resumeInvoices.get(id);
              if (resume && method === "POST" && url.pathname.endsWith("/pay")) {
                if (
                  body.get("payment_method") !== row.defaultPaymentMethod ||
                  body.get("off_session") !== "true"
                )
                  throw new Error("Resume payment must use the owned method off session");
                if (resumePaymentOutcome === "requires_action") {
                  resume.paymentStatus = "requires_action";
                  return Response.json(
                    {
                      error: {
                        type: "card_error",
                        code: "authentication_required",
                        message: "Payment requires customer authentication",
                      },
                    },
                    { status: 402 },
                  );
                }
                settleResumePayment(row.id);
                if (loseNextResumePaymentResponse) {
                  loseNextResumePaymentResponse = false;
                  return Response.json(
                    {
                      error: {
                        type: "api_error",
                        message: "Invoice pay response lost after acceptance",
                      },
                    },
                    { status: 500 },
                  );
                }
              }
              const amount = row.quantity * 3000;
              const lines = {
                object: "list",
                has_more: false,
                url: `/v1/invoices/${id}/lines`,
                data: [
                  {
                    id: `il_${id.replace("in_", "")}`,
                    type: "subscription",
                    subscription: row.id,
                    subscription_item: `si_${row.id.replace("sub_", "")}`,
                    price: { id: price.id },
                    quantity: row.quantity,
                    amount,
                    discount_amounts: [],
                    tax_amounts: [],
                    period: { start: row.startsAt, end: row.endsAt },
                    proration: false,
                  },
                ],
              };
              if (url.pathname.endsWith("/lines")) return Response.json(lines);
              return Response.json({
                id,
                object: "invoice",
                hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
                livemode: false,
                customer: row.customer,
                subscription: row.id,
                charge: resume && resume.status !== "paid" ? null : id.replace("in_", "ch_"),
                payment_intent: id.replace("in_", "pi_"),
                created: resume?.created ?? row.startsAt,
                status: resume?.status ?? "paid",
                paid: !resume || resume.status === "paid",
                paid_out_of_band: false,
                amount_paid: resume && resume.status !== "paid" ? 0 : amount,
                amount_due: amount,
                billing_reason: resume ? "subscription_cycle" : "subscription_create",
                subtotal: amount,
                subtotal_excluding_tax: amount,
                total: amount,
                tax: 0,
                total_discount_amounts: [],
                currency: "usd",
                period_start: row.startsAt,
                period_end: row.endsAt,
                lines,
              });
            }
          }
          if (url.pathname.startsWith("/v1/payment_intents/")) {
            const id = url.pathname.split("/")[3]!;
            const row = [...subscriptions.values()].find(
              (subscription) => subscription.invoiceId === id.replace("pi_", "in_"),
            );
            if (row)
              return Response.json({
                id,
                object: "payment_intent",
                livemode: false,
                customer: row.customer,
                currency: "usd",
                amount_received:
                  row.invoiceId && resumeInvoices.has(row.invoiceId)
                    ? resumeInvoices.get(row.invoiceId)!.status === "paid"
                      ? row.quantity * 3000
                      : 0
                    : row.invoiceId && updateInvoices.has(row.invoiceId)
                      ? updateInvoices.get(row.invoiceId)!.status === "paid"
                        ? updateInvoices.get(row.invoiceId)!.amount
                        : 0
                      : row.quantity * 3000,
                invoice: row.invoiceId,
                status:
                  row.invoiceId && resumeInvoices.has(row.invoiceId)
                    ? resumeInvoices.get(row.invoiceId)!.paymentStatus
                    : row.invoiceId && updateInvoices.has(row.invoiceId)
                      ? ({ open: "requires_action", paid: "succeeded", void: "canceled" } as const)[
                          updateInvoices.get(row.invoiceId)!.status
                        ]
                      : "succeeded",
              });
          }
          throw new Error(`Unexpected controlled Stripe request: ${method} ${url.pathname}`);
        },
        {
          preconnect(url: string | URL) {
            const nativeFetch = fetch;
            if ("preconnect" in nativeFetch && typeof nativeFetch.preconnect === "function")
              nativeFetch.preconnect(url);
          },
        },
      ),
    ),
  });
  return {
    setupIntents,
    paymentMethods,
    resumeInvoices,
    pauseSubscription(subscriptionId: string) {
      const row = subscriptions.get(subscriptionId);
      if (!row || !row.trial) throw new Error("Expected original trial subscription");
      row.trialStart = row.startsAt;
      row.trialEnd = row.endsAt;
      row.trial = false;
      row.paused = true;
    },
    completeSetupCheckout(sessionId: string) {
      const row = checkouts.get(sessionId);
      if (!row || row.mode !== "setup" || row.expired || row.setupIntentId)
        throw new Error("Expected open setup Checkout");
      const methodId = `pm_runtime${paymentMethods.size + 1}`,
        setupId = `seti_runtime${setupIntents.size + 1}`;
      paymentMethods.set(methodId, {
        id: methodId,
        object: "payment_method",
        customer: row.customer,
        livemode: false,
      });
      setupIntents.set(setupId, {
        id: setupId,
        object: "setup_intent",
        customer: row.customer,
        livemode: false,
        metadata: row.metadata,
        status: "succeeded",
        payment_method: methodId,
      });
      row.setupIntentId = setupId;
      return { setupIntentId: setupId, paymentMethodId: methodId };
    },
    setResumePaymentOutcome(outcome: "paid" | "requires_action") {
      resumePaymentOutcome = outcome;
    },
    loseResumePaymentResponse() {
      loseNextResumePaymentResponse = true;
    },
    settleResumePayment,
    loseCheckoutResponse() {
      loseNextCheckoutResponse = true;
    },
    loseRefundResponse() {
      loseNextRefundResponse = true;
    },
    setRefundStatus(
      id: string,
      status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled",
    ) {
      const refund = refunds.get(id);
      if (!refund) throw new Error("Unknown refund");
      refund.status = status;
    },
    stripe,
    requests,
    customers,
    subscriptions,
    checkouts,
    updateInvoices,
    loseUpdateResponse() {
      loseNextUpdateResponse = true;
    },
    settleUpdate(subscriptionId: string, outcome: "paid" | "void") {
      const row = subscriptions.get(subscriptionId);
      const invoice = row?.invoiceId ? updateInvoices.get(row.invoiceId) : null;
      if (!row || !invoice) throw new Error("No update invoice to settle");
      invoice.status = outcome;
      invoice.pending = false;
      if (outcome === "paid") row.quantity = invoice.quantity;
    },
    loseSubscriptionResponse() {
      loseNextSubscriptionResponse = true;
    },
    completeCheckout(sessionId: string) {
      const session = checkouts.get(sessionId);
      if (!session || session.expired || session.subscriptionId)
        throw new Error("Controlled checkout cannot complete");
      const id = `sub_runtime${subscriptions.size + 1}`;
      const trial = session.metadata.eliza_trial_end !== "none";
      const startsAt = trial
        ? Number(session.metadata.eliza_trial_start)
        : Math.floor(Date.now() / 1000);
      subscriptions.set(id, {
        id,
        customer: session.customer,
        metadata: session.metadata,
        quantity: session.quantity,
        startsAt,
        endsAt: trial ? Number(session.metadata.eliza_trial_end) : startsAt + 2592000,
        canceled: false,
        cancelAtPeriodEnd: false,
        trial,
        invoiceId: trial ? null : `in_runtime${subscriptions.size + 1}`,
      });
      session.subscriptionId = id;
      return id;
    },
  };
}

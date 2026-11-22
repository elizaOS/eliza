// spec/cloud/billing/subscriptionCommands.md, "Story: Change or cancel my plan without paying twice"
import type { FakeAnswer, FakeHandler } from "../fakes.ts";
import { catalogPrices } from "../profile.ts";
import { fakeSecretKey, parseForm, type StripeFake, type StripeObject } from "./stripe.ts";

const isSubscription = (object: StripeObject): object is Extract<StripeObject, { readonly object: "subscription" }> => object.object === "subscription";

export function stripeRenewalPreview(stripe: StripeFake, controls: {
  readonly now: () => number;
  readonly moveTerms: () => boolean;
  readonly loseReply: () => boolean;
  readonly exposeOrigin: () => boolean;
}): FakeHandler {
  const events: Array<{ id: string; type: string; created: number; livemode: boolean;
    request: { id: string; idempotency_key: string }; data: { object: StripeObject } }> = [];
  return async (request) => {
    if (request.headers.authorization !== `Bearer ${fakeSecretKey}`) return { status: 401, body: { error: { type: "invalid_request_error", message: "Invalid API Key provided." } } };
    const query = new URLSearchParams(request.body);
    if (request.method === "GET" && request.path === "/v1/events" && request.query.get("type") === "customer.subscription.updated") {
      return { status: 200, body: { has_more: false, data: controls.exposeOrigin() ? events : events.map((event) => ({
        ...event, request: { ...event.request, idempotency_key: "unrelated" }
      })) } };
    }
    const updated = /^\/v1\/subscriptions\/([^/]+)$/.exec(request.path)?.[1];
    const key = request.headers["idempotency-key"];
    if (request.method === "POST" && updated !== undefined && query.get("cancel_at_period_end") === "false" && typeof key === "string") {
      const answer = await stripe.handler(request);
      if (answer === undefined || answer.status !== 200) return answer;
      const subscription = stripe.object(updated);
      if (!isSubscription(subscription)) return answer;
      const requestId = `req_undo${events.length + 1}`;
      events.push({ id: `evt_undo${events.length + 1}`, type: "customer.subscription.updated",
        created: Math.floor(controls.now() / 1000), livemode: subscription.livemode,
        request: { id: requestId, idempotency_key: key }, data: { object: subscription } });
      if (controls.loseReply()) return { status: 504, body: { error: { type: "api_error" } } };
      return { ...answer, headers: { ...answer.headers, "request-id": requestId, "idempotency-key": key } };
    }
    if (request.method !== "POST" || request.path !== "/v1/invoices/create_preview" ||
        query.get("subscription_details[cancel_at_period_end]") !== "false") return stripe.handler(request);
    const form = parseForm(request.body);
    const id = typeof form.subscription === "string" ? form.subscription : "";
    const subscription = (() => {
      try {
        return stripe.object(id);
      } catch {
        return undefined;
      }
    })();
    if (subscription === undefined || !isSubscription(subscription) || subscription.customer !== form.customer ||
        !subscription.cancel_at_period_end || query.get("preview_mode") !== "next" ||
        query.get("subscription_details[proration_behavior]") !== "none") {
      return { status: 404, body: { error: { type: "invalid_request_error", code: "resource_missing", message: `No such subscription: '${id}'` } } };
    }
    const item = subscription.items.data[0];
    const amount = item.price.unit_amount;
    return {
      status: 200,
      body: {
        id: "upcoming_in_renewal", object: "invoice", status: "draft",
        amount_paid: 0, created: item.current_period_end, livemode: subscription.livemode,
        parent: { subscription_details: { subscription: subscription.id } },
        customer: subscription.customer,
        subscription: subscription.id,
        currency: "usd",
        amount_due: controls.moveTerms() ? amount + 1 : amount,
        subtotal: amount,
        total: amount,
        starting_balance: 0,
        period_start: item.current_period_end,
        period_end: item.current_period_end,
        next_payment_attempt: item.current_period_end,
        lines: { object: "list", has_more: false, data: [{
          id: "il_renewal" + item.id, object: "line_item", amount, currency: "usd", quantity: 1,
          period: { start: item.current_period_end, end: item.current_period_end + (item.current_period_end - item.current_period_start) },
          pricing: { price_details: { price: item.price.id } },
          parent: { subscription_item_details: { subscription_item: item.id, proration: false } }
        }] },
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
    return { invoice, targetPrice, subscription, key, requestId: `req_upgrade${revision}`,
      periodStart: item.current_period_start, periodEnd: item.current_period_end };
  }

  function subscriptionAfter(entry: State): Subscription {
    const sub = entry.subscription;
    const items = entry.invoice.status === "paid"
      ? { ...sub.items, data: [{ ...sub.items.data[0], price: entry.targetPrice,
        current_period_start: entry.periodStart, current_period_end: entry.periodEnd }] }
      : sub.items;
    return { ...sub, items, latest_invoice: entry.invoice.id };
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
      if (entry !== undefined) return { status: 200, body: subscriptionAfter(entry) };
    }
    if (request.method === "GET" && request.path === "/v1/subscriptions") {
      const customer = request.query.get("customer");
      const entry = [...dispatched.values()].find((each) => each.subscription.customer === customer);
      if (entry !== undefined) {
        const subscription = subscriptionAfter(entry);
        const price = request.query.get("price");
        const data = price === null || price === subscription.items.data[0].price.id ? [subscription] : [];
        return { status: 200, body: { object: "list", has_more: false, data } };
      }
    }
    if (request.method === "GET" && request.path === "/v1/events") {
      const records = [...dispatched.values()];
      const page = records.map((entry, index) => ({
        id: `evt_upgrade${index}`, type: "invoice.created", created: entry.invoice.created,
        livemode: false, request: { id: entry.requestId, idempotency_key: showOrigin ? entry.key : `unrelated-${entry.key}` },
        data: { object: entry.invoice },
      }));
      const [first] = page;
      if (showOrigin && first !== undefined && !request.query.has("starting_after")) {
        return { status: 200, body: { has_more: true, data: [{ ...first, id: "evt_skip", request: { id: "req_skip", idempotency_key: "unrelated" } }] } };
      }
      return { status: 200, body: { has_more: false, data: page } };
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
    advance: (id: string, periodStart: number, periodEnd: number) => {
      const entry = dispatched.get(id);
      if (entry === undefined) throw new Error("Missing fixture upgrade");
      entry.periodStart = periodStart / 1000;
      entry.periodEnd = periodEnd / 1000;
    },
    settle: (id: string, status: "paid" | "void") => {
      const entry = dispatched.get(id);
      if (entry === undefined) throw new Error("Missing fixture upgrade");
      entry.invoice.status = status;
      entry.invoice.amount_paid = status === "paid" ? entry.invoice.amount_due : 0;
    },
  };
}

export function stripePlanDowngrade(stripe: StripeFake, now: () => number) {
  type Subscription = Extract<StripeObject, { readonly object: "subscription" }>;
  type Phase = { start_date: number; end_date: number; items: { price: string; quantity: number }[]; proration_behavior: string };
  type Schedule = ReturnType<typeof scheduleOf>;
  type Stage = "attach" | "configure";
  type Payment = "paid" | "open" | "failed" | "plan-change";
  const entries = new Map<string, Schedule>();
  const attached = new Map<string, string>();
  const events: { type: string; created: number; object: Schedule; key: string; requestId: string }[] = [];
  const preview = stripePlanPreview(stripe, (_mode, answer) => answer);
  const failures = new Set<Stage>();
  const revealed = new Set<Stage>();
  const withheld = new Set<string>();
  const renewals = new Map<string, ReturnType<typeof renewalOf>>();
  const prefix = "/v1/subscription_schedules";
  const target = catalogPrices[0];

  function scheduleOf(id: string, subscription: Subscription) {
    const item = subscription.items.data[0];
    const current = { start_date: item.current_period_start, end_date: item.current_period_end };
    const phases: Phase[] = [{ ...current, items: [{ price: item.price.id, quantity: 1 }], proration_behavior: "create_prorations" }];
    return { id, subscription: subscription.id, customer: subscription.customer,
      livemode: false, status: "active", current_phase: current, phases, end_behavior: "release" };
  }

  function remember(subscription: Subscription) {
    const schedule = scheduleOf(`sub_sched_test${entries.size + 1}`, subscription);
    entries.set(schedule.id, schedule);
    attached.set(subscription.id, schedule.id);
    return schedule;
  }

  function send(stage: Stage, object: Schedule, key: string): FakeAnswer {
    const requestId = `req_schedule${events.length + 1}`;
    const type = stage === "attach" ? "subscription_schedule.created" : "subscription_schedule.updated";
    events.push({ type, object: structuredClone(object), created: Math.floor(now() / 1000), key, requestId });
    if (failures.delete(stage)) return { status: 503, body: { error: { type: "api_error" } } };
    return { status: 200, headers: { "request-id": requestId, "idempotency-key": key }, body: object };
  }

  function validPhases(form: URLSearchParams, schedule: Schedule, prefix: string): boolean {
    const prior = schedule.phases[0];
    return form.get(`${prefix}[0][start_date]`) === String(prior.start_date) &&
      form.get(`${prefix}[0][end_date]`) === String(prior.end_date) &&
      form.get(`${prefix}[0][proration_behavior]`) === prior.proration_behavior &&
      form.get(`${prefix}[0][items][0][price]`) === prior.items[0].price &&
      form.get(`${prefix}[0][items][0][quantity]`) === "1" &&
      form.get(`${prefix}[1][start_date]`) === String(prior.end_date) &&
      form.get(`${prefix}[1][iterations]`) === "1" && form.get(`${prefix}[1][items][0][price]`) === target.priceId &&
      form.get(`${prefix}[1][items][0][quantity]`) === "1" && form.get(`${prefix}[1][proration_behavior]`) === "none";
  }

  function renewalOf(subscription: Subscription, phase: Phase, payment: Payment) {
    const paid = payment === "paid";
    const item = subscription.items.data[0];
    const price = stripe.object(target.priceId);
    if (price.object !== "price") throw new Error("Missing the reviewed renewal price");
    const { start_date: start, end_date: end } = phase;
    const invoiceId = `in_renewal${subscription.id}`;
    const chargeId = `ch_renewal${subscription.id}`;
    const amount = target.unitAmount;
    const observed: Subscription = { ...subscription, latest_invoice: invoiceId,
      status: payment === "failed" ? "past_due" : "active",
      current_period_start: start, current_period_end: end, items: { ...subscription.items, data: [
        { ...item, price, current_period_start: start, current_period_end: end }
      ] } };
    const invoice = { id: invoiceId, customer: subscription.customer, livemode: false,
      billing_reason: payment === "plan-change" ? "subscription_update" : "subscription_cycle",
      parent: { subscription_details: { subscription: subscription.id } }, status: paid ? "paid" : "open", attempted: false,
      amount_paid: paid ? amount : 0, currency: "usd", lines: { has_more: false, data: [
        { quantity: 1, period: { start, end }, pricing: { price_details: { price: target.priceId } },
          parent: { subscription_item_details: { subscription_item: item.id, proration: false } } }
      ] } };
    const paidItems = paid ? [{ amount_paid: amount, payment: { type: "charge", charge: chargeId } }] : [];
    const charge = { id: chargeId, customer: subscription.customer, livemode: false, currency: "usd",
      paid, captured: paid, amount_refunded: 0, disputed: false };
    return { observed, invoice, paidItems, charge };
  }

  const bad = { status: 400, body: { error: { type: "invalid_request_error" } } };
  const handler: FakeHandler = (request) => {
    const form = new URLSearchParams(request.body);
    const key = request.headers["idempotency-key"];
    if (request.path === "/v1/events" && request.method === "GET") {
      const type = request.query.get("type");
      const stage = type === "subscription_schedule.created" ? "attach" : "configure";
      const eligible = events.filter((event) => event.type === type);
      return { status: 200, body: { has_more: false, data: eligible.map((event, index) => ({
        id: `evt_schedule${stage}${index}`, type: event.type, created: event.created, livemode: false,
        request: { id: event.requestId, idempotency_key: revealed.has(stage) ? event.key : `other-${event.key}` },
        data: { object: event.object },
      })) } };
    }
    if (request.method === "GET") {
      const queryCustomer = request.query.get("customer");
      const queryPrice = request.query.get("price");
      const byCustomer = [...renewals.values()].find((entry) => entry.observed.customer === queryCustomer);
      if (request.path === "/v1/subscriptions" && byCustomer !== undefined) {
        const data = queryPrice === null || queryPrice === target.priceId ? [byCustomer.observed] : [];
        return { status: 200, body: { object: "list", has_more: false, data } };
      }
      for (const renewal of renewals.values()) {
        if (request.path === `/v1/invoices/${renewal.invoice.id}`) return { status: 200, body: renewal.invoice };
        if (request.path === `/v1/charges/${renewal.charge.id}`) return { status: 200, body: renewal.charge };
        if (request.path === "/v1/invoice_payments" && request.query.get("invoice") === renewal.invoice.id)
          return { status: 200, body: { object: "list", has_more: false, data: renewal.paidItems } };
      }
    }
    const subscriptionId = /^\/v1\/subscriptions\/([^/]+)$/.exec(request.path)?.[1];
    if (request.method === "GET" && subscriptionId !== undefined) {
      const schedule = attached.get(subscriptionId);
      if (schedule !== undefined) return { status: 200, body: { ...(renewals.get(subscriptionId)?.observed ?? stripe.object(subscriptionId)), schedule } };
    }
    if (request.path === prefix && request.method === "POST") {
      const subscription = stripe.object(form.get("from_subscription") ?? "");
      if (request.headers.authorization !== `Bearer ${fakeSecretKey}` || typeof key !== "string" ||
          !isSubscription(subscription) || attached.has(subscription.id) ||
          request.headers["stripe-version"] !== "2024-11-20.acacia" || [...form].length !== 1) return bad;
      return send("attach", remember(subscription), key);
    }
    if (request.path.startsWith(prefix + "/")) {
      const stored = entries.get(request.path.slice(prefix.length + 1));
      if (stored === undefined) return { status: 404, body: { error: { type: "invalid_request_error", code: "resource_missing" } } };
      if (request.method === "GET") {
        return { status: 200, body: withheld.has(stored.subscription) ? { ...stored, customer: "cus_other" } : stored };
      }
      if (typeof key !== "string" || request.headers.authorization !== `Bearer ${fakeSecretKey}` ||
          stored.phases.length !== 1 || request.headers["stripe-version"] !== "2024-11-20.acacia" ||
          !validPhases(form, stored, "phases") || form.get("proration_behavior") !== "none" || form.get("end_behavior") !== "release")
        return bad;
      const prior = stored.phases[0];
      stored.phases.push({ start_date: prior.end_date, end_date: prior.end_date + prior.end_date - prior.start_date,
        items: [{ price: target.priceId, quantity: 1 }], proration_behavior: "none" });
      return send("configure", stored, key);
    }
    if (request.path === "/v1/invoices/create_preview" && request.method === "POST" && form.has("schedule")) {
      const schedule = entries.get(form.get("schedule") ?? "");
      if (schedule === undefined || schedule.customer !== form.get("customer") || !validPhases(form, schedule, "schedule_details[phases]") ||
          form.get("preview_mode") !== "next" || form.get("schedule_details[end_behavior]") !== "release" ||
          request.headers["stripe-version"] !== "2024-11-20.acacia") return bad;
      const start = schedule.current_phase.end_date;
      const end = start + start - schedule.current_phase.start_date;
      return { status: 200, body: {
        id: "upcoming_in_scheduletest", customer: schedule.customer, subscription: schedule.subscription, currency: "usd",
        amount_due: target.unitAmount, amount_paid: 0, livemode: false, status: "draft",
        lines: { has_more: false, data: [{ id: "il_downgrade", currency: "usd", amount: target.unitAmount, quantity: 1,
          period: { start, end }, price: { id: target.priceId }, proration: false }] },
      } };
    }
    return preview(request) ?? stripe.handler(request);
  };
  return {
    handler,
    existing: (id: string) => {
      const subscription = stripe.object(id);
      if (!isSubscription(subscription)) throw new Error("Missing fixture subscription");
      return remember(subscription).id;
    },
    renew: (id: string, payment: Payment) => {
      const subscription = stripe.object(id);
      const schedule = entries.get(attached.get(id) ?? "");
      const effective = schedule?.phases[1];
      if (!isSubscription(subscription) || schedule === undefined || effective === undefined) throw new Error("Missing configured fixture renewal");
      schedule.current_phase = { start_date: effective.start_date, end_date: effective.end_date };
      renewals.set(id, renewalOf(subscription, effective, payment));
    },
    lose: (stage: Stage) => { failures.add(stage); },
    reveal: (stage: Stage) => { revealed.add(stage); },
    conceal: (stage: Stage) => { revealed.delete(stage); },
    hideScheduleBinding: (subscription: string) => withheld.add(subscription),
    showScheduleBinding: (subscription: string) => withheld.delete(subscription),
  };
}

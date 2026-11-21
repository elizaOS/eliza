// spec/cloud/billing/subscriptionCommands.md, "Story: Get the plan I paid for"
import type { FakeAnswer, FakeHandler, FakeRequest } from "../fakes.ts";
import { fakeSecretKey, type StripeFake, type StripePrice, type StripeSubscription } from "./stripe.ts";

export interface PlanChangeInvoice {
  readonly id: string;
  readonly object: "invoice";
  readonly customer: string;
  status: "open" | "paid" | "void";
  readonly billing_reason: "subscription_update";
  readonly amount_due: number;
  amount_paid: number;
  readonly currency: "usd";
  readonly livemode: false;
  readonly created: number;
  readonly period_start: number;
  readonly period_end: number;
  readonly hosted_invoice_url: string;
  readonly parent: { readonly subscription_details: { readonly subscription: string } };
  readonly lines: { readonly object: "list"; readonly data: []; readonly has_more: false };
}

export interface PlanChangeSchedule {
  readonly id: string;
  readonly object: "subscription_schedule";
  readonly subscription: string;
  end_behavior: string;
  phases: Array<{ readonly start_date: number; readonly end_date: number | null; readonly items: ReadonlyArray<{ readonly price: string }> }>;
}

export interface StripePlanChange {
  readonly handler: FakeHandler;
  readonly invoices: ReadonlyArray<PlanChangeInvoice>;
  readonly schedules: ReadonlyArray<PlanChangeSchedule>;
  readonly previews: ReadonlyArray<URLSearchParams>;
  readonly updates: ReadonlyArray<URLSearchParams>;
  declineNextUpgrade(): void;
  payInvoice(id: string): Promise<void>;
  voidInvoice(id: string): void;
}

interface Pending {
  readonly subscriptionId: string;
  readonly itemId: string;
  readonly priceId: string;
}

const refuse = (status: number, message: string): FakeAnswer => ({ status, body: { error: { type: "invalid_request_error", message } } });

export function createStripePlanChange(stripe: StripeFake, now: () => number = Date.now): StripePlanChange {
  const invoices = new Map<string, PlanChangeInvoice>();
  const schedules = new Map<string, PlanChangeSchedule>();
  const scheduleOf = new Map<string, string>();
  const pending = new Map<string, Pending>();
  const replies = new Map<string, { readonly fingerprint: string; readonly answer: FakeAnswer }>();
  const previews: URLSearchParams[] = [];
  const updates: URLSearchParams[] = [];
  let declineNext = false;
  let sequence = 0;
  const seconds = () => Math.floor(now() / 1000);

  const subscription = (id: string): StripeSubscription | undefined => {
    try {
      const found = stripe.object(id);
      return found.object === "subscription" ? found : undefined;
    } catch {
      return undefined;
    }
  };
  const price = (id: string): StripePrice | undefined => {
    try {
      const found = stripe.object(id);
      return found.object === "price" ? found : undefined;
    } catch {
      return undefined;
    }
  };
  const viewOf = (found: StripeSubscription, latestInvoice?: string) => ({
    ...found,
    latest_invoice: latestInvoice ?? found.latest_invoice,
    schedule: scheduleOf.get(found.id) ?? null,
    pending_update: [...pending.values()].some((change) => change.subscriptionId === found.id) ? { expires_at: seconds() + 82_800 } : null,
  });

  async function movePrice(change: Pending): Promise<void> {
    const form = new URLSearchParams([["items[0][id]", change.itemId], ["items[0][price]", change.priceId]]);
    await stripe.handler({ method: "POST", path: `/v1/subscriptions/${change.subscriptionId}`, query: new URLSearchParams(), headers: { authorization: `Bearer ${fakeSecretKey}` }, body: form.toString(), raw: new Uint8Array() });
  }

  function prorated(found: StripeSubscription, targetPriceId: string, prorationDate: number): number | undefined {
    const item = found.items.data[0];
    const target = price(targetPriceId);
    if (item === undefined || target === undefined || prorationDate < item.current_period_start || prorationDate > item.current_period_end) return undefined;
    return Math.round(((target.unit_amount - item.price.unit_amount) * (item.current_period_end - prorationDate)) / (item.current_period_end - item.current_period_start));
  }

  function preview(form: URLSearchParams): FakeAnswer {
    previews.push(form);
    const found = subscription(form.get("subscription") ?? "");
    if (found === undefined || found.customer !== form.get("customer")) return refuse(404, "No such subscription");
    if (form.get("subscription_details[items][0][id]") !== found.items.data[0]?.id || form.get("subscription_details[proration_behavior]") !== "always_invoice") return refuse(400, "The fake previews one replaced item with always_invoice.");
    const amount = prorated(found, form.get("subscription_details[items][0][price]") ?? "", Number(form.get("subscription_details[proration_date]")));
    if (amount === undefined) return refuse(400, "proration_date must fall within the current period");
    return { status: 200, body: { object: "invoice", customer: found.customer, subscription: found.id, currency: "usd", amount_due: Math.max(0, amount), total: amount, lines: { object: "list", data: [], has_more: false } } };
  }

  async function upgrade(found: StripeSubscription, form: URLSearchParams): Promise<FakeAnswer> {
    updates.push(form);
    const item = found.items.data[0];
    const priceId = form.get("items[0][price]") ?? "";
    if (item === undefined || form.get("items[0][id]") !== item.id) return refuse(400, "No such subscription item");
    if (form.get("payment_behavior") !== "pending_if_incomplete") return refuse(400, "The fake upgrades only with pending_if_incomplete.");
    const amount = prorated(found, priceId, Number(form.get("proration_date")));
    if (amount === undefined) return refuse(400, "proration_date must fall within the current period");
    const paid = !declineNext;
    declineNext = false;
    const id = `in_planchange${String(++sequence).padStart(6, "0")}`;
    const created = seconds();
    invoices.set(id, {
      id, object: "invoice", customer: found.customer, status: paid ? "paid" : "open", billing_reason: "subscription_update", amount_due: amount, amount_paid: paid ? amount : 0,
      currency: "usd", livemode: false, created, period_start: created, period_end: created, hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
      parent: { subscription_details: { subscription: found.id } }, lines: { object: "list", data: [], has_more: false },
    });
    const change = { subscriptionId: found.id, itemId: item.id, priceId };
    if (paid) await movePrice(change);
    else pending.set(id, change);
    return { status: 200, body: viewOf(subscription(found.id) ?? found, id) };
  }

  function createSchedule(form: URLSearchParams): FakeAnswer {
    const found = subscription(form.get("from_subscription") ?? "");
    const item = found?.items.data[0];
    if (found === undefined || item === undefined) return refuse(404, "No such subscription");
    if (scheduleOf.has(found.id)) return refuse(400, "This subscription is already attached to a schedule.");
    const id = `sub_sched_fake${String(++sequence).padStart(6, "0")}`;
    const schedule: PlanChangeSchedule = { id, object: "subscription_schedule", subscription: found.id, end_behavior: "release", phases: [{ start_date: item.current_period_start, end_date: item.current_period_end, items: [{ price: item.price.id }] }] };
    schedules.set(id, schedule);
    scheduleOf.set(found.id, id);
    return { status: 200, body: schedule };
  }

  function updateSchedule(schedule: PlanChangeSchedule, form: URLSearchParams): FakeAnswer {
    const phases: PlanChangeSchedule["phases"] = [];
    for (let index = 0; form.has(`phases[${index}][items][0][price]`); index += 1) {
      const priceId = form.get(`phases[${index}][items][0][price]`) ?? "";
      if (price(priceId) === undefined) return refuse(400, `No such price: '${priceId}'`);
      const start = index === 0 ? Number(form.get("phases[0][start_date]")) : (phases[index - 1]?.end_date ?? 0);
      const end = form.has(`phases[${index}][end_date]`) ? Number(form.get(`phases[${index}][end_date]`)) : form.get(`phases[${index}][duration][interval]`) === "month" ? start + 30 * 86_400 : null;
      phases.push({ start_date: start, end_date: end, items: [{ price: priceId }] });
    }
    if (phases[0]?.start_date !== schedule.phases[0]?.start_date) return refuse(400, "You can not modify the start date of the current phase.");
    schedule.phases = phases;
    schedule.end_behavior = form.get("end_behavior") ?? schedule.end_behavior;
    return { status: 200, body: schedule };
  }

  async function route(request: FakeRequest): Promise<FakeAnswer | undefined> {
    const form = new URLSearchParams(request.body);
    const [, , resource, id, action] = request.path.split("/");
    if (request.method === "POST" && request.path === "/v1/invoices/create_preview" && form.has("subscription_details[items][0][price]")) return preview(form);
    if (resource === "invoices" && id !== undefined && action === undefined && request.method === "GET") {
      const invoice = invoices.get(id);
      return invoice === undefined ? undefined : { status: 200, body: invoice };
    }
    if (resource === "subscriptions" && id !== undefined && action === undefined) {
      const found = subscription(id);
      if (found === undefined) return undefined;
      if (request.method === "GET") return { status: 200, body: viewOf(found) };
      if (request.method === "POST" && form.get("proration_behavior") === "always_invoice") return await upgrade(found, form);
      return undefined;
    }
    if (resource === "subscription_schedules" && request.method === "POST" && id === undefined) return createSchedule(form);
    if (resource === "subscription_schedules" && id !== undefined) {
      const schedule = schedules.get(id);
      if (schedule === undefined) return refuse(404, `No such subscription_schedule: '${id}'`);
      return request.method === "GET" ? { status: 200, body: schedule } : updateSchedule(schedule, form);
    }
    return undefined;
  }

  async function handler(request: FakeRequest): Promise<FakeAnswer | undefined> {
    if (request.headers.authorization !== `Bearer ${fakeSecretKey}`) return stripe.handler(request);
    const header = request.headers["idempotency-key"];
    const key = request.method === "POST" && typeof header === "string" ? header : undefined;
    const fingerprint = `${request.path} ${request.body}`;
    const replay = key === undefined ? undefined : replies.get(key);
    if (replay !== undefined) return replay.fingerprint === fingerprint ? { ...replay.answer, headers: { "idempotent-replayed": "true" } } : { status: 400, body: { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters." } } };
    const answer = await route(request);
    if (answer === undefined) return stripe.handler(request);
    if (key !== undefined && answer.status < 500) replies.set(key, { fingerprint, answer: structuredClone(answer) });
    return answer;
  }

  return {
    handler,
    get invoices() {
      return [...invoices.values()];
    },
    get schedules() {
      return [...schedules.values()];
    },
    previews,
    updates,
    declineNextUpgrade: () => {
      declineNext = true;
    },
    payInvoice: async (id) => {
      const invoice = invoices.get(id);
      const change = pending.get(id);
      if (invoice === undefined || invoice.status !== "open" || change === undefined) throw new Error(`invoice ${id} is not an open upgrade invoice`);
      invoice.status = "paid";
      invoice.amount_paid = invoice.amount_due;
      pending.delete(id);
      await movePrice(change);
    },
    voidInvoice: (id) => {
      const invoice = invoices.get(id);
      if (invoice === undefined || invoice.status !== "open") throw new Error(`invoice ${id} is not open`);
      invoice.status = "void";
      pending.delete(id);
    },
  };
}

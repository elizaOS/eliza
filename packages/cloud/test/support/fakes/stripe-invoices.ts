// spec/cloud/billing/subscriptions.md, "Story: Read my invoices and open the billing portal"
import type { FakeAnswer, FakeHandler, FakeRequest } from "../fakes.ts";
import { fakeSecretKey, parseForm } from "./stripe.ts";

type Form = ReturnType<typeof parseForm>;

export interface InvoiceSeed {
  readonly customer: string;
  readonly amountCents: number;
  readonly status?: "draft" | "open" | "paid" | "uncollectible" | "void";
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly lines?: number;
}

interface FakeInvoiceLine {
  readonly id: string;
  readonly object: "line_item";
  readonly description: string;
  readonly amount: number;
  readonly currency: "usd";
  readonly quantity: number;
  readonly period: { readonly start: number; readonly end: number };
}

interface FakeInvoice {
  readonly id: string;
  readonly object: "invoice";
  readonly customer: string;
  readonly number: string | null;
  readonly status: NonNullable<InvoiceSeed["status"]>;
  readonly amount_due: number;
  readonly amount_paid: number;
  readonly currency: "usd";
  readonly hosted_invoice_url: string | null;
  readonly invoice_pdf: string | null;
  readonly created: number;
  readonly period_start: number;
  readonly period_end: number;
  readonly lines: ReadonlyArray<FakeInvoiceLine>;
}

export interface PortalFeatures {
  readonly customer_update: { readonly enabled: boolean };
  readonly invoice_history: { readonly enabled: boolean };
  readonly payment_method_update: { readonly enabled: boolean };
  readonly subscription_cancel: { readonly enabled: boolean; readonly mode: string; readonly proration_behavior: string };
  readonly subscription_update: { readonly enabled: boolean };
}

export interface PortalConfiguration {
  readonly id: string;
  readonly object: "billing_portal.configuration";
  readonly active: boolean;
  readonly livemode: boolean;
  metadata: Record<string, string>;
  features: PortalFeatures;
}

export interface PortalSession {
  readonly id: string;
  readonly customer: string;
  readonly return_url: string | null;
  readonly configuration: string | null;
  readonly url: string;
}

export interface StripeInvoicesFake {
  readonly handler: FakeHandler;
  readonly configurations: ReadonlyArray<PortalConfiguration>;
  readonly portalSessions: ReadonlyArray<PortalSession>;
  customer(id: string): void;
  invoice(seed: InvoiceSeed): string;
  configuration(configuration: Omit<PortalConfiguration, "id" | "object">): string;
}

const pageSize = 10;

function invoiceWire(invoice: FakeInvoice) {
  return {
    ...invoice,
    lines: {
      object: "list",
      url: `/v1/invoices/${invoice.id}/lines`,
      data: invoice.lines.slice(0, pageSize),
      has_more: invoice.lines.length > pageSize,
    },
  };
}

function refuse(status: number, message: string, code?: string): FakeAnswer {
  return { status, body: { error: { type: "invalid_request_error", message, ...(code === undefined ? {} : { code }) } } };
}

function page<T extends { readonly id: string }>(all: ReadonlyArray<T>, query: URLSearchParams, url: string): FakeAnswer {
  const after = query.get("starting_after");
  const start = after === null ? 0 : all.findIndex((entry) => entry.id === after) + 1;
  if (after !== null && start === 0) return refuse(400, `No such object: '${after}'`, "resource_missing");
  const limit = Math.min(Math.max(Number(query.get("limit") ?? pageSize), 1), 100);
  return { status: 200, body: { object: "list", url, data: all.slice(start, start + limit), has_more: start + limit < all.length } };
}

function flag(form: Form, section: string, key = "enabled"): boolean | undefined {
  const features = form.features;
  if (typeof features !== "object" || Array.isArray(features)) return undefined;
  const part = features[section];
  if (typeof part !== "object" || Array.isArray(part)) return undefined;
  const value = part[key];
  return value === "true" ? true : value === "false" ? false : undefined;
}

function word(form: Form, section: string, key: string): string | undefined {
  const features = form.features;
  if (typeof features !== "object" || Array.isArray(features)) return undefined;
  const part = features[section];
  if (typeof part !== "object" || Array.isArray(part)) return undefined;
  const value = part[key];
  return typeof value === "string" ? value : undefined;
}

function featuresFrom(form: Form, base: PortalFeatures): PortalFeatures {
  return {
    customer_update: { enabled: flag(form, "customer_update") ?? base.customer_update.enabled },
    invoice_history: { enabled: flag(form, "invoice_history") ?? base.invoice_history.enabled },
    payment_method_update: { enabled: flag(form, "payment_method_update") ?? base.payment_method_update.enabled },
    subscription_cancel: {
      enabled: flag(form, "subscription_cancel") ?? base.subscription_cancel.enabled,
      mode: word(form, "subscription_cancel", "mode") ?? base.subscription_cancel.mode,
      proration_behavior: word(form, "subscription_cancel", "proration_behavior") ?? base.subscription_cancel.proration_behavior,
    },
    subscription_update: { enabled: flag(form, "subscription_update") ?? base.subscription_update.enabled },
  };
}

function metadataFrom(form: Form): Record<string, string> {
  const metadata = form.metadata;
  if (typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return Object.fromEntries(Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const stripeDefaults: PortalFeatures = {
  customer_update: { enabled: true },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: "immediately", proration_behavior: "none" },
  subscription_update: { enabled: true },
};

export function createStripeInvoicesFake(options: { readonly livemode?: boolean } = {}): StripeInvoicesFake {
  const livemode = options.livemode ?? false;
  const customers = new Set<string>();
  const invoices: FakeInvoice[] = [];
  const configurations: PortalConfiguration[] = [];
  const portalSessions: PortalSession[] = [];
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}_inv${String(++sequence).padStart(6, "0")}`;

  function route(request: FakeRequest): FakeAnswer | undefined {
    const form = parseForm(request.method === "GET" ? request.query.toString() : request.body);
    const invoiceLines = /^\/v1\/invoices\/([^/]+)\/lines$/.exec(request.path);
    const invoice = /^\/v1\/invoices\/([^/]+)$/.exec(request.path);
    const configuration = /^\/v1\/billing_portal\/configurations\/([^/]+)$/.exec(request.path);
    if (request.method === "GET" && request.path === "/v1/invoices") {
      const customer = request.query.get("customer");
      const listed = invoices.filter((entry) => customer === null || entry.customer === customer).reverse();
      return page(listed.map(invoiceWire), request.query, request.path);
    }
    if (request.method === "GET" && invoiceLines !== null) {
      const found = invoices.find((entry) => entry.id === invoiceLines[1]);
      return found === undefined ? refuse(404, `No such invoice: '${invoiceLines[1]}'`, "resource_missing") : page(found.lines, request.query, request.path);
    }
    if (request.method === "GET" && invoice !== null) {
      const found = invoices.find((entry) => entry.id === invoice[1]);
      if (found === undefined) return refuse(404, `No such invoice: '${invoice[1]}'`, "resource_missing");
      return { status: 200, body: invoiceWire(found) };
    }
    if (request.method === "GET" && request.path === "/v1/billing_portal/configurations") {
      const active = request.query.get("active");
      return page(configurations.filter((entry) => active === null || String(entry.active) === active), request.query, request.path);
    }
    if (request.method === "POST" && request.path === "/v1/billing_portal/configurations") {
      const created: PortalConfiguration = { id: nextId("bpc"), object: "billing_portal.configuration", active: true, livemode, metadata: metadataFrom(form), features: featuresFrom(form, stripeDefaults) };
      configurations.push(created);
      return { status: 200, body: created };
    }
    if (request.method === "POST" && configuration !== null) {
      const found = configurations.find((entry) => entry.id === configuration[1]);
      if (found === undefined) return refuse(404, `No such configuration: '${configuration[1]}'`, "resource_missing");
      found.features = featuresFrom(form, found.features);
      found.metadata = { ...found.metadata, ...metadataFrom(form) };
      return { status: 200, body: found };
    }
    if (request.method === "POST" && request.path === "/v1/billing_portal/sessions") {
      const customer = typeof form.customer === "string" ? form.customer : "";
      if (!customers.has(customer)) return refuse(400, `No such customer: '${customer}'`, "resource_missing");
      const chosen = typeof form.configuration === "string" ? form.configuration : null;
      if (chosen !== null && !configurations.some((entry) => entry.id === chosen)) return refuse(400, `No such configuration: '${chosen}'`, "resource_missing");
      const id = nextId("bps");
      const session: PortalSession = { id, customer, return_url: typeof form.return_url === "string" ? form.return_url : null, configuration: chosen, url: `https://billing.stripe.com/p/session/test_${id}` };
      portalSessions.push(session);
      return { status: 200, body: { object: "billing_portal.session", livemode, ...session } };
    }
    return undefined;
  }

  return {
    handler: (request) => (request.headers.authorization !== `Bearer ${fakeSecretKey}` ? refuse(401, "Invalid API Key provided.") : route(request)),
    configurations,
    portalSessions,
    customer: (id) => {
      customers.add(id);
    },
    invoice: (seed) => {
      customers.add(seed.customer);
      const id = nextId("in");
      const status = seed.status ?? "paid";
      const count = seed.lines ?? 1;
      const lines = Array.from({ length: count }, (_, index): FakeInvoiceLine => ({
        id: nextId("il"),
        object: "line_item",
        description: `Line ${index + 1}`,
        amount: index === 0 ? seed.amountCents - (count - 1) : 1,
        currency: "usd",
        quantity: 1,
        period: { start: seed.periodStart, end: seed.periodEnd },
      }));
      invoices.push({
        id,
        object: "invoice",
        customer: seed.customer,
        number: status === "draft" ? null : `FAKE-${String(invoices.length + 1).padStart(4, "0")}`,
        status,
        amount_due: seed.amountCents,
        amount_paid: status === "paid" ? seed.amountCents : 0,
        currency: "usd",
        hosted_invoice_url: status === "draft" ? null : `https://invoice.stripe.com/i/${id}`,
        invoice_pdf: status === "draft" ? null : `https://pay.stripe.com/invoice/${id}/pdf`,
        created: seed.periodStart,
        period_start: seed.periodStart,
        period_end: seed.periodEnd,
        lines,
      });
      return id;
    },
    configuration: (input) => {
      const id = nextId("bpc");
      configurations.push({ id, object: "billing_portal.configuration", ...input });
      return id;
    },
  };
}

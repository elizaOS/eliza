import { expect, test } from "bun:test";
import { settlementDigest } from "./settlement-digest";
import { proveInvoiceSettlement } from "./stripe-invoice-settlement";
import {
  bindSubscriptionInvoiceEventEvidence as bind,
  createSubscriptionInvoiceEventEvidence as create,
} from "./subscription-invoice-event-evidence";
import { invoiceEventFixture as fixture } from "./test-support/subscription-invoice-event-fixture";

test("retains a deferred invoice observation without admitting it as payment", () => {
  const f = fixture();
  const evidence = create(f.event, f.scope);
  expect(evidence.event.data.object.ending_balance).toBe(20);
  expect(bind(evidence, f.scope)).toEqual(evidence);
  expect(() => proveInvoiceSettlement(evidence.event.data.object)).toThrow();
  expect(JSON.stringify(evidence)).not.toContain("grantDigest");
});
test("captures later debt collection as an observation without allocating money", () => {
  const f = fixture();
  Object.assign(f.invoice, {
    starting_balance: 20,
    ending_balance: 0,
    amount_due: 40,
    amount_paid: 40,
  });
  const evidence = create(f.event, f.scope);
  expect(evidence.event.data.object.starting_balance).toBe(20);
  expect(() => proveInvoiceSettlement(evidence.event.data.object)).toThrow();
});
test("projects private event and invoice fields and copies nested input", () => {
  const f = fixture();
  const evidence = create(
    {
      ...f.event,
      request: { idempotency_key: "private" },
      data: {
        object: {
          ...f.invoice,
          customer_email: "private@example.test",
          metadata: { secret: "private" },
          lines: {
            ...f.invoice.lines,
            data: f.invoice.lines.data.map((line) => ({ ...line, description: "private" })),
          },
        },
      },
    },
    f.scope,
  );
  expect(JSON.stringify(evidence)).not.toContain("private");
  f.invoice.lines.data[0]!.price.id = "price_changed";
  expect(evidence.event.data.object.lines.data[0]!.price.id).toBe("price_original");
});
for (const key of [
  "organizationId",
  "subscriptionId",
  "providerAccountId",
  "customerId",
  "providerSubscriptionId",
  "invoiceId",
  "providerEventId",
  "livemode",
] as const) {
  test(`stored scope cannot be rebound: ${key}`, () => {
    const f = fixture();
    const evidence = create(f.event, f.scope);
    const changed = {
      ...f.scope,
      [key]:
        key === "livemode"
          ? true
          : key.endsWith("Id") && ["organizationId", "subscriptionId"].includes(key)
            ? "33333333-3333-4333-8333-333333333333"
            : String(f.scope[key]) + "other",
    };
    expect(() => bind(evidence, changed)).toThrow();
  });
}
for (const [name, mutate] of [
  [
    "event identity",
    (f: ReturnType<typeof fixture>) => {
      f.event.id = "evt_other";
    },
  ],
  [
    "event mode",
    (f: ReturnType<typeof fixture>) => {
      f.event.livemode = true;
    },
  ],
  [
    "invoice mode",
    (f: ReturnType<typeof fixture>) => {
      f.invoice.livemode = true;
    },
  ],
  [
    "customer",
    (f: ReturnType<typeof fixture>) => {
      f.invoice.customer = "cus_other";
    },
  ],
  [
    "subscription",
    (f: ReturnType<typeof fixture>) => {
      f.invoice.subscription = "sub_other";
    },
  ],
  [
    "invoice identity",
    (f: ReturnType<typeof fixture>) => {
      f.invoice.id = "in_other";
    },
  ],
  [
    "API version",
    (f: ReturnType<typeof fixture>) => {
      f.event.api_version = "2025-03-31.basil";
    },
  ],
  [
    "truncated lines",
    (f: ReturnType<typeof fixture>) => {
      f.invoice.lines.has_more = true;
    },
  ],
  [
    "foreign line",
    (f: ReturnType<typeof fixture>) => {
      f.invoice.lines.data[0]!.subscription = "sub_other";
    },
  ],
  [
    "empty interval",
    (f: ReturnType<typeof fixture>) => {
      f.invoice.lines.data[0]!.period.end = 1700000000;
    },
  ],
  [
    "unsafe balance",
    (f: ReturnType<typeof fixture>) => {
      f.invoice.ending_balance = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "invalid clock",
    (f: ReturnType<typeof fixture>) => {
      f.event.created = Number.MAX_SAFE_INTEGER;
    },
  ],
  [
    "out of band",
    (f: ReturnType<typeof fixture>) => {
      f.invoice.paid_out_of_band = true;
    },
  ],
] as const) {
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    expect(() => create(f.event, f.scope)).toThrow();
  });
}
for (const key of ["account", "context"])
  test(`rejects foreign event ${key}`, () => {
    const f = fixture();
    expect(() => create({ ...f.event, [key]: "acct_other" }, f.scope)).toThrow();
  });
test("stored private extras are rejected even with a recomputed digest", () => {
  const f = fixture();
  const { digest: _, ...body } = create(f.event, f.scope);
  const extra = {
    ...body,
    event: {
      ...body.event,
      data: { object: { ...body.event.data.object, customer_email: "private@example.test" } },
    },
  };
  expect(() => bind({ ...extra, digest: settlementDigest(extra) }, f.scope)).toThrow();
});
test("changed retained money fails its original digest", () => {
  const f = fixture();
  const evidence = create(f.event, f.scope);
  evidence.event.data.object.ending_balance++;
  expect(() => bind(evidence, f.scope)).toThrow();
});

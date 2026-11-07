import { expect, test } from "bun:test";
import { createServer } from "node:http";
import Stripe from "stripe";
import { observeRetainedInvoiceBalance as observe } from "./retained-invoice-balance-observation";
import { createSubscriptionInvoiceEventEvidence } from "./subscription-invoice-event-evidence";
import { invoiceEventFixture } from "./test-support/subscription-invoice-event-fixture";

function fixture() {
  const f = invoiceEventFixture();
  const original = createSubscriptionInvoiceEventEvidence(f.event, f.scope);
  const ledger = [
    {
      id: "cbtxn_collection",
      object: "customer_balance_transaction",
      customer: f.scope.customerId,
      invoice: "in_collector",
      livemode: false,
      currency: "usd",
      amount: -20,
      ending_balance: 0,
      created: 1701000000,
      type: "applied_to_invoice",
      credit_note: null,
    },
    {
      id: "cbtxn_original",
      object: "customer_balance_transaction",
      customer: f.scope.customerId,
      invoice: f.scope.invoiceId,
      livemode: false,
      currency: "usd",
      amount: 20,
      ending_balance: 20,
      created: 1700000010,
      type: "invoice_too_small",
      credit_note: null,
    },
  ];
  return { f, original, ledger };
}
type Fixture = ReturnType<typeof fixture>;
type Read = { path: string; count: number; body: unknown; state: Fixture; params: URLSearchParams };
async function run(input: {
  configure?: (state: Fixture) => void;
  failPath?: string;
  transform?: (read: Read) => unknown;
  check: (
    pending: ReturnType<typeof observe>,
    requests: Array<{ method: string; version: string }>,
    state: Fixture,
  ) => Promise<void>;
}) {
  const state = fixture();
  input.configure?.(state);
  const requests: Array<{ method: string; version: string }> = [];
  const counts = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    requests.push({ method: request.method!, version: String(request.headers["stripe-version"]) });
    const count = (counts.get(url.pathname) ?? 0) + 1;
    counts.set(url.pathname, count);
    if (url.pathname === input.failPath) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "private-provider-secret", type: "api_error" } }),
      );
      return;
    }
    let body: unknown;
    if (url.pathname === "/v1/account") body = { object: "account", id: "acct_owner" };
    else if (url.pathname === "/v1/invoices/in_original") body = state.f.invoice;
    else if (url.pathname === "/v1/customers/cus_owner/balance_transactions")
      body = {
        object: "list",
        has_more: false,
        data: url.searchParams.get("limit") === "1" ? state.ledger.slice(0, 1) : state.ledger,
      };
    else {
      response.writeHead(404);
      response.end();
      return;
    }
    if (input.transform)
      body = input.transform({ path: url.pathname, count, body, state, params: url.searchParams });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing local test address");
  const stripe = new Stripe("sk_test_observation_fixture", {
    host: "127.0.0.1",
    port: address.port,
    protocol: "http",
    maxNetworkRetries: 0,
  });
  try {
    await input.check(observe(state.original, stripe), requests, state);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const unavailable = (reason: string) => ({
  code: "SUBSCRIPTION_INVOICE_BALANCE_UNAVAILABLE",
  context: { reason },
});

test("reads original invoice and complete ledger twice through pinned SDK GETs without allocating collection", async () => {
  await run({
    check: async (pending, requests, state) => {
      const result = await pending;
      expect(result.originalEvidenceDigest).toBe(state.original.digest);
      expect(result.invoice.amount_due).toBe(0);
      expect(result.invoice.ending_balance).toBe(20);
      expect(result.history.data).toEqual(state.ledger);
      expect(result.history.has_more).toBe(false);
      expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(result).not.toHaveProperty("collectedAmount");
      expect(result).not.toHaveProperty("grant");
      expect(requests).toHaveLength(12);
      expect(requests.every((x) => x.method === "GET" && x.version === "2024-11-20.acacia")).toBe(
        true,
      );
    },
  });
});
for (const [name, change, reason] of [
  [
    "customer",
    (s: Fixture) => {
      s.f.invoice.customer = "cus_foreign";
    },
    "original_invoice_identity_changed",
  ],
  [
    "subscription",
    (s: Fixture) => {
      s.f.invoice.subscription = "sub_foreign";
    },
    "original_invoice_identity_changed",
  ],
  [
    "item",
    (s: Fixture) => {
      s.f.invoice.lines.data[0]!.subscription_item = "si_foreign";
    },
    "original_invoice_identity_changed",
  ],
  [
    "period",
    (s: Fixture) => {
      s.f.invoice.lines.data[0]!.period.end++;
    },
    "original_invoice_identity_changed",
  ],
  [
    "invoice mode",
    (s: Fixture) => {
      s.f.invoice.livemode = true;
    },
    "original_invoice_identity_changed",
  ],
  [
    "missing posting",
    (s: Fixture) => {
      s.ledger[1]!.invoice = "in_other";
    },
    "original_invoice_posting_missing",
  ],
  [
    "currency",
    (s: Fixture) => {
      s.ledger[0]!.currency = "eur";
    },
    "ledger_currency_mismatch",
  ],
  [
    "discontinuity",
    (s: Fixture) => {
      s.ledger[0]!.ending_balance = 1;
    },
    "ledger_discontinuity",
  ],
  [
    "reversed chronology",
    (s: Fixture) => {
      s.ledger[0]!.created = 1;
    },
    "ledger_discontinuity",
  ],
] as const)
  test(`rejects ${name}`, async () => {
    await run({
      configure: change,
      check: async (pending) => {
        await expect(pending).rejects.toMatchObject(unavailable(reason));
      },
    });
  });
test("does not release observations when merchant changes after reads", async () => {
  await run({
    transform: (r) =>
      r.path === "/v1/account" && r.count === 4 ? { object: "account", id: "acct_other" } : r.body,
    check: async (pending) => {
      await expect(pending).rejects.toMatchObject(unavailable("merchant_mismatch"));
    },
  });
});
test("detects invoice changes inside one read window", async () => {
  await run({
    transform: (r) =>
      r.path.startsWith("/v1/invoices/") && r.count === 2
        ? { ...r.state.f.invoice, post_payment_credit_notes_amount: 1 }
        : r.body,
    check: async (pending) => {
      await expect(pending).rejects.toMatchObject(unavailable("invoice_changed_during_read"));
    },
  });
});
test("detects a stable but changed second observation", async () => {
  await run({
    transform: (r) =>
      r.path.startsWith("/v1/invoices/") && r.count >= 3
        ? { ...r.state.f.invoice, post_payment_credit_notes_amount: 1 }
        : r.body,
    check: async (pending) => {
      await expect(pending).rejects.toMatchObject(unavailable("observation_changed_during_read"));
    },
  });
});
test("ledger head replacement cannot be returned as a complete observation", async () => {
  await run({
    transform: (r) =>
      r.params.get("limit") === "1"
        ? { object: "list", has_more: false, data: [{ ...r.state.ledger[0], id: "cbtxn_new" }] }
        : r.body,
    check: async (pending) => {
      await expect(pending).rejects.toMatchObject({
        code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
        context: { reason: "balance_history_changed" },
      });
    },
  });
});
test("same-second ledger postings retain provider order and must reconcile arithmetically", async () => {
  await run({
    configure: (s) => {
      s.ledger[0]!.created = s.ledger[1]!.created;
    },
    check: async (pending) => {
      expect((await pending).history.data).toHaveLength(2);
    },
  });
});
test("provider private fields are not retained", async () => {
  await run({
    transform: (r) =>
      r.path.startsWith("/v1/invoices/")
        ? {
            ...r.state.f.invoice,
            customer_email: "private@example.test",
            description: "private",
            metadata: { secret: "private" },
          }
        : r.body,
    check: async (pending) => {
      expect(JSON.stringify(await pending)).not.toContain("private");
    },
  });
});
test("copies original scope before network await", async () => {
  await run({
    transform: (r) => {
      if (r.path === "/v1/account" && r.count === 1)
        r.state.original.scope.customerId = "cus_mutated";
      return r.body;
    },
    check: async (pending) => {
      expect((await pending).customerId).toBe("cus_owner");
    },
  });
});
test("missing original debt never starts provider reads", async () => {
  await run({
    configure: (s) => {
      s.f.invoice.ending_balance = 0;
      s.original = createSubscriptionInvoiceEventEvidence(s.f.event, s.f.scope);
    },
    check: async (pending, requests) => {
      await expect(pending).rejects.toMatchObject(unavailable("original_debit_required"));
      expect(requests).toHaveLength(0);
    },
  });
});
test("scan exhaustion fails explicitly without presenting partial history", async () => {
  await run({
    transform: (r) =>
      r.path.includes("balance_transactions")
        ? {
            object: "list",
            has_more: true,
            data: [{ ...r.state.ledger[0], id: `cbtxn_page${r.count}` }],
          }
        : r.body,
    check: async (pending, requests) => {
      await expect(pending).rejects.toMatchObject({
        code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
        context: { reason: "balance_history_scan_limit" },
      });
      expect(requests).toHaveLength(102);
    },
  });
});

test("provider failures release no observation or private error material and do not retry", async () => {
  await run({
    failPath: "/v1/invoices/in_original",
    check: async (pending, requests) => {
      const error = await pending.catch((value: unknown) => value);
      expect(error).toMatchObject(unavailable("provider_read_failed"));
      expect(String(error)).not.toContain("private-provider-secret");
      expect(JSON.stringify(error)).not.toContain("private-provider-secret");
      expect(requests).toHaveLength(2);
    },
  });
});

test("traverses paginated history with the provider cursor on both observations", async () => {
  await run({
    transform: (r) => {
      if (!r.path.includes("balance_transactions") || r.params.get("limit") === "1") return r.body;
      const cursor = r.params.get("starting_after");
      expect(cursor === null || cursor === "cbtxn_collection").toBe(true);
      return { object: "list", has_more: cursor === null, data: [r.state.ledger[cursor ? 1 : 0]] };
    },
    check: async (pending, requests, state) => {
      expect((await pending).history.data).toEqual(state.ledger);
      expect(requests).toHaveLength(14);
    },
  });
});

test("detects an older posting changing across snapshots even with the same head", async () => {
  await run({
    transform: (r) =>
      r.path.includes("balance_transactions") && r.count >= 3 && r.params.get("limit") !== "1"
        ? {
            object: "list",
            has_more: false,
            data: [r.state.ledger[0], { ...r.state.ledger[1], type: "adjustment" }],
          }
        : r.body,
    check: async (pending) => {
      await expect(pending).rejects.toMatchObject(unavailable("observation_changed_during_read"));
    },
  });
});

import { expect, test } from "bun:test";
import { createServer } from "node:http";
import Stripe from "stripe";
import { observeRetainedCollectingInvoiceCapture as observe } from "./retained-collecting-invoice-capture";
import { createSubscriptionInvoiceEventEvidence } from "./subscription-invoice-event-evidence";
import { invoiceEventFixture } from "./test-support/subscription-invoice-event-fixture";

function fixture() {
  const f = invoiceEventFixture();
  const invoice = {
    ...f.invoice,
    starting_balance: 20,
    ending_balance: 0,
    total: 100,
    subtotal: 100,
    amount_due: 120,
    amount_paid: 120,
    payment_intent: "pi_collect",
    charge: "ch_collect",
    lines: { ...f.invoice.lines, data: [{ ...f.invoice.lines.data[0]!, amount: 100 }] },
  };
  const original = createSubscriptionInvoiceEventEvidence(
    { ...f.event, data: { object: invoice } },
    f.scope,
  );
  const common = {
    customer: f.scope.customerId,
    invoice: f.scope.invoiceId,
    livemode: false,
    currency: "usd",
    application: null,
    application_fee_amount: null,
    on_behalf_of: null,
    transfer_data: null,
  };
  const payment = {
    ...common,
    id: "pi_collect",
    object: "payment_intent",
    status: "succeeded",
    latest_charge: "ch_collect",
    amount: 120,
    amount_received: 120,
    amount_capturable: 0,
  };
  const charge = {
    ...common,
    id: "ch_collect",
    object: "charge",
    status: "succeeded",
    payment_intent: "pi_collect",
    amount: 120,
    amount_captured: 120,
    amount_refunded: 0,
    captured: true,
    paid: true,
    refunded: false,
    disputed: false,
    refunds: { has_more: false, data: [] },
    application_fee: null,
  };
  const row = {
    object: "customer_balance_transaction",
    customer: f.scope.customerId,
    livemode: false,
    currency: "usd",
    credit_note: null,
  };
  const ledger = [
    {
      ...row,
      id: "cbtxn_collect",
      invoice: f.scope.invoiceId,
      type: "applied_to_invoice",
      amount: -20,
      ending_balance: 0,
      created: 1700000010,
    },
    {
      ...row,
      id: "cbtxn_debt",
      invoice: "in_debt",
      type: "invoice_too_small",
      amount: 20,
      ending_balance: 20,
      created: 1700000001,
    },
  ];
  return { original, invoice, payment, charge, ledger };
}
type State = ReturnType<typeof fixture>;
async function run(input: {
  configure?: (s: State) => void;
  transform?: (
    path: string,
    count: number,
    body: unknown,
    s: State,
    params: URLSearchParams,
  ) => unknown;
  failPath?: string;
  check: (
    pending: ReturnType<typeof observe>,
    requests: Array<{ method: string; version: string }>,
    s: State,
  ) => Promise<void>;
}) {
  const s = fixture();
  input.configure?.(s);
  const requests: Array<{ method: string; version: string }> = [];
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const path = url.pathname,
      count = (counts.get(path) ?? 0) + 1;
    counts.set(path, count);
    requests.push({ method: req.method!, version: String(req.headers["stripe-version"]) });
    res.setHeader("Content-Type", "application/json");
    if (path === input.failPath) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { type: "api_error", message: "private-provider-secret" } }));
      return;
    }
    let body: unknown;
    if (path === "/v1/account") body = { object: "account", id: "acct_owner" };
    else if (path === "/v1/invoices/in_original") body = s.invoice;
    else if (path === "/v1/payment_intents/pi_collect") body = s.payment;
    else if (path === "/v1/charges/ch_collect") body = s.charge;
    else if (path === "/v1/customers/cus_owner/balance_transactions")
      body = {
        object: "list",
        has_more: false,
        data: url.searchParams.get("limit") === "1" ? s.ledger.slice(0, 1) : s.ledger,
      };
    else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.end(
      JSON.stringify(
        input.transform ? input.transform(path, count, body, s, url.searchParams) : body,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No local test address");
  const stripe = new Stripe("sk_test_collecting_fixture", {
    host: "127.0.0.1",
    port: address.port,
    protocol: "http",
    maxNetworkRetries: 0,
  });
  try {
    await input.check(observe(s.original, stripe), requests, s);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
test("observes retained collecting invoice, complete ledger and capture through pinned GETs without allocation", async () => {
  await run({
    check: async (pending, requests, s) => {
      const result = await pending;
      expect(result.originalEvidenceDigest).toBe(s.original.digest);
      expect(result.balance.invoice.starting_balance).toBe(20);
      expect(result.balance.history.data).toEqual(s.ledger);
      expect(result.payment.amount_received).toBe(120);
      expect(result.charge.amount_captured).toBe(120);
      expect(result).not.toHaveProperty("allocation");
      expect(result).not.toHaveProperty("grant");
      expect(requests).toHaveLength(30);
      expect(requests.every((r) => r.method === "GET" && r.version === "2024-11-20.acacia")).toBe(
        true,
      );
    },
  });
});
for (const [name, mutate] of [
  [
    "foreign charge invoice",
    (s: State) => {
      s.charge.invoice = "in_other";
    },
  ],
  [
    "partial capture",
    (s: State) => {
      s.charge.amount_captured = 100;
    },
  ],
  [
    "refund",
    (s: State) => {
      s.charge.amount_refunded = 1;
    },
  ],
  [
    "dispute",
    (s: State) => {
      s.charge.disputed = true;
    },
  ],
  [
    "foreign payment customer",
    (s: State) => {
      s.payment.customer = "cus_other";
    },
  ],
  [
    "different mode",
    (s: State) => {
      s.payment.livemode = true;
    },
  ],
  [
    "changed payment pointer",
    (s: State) => {
      s.invoice.payment_intent = "pi_changed";
    },
  ],
  [
    "different original due amount",
    (s: State) => {
      s.invoice.amount_due = 100;
      s.invoice.amount_paid = 100;
      s.payment.amount = 100;
      s.payment.amount_received = 100;
      s.charge.amount = 100;
      s.charge.amount_captured = 100;
    },
  ],
] as const)
  test(`rejects ${name}`, async () => {
    await run({
      configure: mutate,
      check: async (pending) => {
        await expect(pending).rejects.toThrow();
      },
    });
  });
test("rejects a merchant change after the last captured-payment read", async () => {
  await run({
    transform: (path, count, body) =>
      path === "/v1/account" && count === 10 ? { object: "account", id: "acct_changed" } : body,
    check: async (pending) => {
      await expect(pending).rejects.toMatchObject({
        code: "SUBSCRIPTION_COLLECTING_CAPTURE_UNAVAILABLE",
        context: { reason: "merchant_changed_after_capture" },
      });
    },
  });
});
test("refund appearing on the repeated charge read prevents release", async () => {
  await run({
    transform: (path, count, body, s) =>
      path.startsWith("/v1/charges/") && count === 2 ? { ...s.charge, amount_refunded: 1 } : body,
    check: async (pending) => {
      await expect(pending).rejects.toThrow();
    },
  });
});
test("changed full ledger across otherwise stable balance observations prevents release", async () => {
  await run({
    transform: (path, count, body, s, params) =>
      path.includes("balance_transactions") && count >= 5 && params.get("limit") !== "1"
        ? {
            object: "list",
            has_more: false,
            data: [s.ledger[0], { ...s.ledger[1], type: "adjustment" }],
          }
        : body,
    check: async (pending) => {
      await expect(pending).rejects.toMatchObject({
        code: "SUBSCRIPTION_COLLECTING_CAPTURE_UNAVAILABLE",
        context: { reason: "capture_observation_changed" },
      });
    },
  });
});
test("copies original identity before provider waits", async () => {
  await run({
    transform: (path, count, body, s) => {
      if (path === "/v1/account" && count === 1) s.original.scope.invoiceId = "in_mutated";
      return body;
    },
    check: async (pending) => {
      expect((await pending).balance.invoiceId).toBe("in_original");
    },
  });
});
test("provider failure is sanitized without retry or partial result", async () => {
  await run({
    failPath: "/v1/charges/ch_collect",
    check: async (pending, requests) => {
      const error = await pending.catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "SUBSCRIPTION_COLLECTING_CAPTURE_UNAVAILABLE",
        context: { reason: "provider_read_failed" },
      });
      expect(JSON.stringify(error)).not.toContain("private-provider-secret");
      expect(requests).toHaveLength(14);
    },
  });
});
test("a non-collecting original never starts provider reads", async () => {
  await run({
    configure: (s) => {
      s.invoice.starting_balance = 0;
      const f = invoiceEventFixture();
      s.original = createSubscriptionInvoiceEventEvidence(
        { ...f.event, data: { object: s.invoice } },
        f.scope,
      );
    },
    check: async (pending, requests) => {
      await expect(pending).rejects.toMatchObject({
        code: "SUBSCRIPTION_COLLECTING_CAPTURE_UNAVAILABLE",
        context: { reason: "original_collecting_payment_required" },
      });
      expect(requests).toHaveLength(0);
    },
  });
});
test("private payment fields never enter capture evidence", async () => {
  await run({
    transform: (path, _count, body, s) =>
      path.startsWith("/v1/payment_intents/")
        ? { ...s.payment, client_secret: "private-secret", metadata: { private: true } }
        : body,
    check: async (pending) => {
      expect(JSON.stringify(await pending)).not.toContain("private");
    },
  });
});

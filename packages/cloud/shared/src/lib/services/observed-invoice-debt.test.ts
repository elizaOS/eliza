import { expect, test } from "bun:test";
import { createServer } from "node:http";
import Stripe from "stripe";
import { createStripeRecoveryFetch } from "../stripe-recovery-transport";
import { observeOriginalInvoiceDebt as observe } from "./observed-invoice-debt";
import { invoiceDebtFixture } from "./test-support/invoice-debt-fixture";

function fixture() {
  const input = invoiceDebtFixture();
  const invoices = new Map(
    [input.collector, ...input.originals].map((original) => [
      original.scope.invoiceId,
      structuredClone(original.event.data.object),
    ]),
  );
  const owner = {
    customer: "cus_owner",
    invoice: "in_c",
    livemode: false,
    currency: "usd",
    application: null,
    application_fee_amount: null,
    on_behalf_of: null,
    transfer_data: null,
  };
  return {
    input,
    invoices,
    merchant: "acct_owner",
    history: structuredClone(input.history),
    payment: {
      ...owner,
      id: "pi_collect",
      object: "payment_intent",
      status: "succeeded",
      latest_charge: "ch_collect",
      amount: 140,
      amount_received: 140,
      amount_capturable: 0,
    },
    charge: {
      ...owner,
      id: "ch_collect",
      object: "charge",
      status: "succeeded",
      payment_intent: "pi_collect",
      amount: 140,
      amount_captured: 140,
      amount_refunded: 0,
      captured: true,
      paid: true,
      refunded: false,
      disputed: false,
      refunds: { has_more: false, data: [] },
      application_fee: null,
    },
  };
}
type State = ReturnType<typeof fixture>;
async function run(options: {
  deadlineMs?: number;
  configure?: (state: State) => void;
  transform?: (
    path: string,
    count: number,
    body: unknown,
    state: State,
  ) => unknown | Promise<unknown>;
  check: (
    pending: ReturnType<typeof observe>,
    requests: Array<{ path: string; method: string; version: string }>,
    state: State,
  ) => Promise<void>;
}) {
  const state = fixture();
  options.configure?.(state);
  const requests: Array<{ path: string; method: string; version: string }> = [];
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"),
      path = url.pathname;
    const count = (counts.get(path) ?? 0) + 1;
    counts.set(path, count);
    requests.push({ path, method: req.method!, version: String(req.headers["stripe-version"]) });
    let body: unknown;
    if (path === "/v1/account") body = { object: "account", id: state.merchant };
    else if (path.startsWith("/v1/invoices/")) body = state.invoices.get(path.split("/").at(-1)!);
    else if (path === "/v1/payment_intents/pi_collect") body = state.payment;
    else if (path === "/v1/charges/ch_collect") body = state.charge;
    else if (path === "/v1/customers/cus_owner/balance_transactions")
      body = {
        ...state.history,
        data:
          url.searchParams.get("limit") === "1"
            ? state.history.data.slice(0, 1)
            : state.history.data,
      };
    res.setHeader("Content-Type", "application/json");
    if (!body) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: { message: "private-provider-secret", type: "invalid_request_error" },
        }),
      );
      return;
    }
    Promise.resolve(options.transform?.(path, count, body, state) ?? body).then(
      (value) => res.end(JSON.stringify(value)),
      () => res.destroy(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback address missing");
  const stripe = new Stripe("sk_test_cloud_e2e", {
    host: "127.0.0.1",
    port: address.port,
    protocol: "http",
    maxNetworkRetries: 0,
    timeout: 1000,
    httpClient: Stripe.createFetchHttpClient(
      createStripeRecoveryFetch(Date.now() + (options.deadlineMs ?? 5000)),
    ),
  });
  try {
    await options.check(observe(state.input, stripe), requests, state);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
test("SDK observation binds current originals to unchanged capture and conserved carry-forward", async () => {
  await run({
    check: async (pending, requests) => {
      const result = await pending;
      expect(result.kind).toBe("observed_original_invoice_debt");
      expect(result.trace.components.map((c) => c.amount)).toEqual([20, 20]);
      expect(result.capture.payment.amount_received).toBe(140);
      expect(result.originals.map((o) => o.invoiceId)).toEqual(["in_a", "in_b"]);
      expect(result.originals[0]!.invoice.lines.data[0]!.period).toEqual({ start: 9, end: 110 });
      expect(requests).toHaveLength(64);
      expect(requests.every((r) => r.method === "GET" && r.version === "2024-11-20.acacia")).toBe(
        true,
      );
      expect(requests.filter((r) => r.path === "/v1/invoices/in_a")).toHaveLength(2);
      expect(requests.at(-1)!.path).toBe("/v1/account");
    },
  });
});
for (const fault of [
  "credit note",
  "total",
  "line",
  "period",
  "item",
  "void",
  "ending balance",
  "payment reference",
] as const)
  test(`rejects current original ${fault}`, async () => {
    await run({
      configure: (s) => {
        const invoice = s.invoices.get("in_a")!;
        switch (fault) {
          case "credit note":
            invoice.post_payment_credit_notes_amount = 1;
            break;
          case "total":
            invoice.total++;
            break;
          case "line":
            invoice.lines.data[0]!.amount++;
            break;
          case "period":
            invoice.lines.data[0]!.period.end++;
            break;
          case "item":
            invoice.lines.data[0]!.subscription_item = "si_replaced";
            break;
          case "void":
            Object.assign(invoice, { status: "void", paid: false });
            break;
          case "ending balance":
            invoice.ending_balance++;
            break;
          case "payment reference":
            invoice.payment_intent = "pi_later";
            break;
        }
      },
      check: async (pending) => {
        await expect(pending).rejects.toThrow();
      },
    });
  });
test("rejects collector total changes even when full due and capture still match", async () => {
  await run({
    configure: (s) => {
      s.invoices.get("in_c")!.total++;
    },
    check: async (pending) => {
      await expect(pending).rejects.toMatchObject({
        code: "SUBSCRIPTION_INVOICE_DEBT_OBSERVATION_UNAVAILABLE",
        context: { reason: "collecting_invoice_changed" },
      });
    },
  });
});
for (const fault of ["original", "refund", "ledger", "merchant"] as const)
  test(`rejects ${fault} changing after the first original read`, async () => {
    await run({
      transform: (path, count, body, s) => {
        if (path === "/v1/invoices/in_b" && count === 2) {
          if (fault === "original")
            return { ...(body as object), post_payment_credit_notes_amount: 1 };
          if (fault === "refund") {
            s.charge.refunded = true;
            s.charge.amount_refunded = 1;
          }
          if (fault === "ledger") s.history.data[3]!.amount++;
          if (fault === "merchant") s.merchant = "acct_other";
        }
        return body;
      },
      check: async (pending) => {
        await expect(pending).rejects.toThrow();
      },
    });
  });
test("copies originals before the first asynchronous provider boundary", async () => {
  await run({
    transform: (path, count, body, s) => {
      if (path === "/v1/account" && count === 1) {
        s.input.originals[0]!.event.data.object.total = 999;
        s.input.originals.length = 0;
        s.input.collector.event.data.object.total = 999;
      }
      return body;
    },
    check: async (pending) => {
      expect((await pending).trace.components.map((c) => c.amount)).toEqual([20, 20]);
    },
  });
});
test("provider failures are sanitized, never retried, and return no partial observation", async () => {
  await run({
    configure: (s) => {
      s.invoices.delete("in_a");
    },
    check: async (pending, requests) => {
      const error = await pending.catch((error) => error);
      expect(error).toMatchObject({
        code: "SUBSCRIPTION_INVOICE_DEBT_OBSERVATION_UNAVAILABLE",
        context: { reason: "provider_read_failed" },
      });
      expect(String(error)).not.toContain("private-provider-secret");
      expect(requests.filter((r) => r.path === "/v1/invoices/in_a")).toHaveLength(1);
    },
  });
});
test("projected provider fields exclude private descriptions and metadata", async () => {
  await run({
    transform: (path, _count, body) =>
      path.startsWith("/v1/invoices/")
        ? {
            ...(body as object),
            description: "private-invoice-secret",
            metadata: { secret: "private-invoice-secret" },
          }
        : body,
    check: async (pending) => {
      expect(JSON.stringify(await pending)).not.toContain("private-invoice-secret");
    },
  });
});

test("a failed sibling waits for all outstanding reads before returning", async () => {
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  await run({
    configure: (s) => {
      s.invoices.delete("in_a");
    },
    transform: async (path, count, body) => {
      if (path === "/v1/invoices/in_b" && count === 1) {
        started();
        await held;
      }
      return body;
    },
    check: async (pending, requests) => {
      let completed = false;
      const result = pending.then(
        (value) => {
          completed = true;
          return { value };
        },
        (error) => {
          completed = true;
          return { error };
        },
      );
      try {
        await reached;
        await Bun.sleep(20);
        expect(completed).toBe(false);
      } finally {
        release();
      }
      expect(await result).toMatchObject({
        error: { code: "SUBSCRIPTION_INVOICE_DEBT_OBSERVATION_UNAVAILABLE" },
      });
      const count = requests.length;
      await Bun.sleep(20);
      expect(requests).toHaveLength(count);
    },
  });
});
test("one absolute deadline bounds stalled original reads and prevents later capture reads", async () => {
  const started = Date.now();
  await run({
    deadlineMs: 300,
    transform: (path, _count, body) =>
      path === "/v1/invoices/in_a" ? new Promise<never>(() => {}) : body,
    check: async (pending, requests) => {
      await expect(pending).rejects.toMatchObject({
        code: "SUBSCRIPTION_INVOICE_DEBT_OBSERVATION_UNAVAILABLE",
      });
      expect(requests.filter((r) => r.path === "/v1/invoices/in_a")).toHaveLength(1);
      expect(requests.filter((r) => r.path === "/v1/charges/ch_collect")).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(1500);
    },
  });
});

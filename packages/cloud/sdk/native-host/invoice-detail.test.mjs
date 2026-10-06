import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createCloudRoutes } from "./cloud-services.mjs";

const invoice = () => ({
  id: "invoice_123",
  invoiceNumber: "INV-123",
  status: "paid",
  currency: "usd",
  amountDue: 12.5,
  amountPaid: 12.5,
  createdAt: "2026-10-01T12:00:00Z",
  dueDate: null,
  paidAt: "2026-10-02T12:00:00.123Z",
  invoiceType: "auto_top_up",
  hostedInvoiceUrl: "https://invoice.stripe.com/i/fixture?token=private",
  invoicePdf: "https://pay.stripe.com/invoice/acct_test/fixture/pdf?s=private",
  stripeCustomerId: "private_customer",
  stripeInvoiceId: "private_invoice",
  metadata: { secret: "private_metadata" },
  chargeBreakdown: {
    creditedBaseUsd: "10.00",
    affiliateMarkupUsd: "1.50",
    platformFeeUsd: "1.00",
    totalChargeUsd: "12.50",
  },
});
async function fixture(
  t,
  { enabled = true, key = "private_key", provider } = {},
) {
  const calls = [];
  const routes = createCloudRoutes({
    initialApiKey: key,
    hostPolicy: {
      accountBilling: enabled,
      projectAccountAccess: () => ({ state: "active" }),
      requireNonSensitiveText() {},
      pickMessage: (value) => value,
      fundingError: () => Error("Funding unavailable"),
      planKeys: ["independent"],
      planCurrency: "eur",
      planInterval: "year",
      speechLanguage: "fr",
      multipartPrefix: "independent",
      providerDefaultVoice: true,
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return provider
        ? provider(url, init)
        : Response.json({ invoice: invoice() });
    },
  });
  const server = http.createServer((req, res) =>
    routes(req, res, new URL(req.url, "http://localhost")),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    calls,
    get: (path = "/cloud/account/invoices/invoice_123", method = "GET") =>
      fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        ...(method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: "{}" }
          : {}),
      }),
  };
}

test("native invoice details project canonical read-only facts without private provider fields", async (t) => {
  const f = await fixture(t);
  const r = await f.get();
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.deepEqual(result.invoice, {
    id: "invoice_123",
    invoiceNumber: "INV-123",
    status: "paid",
    currency: "USD",
    amountDue: "12.50",
    amountPaid: "12.50",
    createdAt: "2026-10-01T12:00:00.000Z",
    dueDate: null,
    paidAt: "2026-10-02T12:00:00.123Z",
    merchantUrl: invoice().hostedInvoiceUrl,
    pdfUrl: invoice().invoicePdf,
    chargeBreakdown: invoice().chargeBreakdown,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /private_customer|private_invoice|private_metadata|private_key/,
  );
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/api\/invoices\/invoice_123$/);
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.redirect, "error");
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer private_key");
  assert.equal(f.calls[0].init.body, undefined);
});

test("invoice routing rejects mutation, query, encoded and malformed IDs without provider calls", async (t) => {
  const f = await fixture(t);
  for (const [path, method] of [
    ["/cloud/account/invoices/invoice_123?organizationId=other", "GET"],
    ["/cloud/account/invoices/invoice_123", "POST"],
    ["/cloud/account/invoices/invoice_123", "DELETE"],
    ["/cloud/account/invoices/invoice_123/", "GET"],
    ["/cloud/account/invoices/a%2Fb", "GET"],
    ["/cloud/account/invoices/%69nvoice_123", "GET"],
    [`/cloud/account/invoices/${"a".repeat(129)}`, "GET"],
  ])
    assert.ok((await f.get(path, method)).status >= 400, path);
  assert.equal(f.calls.length, 0);
  const disabled = await fixture(t, { enabled: false });
  assert.equal((await disabled.get()).status, 404);
  assert.equal(disabled.calls.length, 0);
  const signedOut = await fixture(t, { key: null });
  assert.equal((await signedOut.get()).status, 401);
  assert.equal(signedOut.calls.length, 0);
});

test("invoice identity, currency, money precision and dates fail closed", async (t) => {
  let change = {};
  const f = await fixture(t, {
    provider: () => Response.json({ invoice: { ...invoice(), ...change } }),
  });
  for (const bad of [
    { id: "other" },
    { status: "unknown" },
    { currency: "ZZZ" },
    { amountDue: -1 },
    { amountPaid: "1e2" },
    { amountDue: "01.00" },
    { amountDue: "12.501" },
    { amountDue: "900719925474099.99" },
    { amountDue: Number("90071992547409.91") },
    { currency: "kwd", amountDue: Number("9007199254740.991") },
    { createdAt: "2026-02-30T12:00:00Z" },
    { createdAt: null },
    { paidAt: "2026-10-01" },
    { invoiceNumber: "bad\nnumber" },
    { invoiceNumber: " " },
  ]) {
    change = bad;
    assert.equal((await f.get()).status, 502, JSON.stringify(bad));
  }
  for (const [currency, amount, expected] of [
    ["jpy", "12.0000", "12"],
    ["kwd", "12.345", "12.345"],
    ["usd", "0.1000", "0.10"],
  ]) {
    change = { currency, amountDue: amount, amountPaid: amount };
    const r = await f.get();
    assert.equal(r.status, 200);
    assert.equal((await r.json()).invoice.amountPaid, expected);
  }
  change = { amountDue: "90071992547409.91", amountPaid: "90071992547409.91" };
  const exact = await f.get();
  assert.equal(exact.status, 200);
  assert.equal((await exact.json()).invoice.amountDue, "90071992547409.91");
  change = { currency: "jpy", amountDue: "12.01" };
  assert.equal((await f.get()).status, 502);
});

test("unsafe invoice links are omitted and optional fee lines require exact paid-USD reconciliation", async (t) => {
  let change = {};
  const f = await fixture(t, {
    provider: () => Response.json({ invoice: { ...invoice(), ...change } }),
  });
  for (const url of [
    "javascript:alert(1)",
    "https://pay.stripe.com.evil.test/invoice/acct_test/a/pdf",
    "https://user@pay.stripe.com/invoice/acct_test/a/pdf",
    "https://pay.stripe.com/invoice/acct_test/a/pdf#secret",
    "http://pay.stripe.com/invoice/acct_test/a/pdf",
    "https://pay.stripe.com/invoice/acct_test/a/other",
  ]) {
    change = { invoicePdf: url, hostedInvoiceUrl: url };
    const value = (await (await f.get()).json()).invoice;
    assert.equal(value.pdfUrl, null, url);
    assert.equal(value.merchantUrl, null, url);
  }
  for (const bad of [
    { invoiceType: "subscription" },
    { status: "open" },
    { currency: "eur" },
    { amountPaid: 10 },
    {
      chargeBreakdown: { ...invoice().chargeBreakdown, platformFeeUsd: "2.00" },
    },
    {
      chargeBreakdown: { ...invoice().chargeBreakdown, totalChargeUsd: "12.5" },
    },
    {
      chargeBreakdown: {
        ...invoice().chargeBreakdown,
        creditedBaseUsd: "-10.00",
      },
    },
    { chargeBreakdown: null },
  ]) {
    change = bad;
    const r = await f.get();
    assert.equal(r.status, 200);
    assert.equal((await r.json()).invoice.chargeBreakdown, null);
  }
});

test("invoice ownership errors propagate and logout fences a late provider reply", async (t) => {
  for (const status of [403, 404]) {
    const f = await fixture(t, {
      provider: () => Response.json({ error: "unavailable" }, { status }),
    });
    assert.equal((await f.get()).status, status);
  }
  let release, entered;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, {
    provider: async () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = f.get();
  await enteredPromise;
  assert.equal((await f.get("/cloud/logout", "POST")).status, 200);
  release(Response.json({ invoice: invoice() }));
  const late = await pending;
  assert.equal(late.status, 409);
  assert.doesNotMatch(await late.text(), /INV-123|12.50|stripe/);
});

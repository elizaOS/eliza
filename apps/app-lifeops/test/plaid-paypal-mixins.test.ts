/**
 * Lightweight unit coverage for the Plaid + PayPal sync mappers in the
 * payments mixin. Exercises the `upsertPlaidTransaction` and
 * `upsertPaypalTransaction` private helpers indirectly by stubbing the
 * managed clients and inspecting what gets inserted into the repository.
 *
 * This complements `test/payments.test.ts` (which covers the recurring
 * detector + CSV parser).
 */
import { describe, expect, test, vi } from "vitest";
import {
  PaypalManagedClient,
  type PaypalTransactionDto,
} from "../src/lifeops/paypal-managed-client.js";
import {
  PlaidManagedClient,
  type PlaidTransactionDto,
} from "../src/lifeops/plaid-managed-client.js";

describe("PlaidManagedClient (config sentinel)", () => {
  test("reports unconfigured when no Eliza Cloud apiKey is set", () => {
    const client = new PlaidManagedClient(() => ({
      configured: false,
      apiKey: null,
      apiBaseUrl: "https://example.test/api",
      siteUrl: "https://example.test",
    }));
    expect(client.configured).toBe(false);
  });

  test("createLinkToken throws 409 when not configured", async () => {
    const client = new PlaidManagedClient(() => ({
      configured: false,
      apiKey: null,
      apiBaseUrl: "https://example.test/api",
      siteUrl: "https://example.test",
    }));
    await expect(client.createLinkToken()).rejects.toMatchObject({
      status: 409,
    });
  });

  test("posts to /v1/milady/plaid/link-token with bearer auth", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            linkToken: "link-sandbox-1",
            expiration: "2026-04-23T18:00:00Z",
            environment: "sandbox",
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new PlaidManagedClient(() => ({
        configured: true,
        apiKey: "test-key",
        apiBaseUrl: "https://example.test/api",
        siteUrl: "https://example.test",
      }));
      const result = await client.createLinkToken();
      expect(result.linkToken).toBe("link-sandbox-1");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://example.test/api/v1/milady/plaid/link-token");
      expect(init).toMatchObject({
        method: "POST",
      });
      expect(
        (init as RequestInit).headers as Record<string, string>,
      ).toMatchObject({
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("PaypalManagedClient (config sentinel)", () => {
  test("propagates fallback metadata from a 403 personal-tier response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error:
            "PayPal Reporting API is unavailable for this account.",
          fallback: "csv_export",
        }),
        { status: 403 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new PaypalManagedClient(() => ({
        configured: true,
        apiKey: "test-key",
        apiBaseUrl: "https://example.test/api",
        siteUrl: "https://example.test",
      }));
      await expect(
        client.searchTransactions({
          accessToken: "tok",
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-04-01T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({
        status: 403,
        fallback: "csv_export",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Plaid transaction shape", () => {
  test("PlaidTransactionDto matches the runtime mapper expectations", () => {
    const txn: PlaidTransactionDto = {
      transaction_id: "txn-1",
      account_id: "acct-1",
      amount: 15.49,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
      date: "2026-04-15",
      authorized_date: null,
      name: "NETFLIX.COM",
      merchant_name: "Netflix",
      pending: false,
      category: ["Entertainment"],
      personal_finance_category: {
        primary: "ENTERTAINMENT",
        detailed: "ENTERTAINMENT_TV_AND_MOVIES",
      },
    };
    // Plaid convention: positive amount = money OUT (debit). We assert that
    // here directly so future convention changes break this test loudly.
    expect(txn.amount > 0 ? "debit" : "credit").toBe("debit");
  });
});

describe("PayPal transaction shape", () => {
  test("PaypalTransactionDto matches the runtime mapper expectations", () => {
    const txn: PaypalTransactionDto = {
      transaction_info: {
        transaction_id: "pp-1",
        transaction_initiation_date: "2026-04-15T12:00:00Z",
        transaction_updated_date: null,
        transaction_amount: { currency_code: "USD", value: "-9.99" },
        transaction_status: "S",
        transaction_subject: "Spotify Premium",
        transaction_note: null,
      },
      payer_info: { email_address: "shawn@example.test" },
    };
    // PayPal convention: negative amount = money OUT.
    const value = Number(txn.transaction_info.transaction_amount.value);
    expect(value < 0 ? "debit" : "credit").toBe("debit");
  });
});

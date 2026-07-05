// Pins the error-surfacing contract of the Google Ads provider: a failed provider
// fetch must PROPAGATE, and must stay distinct from a legitimately-empty result
// (valid credentials, no accessible customers / no metrics rows in range). No
// monetary value is asserted beyond the zeroed empty-metrics shape the source itself
// fixes. Deterministic — global fetch is mocked; no live Google Ads API call.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { googleAdsProvider } = await import("./google");

const originalFetch = globalThis.fetch;
const credentials = { accessToken: "token" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Route mocked fetch by URL: listAccessibleCustomers vs. searchStream (googleAdsRequest).
function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("googleAdsProvider.listAdAccounts error surfacing", () => {
  test("resolves an empty array for valid credentials with no accessible customers", async () => {
    mockFetch((url) => {
      if (url.includes("listAccessibleCustomers")) {
        return jsonResponse({ resourceNames: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(googleAdsProvider.listAdAccounts(credentials)).resolves.toEqual([]);
  });

  test("propagates a transport failure on the accessible-customers fetch", async () => {
    mockFetch((url) => {
      if (url.includes("listAccessibleCustomers")) {
        throw new Error("network down");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(googleAdsProvider.listAdAccounts(credentials)).rejects.toThrow("network down");
  });

  test("propagates a failed per-customer detail fetch instead of silently dropping the account", async () => {
    mockFetch((url) => {
      if (url.includes("listAccessibleCustomers")) {
        return jsonResponse({ resourceNames: ["customers/123"] });
      }
      // searchStream for the customer detail returns a Google Ads API error.
      return jsonResponse(
        { error: { code: 7, message: "USER_PERMISSION_DENIED", status: "PERMISSION_DENIED" } },
        403,
      );
    });

    await expect(googleAdsProvider.listAdAccounts(credentials)).rejects.toThrow(
      "USER_PERMISSION_DENIED",
    );
  });

  test("returns the populated account list when every fetch succeeds", async () => {
    mockFetch((url) => {
      if (url.includes("listAccessibleCustomers")) {
        return jsonResponse({ resourceNames: ["customers/123"] });
      }
      return jsonResponse({
        results: [
          { customer: { resourceName: "customers/123", id: "123", descriptiveName: "Acme" } },
        ],
      });
    });

    await expect(googleAdsProvider.listAdAccounts(credentials)).resolves.toEqual([
      { id: "123", name: "Acme" },
    ]);
  });
});

describe("googleAdsProvider.getCampaignMetrics money-path distinctness", () => {
  // money-path-flagged: the spend arithmetic and the zeroed empty-metrics fallback are
  // left UNCHANGED. This only pins that a failed metrics fetch surfaces and stays distinct
  // from a legitimately-empty (no rows in range) success — without asserting a computed value.
  test("propagates a failed metrics fetch instead of reporting empty spend", async () => {
    mockFetch(() =>
      jsonResponse(
        { error: { code: 3, message: "INVALID_QUERY", status: "INVALID_ARGUMENT" } },
        400,
      ),
    );

    await expect(googleAdsProvider.getCampaignMetrics(credentials, "123/456")).rejects.toThrow(
      "INVALID_QUERY",
    );
  });

  test("reports success with zeroed metrics for a campaign with no rows in range", async () => {
    mockFetch(() => jsonResponse({ results: [] }));

    const result = await googleAdsProvider.getCampaignMetrics(credentials, "123/456");

    expect(result).toEqual({
      success: true,
      metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
    });
  });
});

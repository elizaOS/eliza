/**
 * Pins every managed Plaid/PayPal request path against the routes the Cloud
 * API actually registers. `resolveCloudApiBaseUrl` already ends in `/api/v1`,
 * so the call sites must append `/eliza/...` — appending `/v1/eliza/...`
 * produced `/api/v1/v1/eliza/...`, which 404s on every managed payment call.
 * The whole surface is asserted rather than a sample, because the defect was
 * uniform across all eight and a single spot check would have looked healthy.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PaypalManagedClient,
  PlaidManagedClient,
} from "./managed-payment-clients.ts";

const API_BASE = "https://api.eliza.app/api/v1";

const config = () => ({
  configured: true,
  apiKey: "test-key",
  apiBaseUrl: API_BASE,
  siteUrl: "https://eliza.app",
});

function captureFetchUrl(): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return { urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("managed payment client request paths", () => {
  it("targets the registered Plaid routes without doubling the version segment", async () => {
    const captured = captureFetchUrl();
    const client = new PlaidManagedClient(config);

    await client.createLinkToken().catch(() => undefined);
    await client
      .exchangePublicToken({ publicToken: "public-token" })
      .catch(() => undefined);
    await client
      .syncTransactions({ accessToken: "access-token" })
      .catch(() => undefined);

    expect(captured.urls).toEqual([
      `${API_BASE}/eliza/plaid/link-token`,
      `${API_BASE}/eliza/plaid/exchange`,
      `${API_BASE}/eliza/plaid/sync`,
    ]);
    for (const url of captured.urls) {
      expect(url).not.toContain("/v1/v1/");
    }
  });

  it("targets the registered PayPal routes without doubling the version segment", async () => {
    const captured = captureFetchUrl();
    const client = new PaypalManagedClient(config);

    await client.buildAuthorizeUrl({}).catch(() => undefined);
    await client.exchangeCode({ code: "code" }).catch(() => undefined);
    await client
      .refreshAccessToken({ refreshToken: "refresh" })
      .catch(() => undefined);
    await client.searchTransactions({}).catch(() => undefined);

    for (const url of captured.urls) {
      expect(url.startsWith(`${API_BASE}/eliza/paypal/`)).toBe(true);
      expect(url).not.toContain("/v1/v1/");
    }
    expect(captured.urls).toHaveLength(4);
  });
});

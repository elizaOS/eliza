// @vitest-environment node
//
// Failure-path coverage for the Shopify terminal fetch helper: a malformed body
// on an otherwise-OK response must surface, not be fabricated into null.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchShopifyTuiJson } from "./shopify-view-helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchShopifyTuiJson", () => {
  it("returns null for a 404", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(fetchShopifyTuiJson("/api/shopify/x")).resolves.toBeNull();
  });

  it("throws the error message from a non-OK JSON body", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    await expect(fetchShopifyTuiJson("/api/shopify/x")).rejects.toThrow(
      /rate limited/,
    );
  });

  it("surfaces a malformed body on a 200 instead of fabricating null", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html>proxy error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    await expect(fetchShopifyTuiJson("/api/shopify/x")).rejects.toThrow();
  });
});

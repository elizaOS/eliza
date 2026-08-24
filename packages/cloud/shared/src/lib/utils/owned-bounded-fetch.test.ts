/**
 * Coverage for owned-bounded-fetch.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_REST_RESPONSE_MAX_BYTES, ownedBoundedFetch } from "./owned-bounded-fetch.js";

describe("owned-bounded-fetch", () => {
  it("exposes defaults", () => {
    expect(DEFAULT_REST_RESPONSE_MAX_BYTES).toBe(4 * 1024 * 1024);
  });
  it("fetches small response", async () => {
    const mockFetch = async () =>
      new Response("hello", { status: 200, headers: { "content-length": "5" } });
    // Replace global fetch with mock via passing? ownedBoundedFetch uses global fetch directly, so mock global
    const orig = globalThis.fetch;
    (globalThis as any).fetch = mockFetch;
    const res = await ownedBoundedFetch("https://example.com", undefined, { timeoutMs: 1000 });
    expect(res.status).toBe(200);
    (globalThis as any).fetch = orig;
  });
});

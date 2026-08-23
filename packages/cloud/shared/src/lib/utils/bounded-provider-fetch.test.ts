/**
 * Coverage for bounded-provider-fetch.
 */
import { describe, expect, it } from "vitest";
import { boundedProviderFetch } from "./bounded-provider-fetch.js";

describe("bounded-provider-fetch", () => {
  it("rejects invalid bounds", async () => {
    await expect(
      boundedProviderFetch("https://example.com", undefined, {
        provider: "test",
        timeoutMs: 0,
        maxResponseBytes: 100,
      }),
    ).rejects.toThrow("bounds must be");
    await expect(
      boundedProviderFetch("https://example.com", undefined, {
        provider: "test",
        timeoutMs: 100,
        maxResponseBytes: -1,
      }),
    ).rejects.toThrow("bounds must be");
    await expect(
      boundedProviderFetch("https://example.com", undefined, {
        provider: "test",
        timeoutMs: 1.5,
        maxResponseBytes: 100,
      }),
    ).rejects.toThrow("bounds must be");
  });
  it("respects aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("aborted"));
    await expect(
      boundedProviderFetch(
        "https://example.com",
        { signal: controller.signal },
        { provider: "test", timeoutMs: 1000, maxResponseBytes: 100 },
      ),
    ).rejects.toThrow();
  });
  it("fetches with mock", async () => {
    const fetchImpl = async () =>
      new Response("hello", { status: 200, headers: { "content-length": "5" } });
    const res = await boundedProviderFetch("https://example.com", undefined, {
      provider: "test",
      timeoutMs: 1000,
      maxResponseBytes: 100,
      fetchImpl: fetchImpl as any,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello");
  });
  it("rejects oversized content-length", async () => {
    const fetchImpl = async () =>
      new Response("x".repeat(200), { status: 200, headers: { "content-length": "200" } });
    await expect(
      boundedProviderFetch("https://example.com", undefined, {
        provider: "test",
        timeoutMs: 1000,
        maxResponseBytes: 10,
        fetchImpl: fetchImpl as any,
      }),
    ).rejects.toThrow("byte limit");
  });
});

// Pins the bounded-SSRF contract of seoFetch: every SEO provider hop goes
// through the file's SSRF-safe wrapper AND fails closed at the hop timeout
// (a caller-provided abort signal wins).
import { describe, expect, mock, test } from "bun:test";

let seenInit: RequestInit | undefined;
let seenUrl: string | undefined;

mock.module("../security/safe-fetch", () => ({
  safeFetch: (rawUrl: string, init: RequestInit = {}) => {
    seenUrl = rawUrl;
    seenInit = init;
    return Promise.resolve(new Response("{}", { status: 200 }));
  },
}));

const { seoFetch } = await import("./seo");

describe("seoFetch — SSRF-safe hops that fail closed and keep caller signals", () => {
  test("routes through safeFetch with a default hop timeout signal", async () => {
    await seoFetch("https://api.dataforseo.com/v3/…");
    expect(seenUrl).toBe("https://api.dataforseo.com/v3/…");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("preserves a caller-provided abort signal instead of adding a timeout", async () => {
    const controller = new AbortController();
    await seoFetch("https://api.indexnow.org/indexnow", {
      signal: controller.signal,
    });
    expect(seenInit?.signal).toBe(controller.signal);
  });
});

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

  test("composes a caller-provided abort signal with the hop deadline", async () => {
    const controller = new AbortController();
    await seoFetch("https://api.indexnow.org/indexnow", {
      signal: controller.signal,
    });
    // The wrapper owns the deadline, so safeFetch receives a composition of the
    // caller signal and that deadline — never the caller's object verbatim.
    // Asserting identity here would pin the behavior that lets a caller signal
    // which never fires silently defeat the bound.
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
    expect(seenInit?.signal).not.toBe(controller.signal);
  });

  test("aborts when the caller cancels", async () => {
    const controller = new AbortController();
    await seoFetch("https://api.indexnow.org/indexnow", {
      signal: controller.signal,
    });
    const composed = seenInit?.signal;
    expect(composed?.aborted).toBe(false);
    controller.abort();
    expect(composed?.aborted).toBe(true);
  });
});

// Pins the bounded-delivery contract of the agent → PayPal connector: every
// REST hop fails closed at the connector timeout instead of pinning the
// worker forever, and a caller-provided abort signal wins.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { paypalFetch } from "./agent-paypal-connector";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("paypalFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung PayPal API hop at the timeout", async () => {
    // An API that never settles on its own: the only way out is the caller's
    // AbortSignal firing (the 30s default bounds OAuth / identity / reports).
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

    const start = Date.now();
    await expect(
      paypalFetch("https://api-m.paypal.com/v1/oauth2/token", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("preserves a caller-provided abort signal", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const controller = new AbortController();
    await paypalFetch("https://api-m.paypal.com/v1/oauth2/token", {
      signal: controller.signal,
    });
    expect(seen).toBe(controller.signal);
  });
});

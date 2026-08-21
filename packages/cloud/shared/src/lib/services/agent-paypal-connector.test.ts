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

  // Asserting identity here is what kept the hop weak: `toBe(controller.signal)`
  // is only true when the caller's signal REPLACED the deadline, which is the
  // bug. The property worth pinning is that the caller's abort still
  // propagates through the composed signal.
  test("composes a caller-provided abort signal with the hop deadline", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const controller = new AbortController();
    await paypalFetch("https://api-m.paypal.com/v1/oauth2/token", {
      signal: controller.signal,
    });

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen).not.toBe(controller.signal);
    expect(seen?.aborted).toBe(false);
  });

  test("propagates a caller abort through the composed signal", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const controller = new AbortController();
    await paypalFetch("https://api-m.paypal.com/v1/oauth2/token", {
      signal: controller.signal,
    });
    controller.abort();

    expect(seen?.aborted).toBe(true);
  });
});

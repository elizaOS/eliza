// Pins the bounded-delivery contract of the cloud alert senders: every
// webhook / API hop fails closed at the alert timeout instead of pinning the
// alert worker forever, and a caller-provided abort signal wins.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { alertFetch } from "./alerts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("alertFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung webhook hop at the timeout", async () => {
    // A webhook that never settles on its own: the only way out is the
    // caller's AbortSignal firing (the 15s default bounds every sender).
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

    const start = Date.now();
    await expect(alertFetch("https://hooks.example/alert", undefined, 100)).rejects.toThrow(
      /aborted/i,
    );
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("preserves a caller-provided abort signal", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const controller = new AbortController();
    await alertFetch("https://hooks.example/alert", {
      signal: controller.signal,
    });
    expect(seen).toBe(controller.signal);
  });
});

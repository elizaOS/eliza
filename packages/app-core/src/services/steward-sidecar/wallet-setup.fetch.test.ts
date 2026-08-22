/**
 * Pins the bounded Steward sidecar contract: every API hop fails closed at the
 * hop timeout, composing a caller signal with the deadline so either one
 * aborts the request. The harness stubs `globalThis.fetch` with a hung or
 * immediate responder and restores the original between tests; the module
 * under test is the real `stewardFetch`.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("stewardFetch — bounded Steward hops fail closed and compose caller signals", () => {
  test("aborts a hung Steward hop at the configured timeout", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    ) as unknown as typeof fetch;

    const { stewardFetch } = await import("./wallet-setup");
    const start = Date.now();
    await expect(
      stewardFetch("http://127.0.0.1:1/agents/x/token", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("times out a hung hop even when a non-aborted caller signal is present", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    ) as unknown as typeof fetch;

    const { stewardFetch } = await import("./wallet-setup");
    const controller = new AbortController();
    const start = Date.now();
    await expect(
      stewardFetch(
        "http://127.0.0.1:1/agents/x/token",
        {
          signal: controller.signal,
        },
        100,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(controller.signal.aborted).toBe(false);
  });

  test("preserves caller cancellation (composed)", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          seen = init?.signal ?? undefined;
          return new Response("{}", { status: 200 });
        },
      ) as unknown as typeof fetch;

    const { stewardFetch } = await import("./wallet-setup");
    const controller = new AbortController();
    await stewardFetch("http://127.0.0.1:1/agents/x/token", {
      signal: controller.signal,
    });
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });
});

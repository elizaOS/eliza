/**
 * Verifies scenario-seed mock fetches fail closed at the hop timeout and
 * compose caller cancellation without reaching a real network service.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("seedFetch — bounded seed hops fail closed and compose caller signals", () => {
  test("aborts a hung seed hop at the configured timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
          }),
      ),
    );

    const { seedFetch } = await import("./seeds");
    const start = Date.now();
    await expect(
      seedFetch("http://127.0.0.1:1/__mock/requests", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("times out a hung hop even when a non-aborted caller signal is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
          }),
      ),
    );

    const { seedFetch } = await import("./seeds");
    const controller = new AbortController();
    const start = Date.now();
    await expect(
      seedFetch(
        "http://127.0.0.1:1/__mock/requests",
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
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async (_input: RequestInfo | URL, init?: RequestInit) => {
            seen = init?.signal ?? undefined;
            return new Response("{}", { status: 200 });
          },
        ),
    );

    const { seedFetch } = await import("./seeds");
    const controller = new AbortController();
    await seedFetch("http://127.0.0.1:1/__mock/requests", {
      signal: controller.signal,
    });
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });
});

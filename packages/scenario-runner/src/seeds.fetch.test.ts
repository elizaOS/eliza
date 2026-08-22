// Pins the bounded seed-hop contract: every scenario-seed mock fetch fails
// closed at the hop timeout instead of pinning the executor, and a
// caller-provided abort signal is composed with the timeout (either wins).
import { describe, expect, test, vi } from "vitest";

describe("seedFetch — bounded seed hops fail closed and compose caller signals", () => {
  test("aborts a hung seed hop at the configured timeout", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    ) as typeof fetch;

    const { seedFetch } = await import("./seeds");
    const start = Date.now();
    await expect(
      seedFetch("http://127.0.0.1:1/__mock/requests", undefined, 100),
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
    ) as typeof fetch;

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
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          seen = init?.signal;
          return new Response("{}", { status: 200 });
        },
      ) as typeof fetch;

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

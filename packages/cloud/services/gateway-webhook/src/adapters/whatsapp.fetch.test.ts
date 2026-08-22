// Pins the bounded WhatsApp adapter contract: every Cloud API hop fails
// closed at the hop timeout, composing a caller signal with the deadline.
import { describe, expect, test, vi } from "vitest";

describe("whatsappFetch — bounded WhatsApp hops fail closed and compose caller signals", () => {
  test("aborts a hung WhatsApp hop at the configured timeout", async () => {
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

    const { whatsappFetch } = await import("./whatsapp");
    const start = Date.now();
    await expect(
      whatsappFetch(
        "https://graph.facebook.com/v21.0/me/messages",
        undefined,
        100,
      ),
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

    const { whatsappFetch } = await import("./whatsapp");
    const controller = new AbortController();
    const start = Date.now();
    await expect(
      whatsappFetch(
        "https://graph.facebook.com/v21.0/me/messages",
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

    const { whatsappFetch } = await import("./whatsapp");
    const controller = new AbortController();
    await whatsappFetch("https://graph.facebook.com/v21.0/me/messages", {
      signal: controller.signal,
    });
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });
});

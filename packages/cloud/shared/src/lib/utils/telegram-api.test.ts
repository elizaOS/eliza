// Pins the bounded Telegram Bot API contract: every hop fails closed at the
// API timeout instead of pinning the caller forever, and a caller-provided
// abort signal wins.
import { describe, expect, mock, test } from "bun:test";

describe("telegramApiFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung Telegram API hop at the configured timeout", async () => {
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

    const { telegramApiFetch } = await import("./telegram-api");
    const start = Date.now();
    await expect(
      telegramApiFetch("https://api.telegram.org/bot1/getMe", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("preserves a caller-provided abort signal", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { telegramApiFetch } = await import("./telegram-api");
    const controller = new AbortController();
    await telegramApiFetch("https://api.telegram.org/bot1/getMe", {
      signal: controller.signal,
    });
    expect(seen).toBe(controller.signal);
  });
});

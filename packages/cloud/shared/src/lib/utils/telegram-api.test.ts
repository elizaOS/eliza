/**
 * Exercises the bounded Telegram Bot API transport with deterministic fetch
 * doubles, including cancellation, endpoint, body, and response failures.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { telegramApiFetch, telegramBotApiGet, telegramBotApiRequest } from "./telegram-api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function hungFetch() {
  return mock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  ) as typeof fetch;
}

describe("telegramApiFetch", () => {
  test("aborts a hung Telegram hop at the configured timeout", async () => {
    globalThis.fetch = hungFetch();
    await expect(
      telegramApiFetch("https://api.telegram.org/bot1/getMe", undefined, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("keeps the deadline effective with a non-aborted caller signal", async () => {
    globalThis.fetch = hungFetch();
    const caller = new AbortController();
    await expect(
      telegramApiFetch("https://api.telegram.org/bot1/getMe", { signal: caller.signal }, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(caller.signal.aborted).toBe(false);
  });

  test("lets caller cancellation abort ahead of the deadline", async () => {
    globalThis.fetch = hungFetch();
    const caller = new AbortController();
    const pending = telegramApiFetch(
      "https://api.telegram.org/bot1/getMe",
      { signal: caller.signal },
      1_000,
    );
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("rejects non-Telegram endpoints and forces redirect errors", async () => {
    await expect(
      telegramApiFetch("https://example.com/bot1/getMe", undefined, 100),
    ).rejects.toMatchObject({ code: "TELEGRAM_API_URL_FORBIDDEN" });

    let seen: RequestInit | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return Response.json({ ok: true, result: {} });
    }) as typeof fetch;
    const response = await telegramApiFetch("https://api.telegram.org/bot1/getMe", undefined, 100);
    await response.body?.cancel();
    expect(seen?.redirect).toBe("error");
    expect(seen?.signal).toBeDefined();
  });
});

describe("Telegram Bot API request boundaries", () => {
  test("returns a successful bounded POST result", async () => {
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body).length).toBeLessThan(1_000_000);
      return Response.json({ ok: true, result: { id: 7 } });
    }) as typeof fetch;
    await expect(
      telegramBotApiRequest<{ id: number }>("1:token", "sendMessage", { text: "hello" }),
    ).resolves.toEqual({ id: 7 });
  });

  test("rejects cyclic and oversized request payloads before fetch", async () => {
    const fetchMock = mock(async () => Response.json({ ok: true, result: {} }));
    globalThis.fetch = fetchMock as typeof fetch;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(telegramBotApiRequest("1:token", "sendMessage", cyclic)).rejects.toMatchObject({
      code: "TELEGRAM_API_PARAMS_INVALID",
    });
    await expect(
      telegramBotApiRequest("1:token", "sendMessage", { text: "x".repeat(1_000_001) }),
    ).rejects.toMatchObject({ code: "TELEGRAM_API_REQUEST_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("preserves Telegram error descriptions for non-success responses", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ ok: false, description: "Bad Request", error_code: 400 }, { status: 400 }),
    ) as typeof fetch;
    await expect(telegramBotApiGet("1:token", "getMe")).rejects.toMatchObject({
      code: "TELEGRAM_API_REQUEST_FAILED",
      message: "Bad Request",
    });
  });

  test("rejects a malformed response envelope", async () => {
    globalThis.fetch = mock(async () => Response.json(null)) as typeof fetch;
    await expect(telegramBotApiGet("1:token", "getMe")).rejects.toMatchObject({
      code: "TELEGRAM_API_RESPONSE_INVALID",
    });
  });

  test("rejects oversized response bodies and cancels the stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_001));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = mock(async () => new Response(stream)) as typeof fetch;
    await expect(telegramBotApiGet("1:token", "getMe")).rejects.toMatchObject({
      code: "TELEGRAM_API_RESPONSE_TOO_LARGE",
    });
    expect(cancelled).toBe(true);
  });
});

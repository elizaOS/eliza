/**
 * Exercises the bounded Telegram Bot API transport with deterministic fetch
 * doubles, including cancellation, endpoint, body, and response failures.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { telegramBotApiGet, telegramBotApiRequest } from "./telegram-api";

const realFetch = globalThis.fetch;
const realClearTimeout = globalThis.clearTimeout;

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.clearTimeout = realClearTimeout;
});

function hungFetch() {
  return mock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  ) as typeof fetch;
}

describe("bounded Telegram request lifecycle", () => {
  test("aborts a hung Telegram hop at the configured timeout", async () => {
    globalThis.fetch = hungFetch();
    await expect(
      telegramBotApiGet("1:token", "getMe", undefined, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("keeps the deadline effective with a non-aborted caller signal", async () => {
    globalThis.fetch = hungFetch();
    const caller = new AbortController();
    await expect(
      telegramBotApiGet("1:token", "getMe", undefined, {
        signal: caller.signal,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(caller.signal.aborted).toBe(false);
  });

  test("lets caller cancellation abort ahead of the deadline", async () => {
    globalThis.fetch = hungFetch();
    const caller = new AbortController();
    const pending = telegramBotApiGet("1:token", "getMe", undefined, {
      signal: caller.signal,
      timeoutMs: 1_000,
    });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("forces redirect errors on the derived canonical Telegram endpoint", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return Response.json({ ok: true, result: { id: 1 } });
    }) as typeof fetch;
    await expect(
      telegramBotApiGet("1:token", "getMe", undefined, { timeoutMs: 100 }),
    ).resolves.toEqual({ id: 1 });
    expect(seen?.redirect).toBe("error");
    expect(seen?.signal).toBeDefined();
  });

  test("aborts a stalled response body and clears its owned deadline", async () => {
    let bodyAborted = false;
    let clearedTimers = 0;
    globalThis.clearTimeout = mock((timer: ReturnType<typeof setTimeout>) => {
      clearedTimers += 1;
      realClearTimeout(timer);
    }) as typeof clearTimeout;

    const fetchDouble = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => {
              bodyAborted = true;
              controller.error(signal.reason);
            });
          },
        }),
      );
    }) as typeof fetch;
    globalThis.fetch = fetchDouble;

    try {
      await expect(
        telegramBotApiGet("1:token", "getMe", undefined, { timeoutMs: 25 }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      globalThis.fetch = realFetch;
      globalThis.clearTimeout = realClearTimeout;
    }

    expect(bodyAborted).toBe(true);
    expect(clearedTimers).toBe(1);
    expect(globalThis.fetch).toBe(realFetch);
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

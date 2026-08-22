/**
 * Message-router Twilio hop deadline coverage.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { MESSAGE_ROUTER_TWILIO_TIMEOUT_MS, messageRouterTwilioFetch } from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("messageRouterTwilioFetch deadline", () => {
  test("exports 30s deadline", () => {
    expect(MESSAGE_ROUTER_TWILIO_TIMEOUT_MS).toBe(30_000);
  });

  test("aborts a hung fetch at owned deadline", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const promise = messageRouterTwilioFetch(
      "https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json",
      { method: "POST" },
      15,
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("composes caller signal — non-aborted caller cannot disable deadline", async () => {
    const caller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const promise = messageRouterTwilioFetch(
      "https://api.twilio.com/test",
      { method: "POST", signal: caller.signal },
      15,
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("caller abort wins before deadline", async () => {
    const caller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const promise = messageRouterTwilioFetch(
      "https://api.twilio.com/test",
      { method: "POST", signal: caller.signal },
      1000,
    );
    caller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  test("deadline rejects when fetch ignores its signal", async () => {
    globalThis.fetch = mock(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    await expect(
      messageRouterTwilioFetch("https://api.twilio.com/test", undefined, 15),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("deadline covers a Twilio body that never completes", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          }),
        ),
    ) as unknown as typeof fetch;
    await expect(
      messageRouterTwilioFetch("https://api.twilio.com/test", undefined, 15),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("rejects an invalid timeout before dispatch", async () => {
    const fetchMock = mock(async () => new Response());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      messageRouterTwilioFetch("https://api.twilio.com/test", undefined, 0),
    ).rejects.toMatchObject({
      code: "INVALID_MESSAGE_ROUTER_TWILIO_TIMEOUT",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

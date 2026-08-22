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
});

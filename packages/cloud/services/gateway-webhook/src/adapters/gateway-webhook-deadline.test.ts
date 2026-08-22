/**
 * Gateway webhook deadline coverage for live provider hops.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  BLOOIO_GATEWAY_REQUEST_TIMEOUT_MS,
  blooioAdapter,
  blooioGatewayFetch,
} from "./blooio";
import {
  TWILIO_GATEWAY_REQUEST_TIMEOUT_MS,
  twilioAdapter,
  twilioGatewayFetch,
} from "./twilio";
import type { ChatEvent, WebhookConfig } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("twilioGatewayFetch deadline", () => {
  test("owns a 30s deadline and aborts a hung fetch", async () => {
    expect(TWILIO_GATEWAY_REQUEST_TIMEOUT_MS).toBe(30_000);

    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const promise = twilioGatewayFetch(
      "https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json",
      { method: "POST" },
      15,
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("composes caller signal via AbortSignal.any — caller abort wins", async () => {
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

    const promise = twilioGatewayFetch(
      "https://api.twilio.com/test",
      { method: "POST", signal: caller.signal },
      1000,
    );
    caller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("non-aborted caller signal cannot disable owned deadline", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const caller = new AbortController();
    const promise = twilioGatewayFetch(
      "https://api.twilio.com/test",
      { method: "POST", signal: caller.signal },
      15,
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("sendReply is bounded and restores fetch", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return Response.json({ sid: "SM_ok" });
    }) as unknown as typeof fetch;

    const config: WebhookConfig = {
      accountSid: "AC_test",
      authToken: "secret",
      phoneNumber: "+15550000000",
    };
    const event: ChatEvent = {
      platform: "twilio",
      messageId: "SM_ok",
      chatId: "+15551234567",
      senderId: "+15551234567",
      text: "hello",
      rawPayload: {},
    };

    await twilioAdapter.sendReply(config, event, "hello");
    expect(capturedSignal).toBeDefined();
    expect(globalThis.fetch).not.toBe(originalFetch);
    // afterEach restores
  });
});

describe("blooioGatewayFetch deadline", () => {
  test("owns a 30s deadline and aborts a hung fetch", async () => {
    expect(BLOOIO_GATEWAY_REQUEST_TIMEOUT_MS).toBe(30_000);

    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const promise = blooioGatewayFetch(
      "https://api.blooio.com/v4/messages",
      { method: "POST" },
      15,
    );
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("composes caller signal — caller abort wins", async () => {
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

    const promise = blooioGatewayFetch(
      "https://api.blooio.com/v4/messages",
      { method: "POST", signal: caller.signal },
      1000,
    );
    caller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  test("sendReply uses bounded fetch and typing indicator is bounded", async () => {
    let signals: AbortSignal[] = [];
    globalThis.fetch = mock(async (_url, init) => {
      if (init?.signal) signals.push(init.signal as AbortSignal);
      return Response.json({ id: "blooio_123" });
    }) as unknown as typeof fetch;

    const config: WebhookConfig = {
      apiKey: "blooio-key",
      blooioWebhookSecret: "secret",
      fromNumber: "+15550000000",
    };
    const event: ChatEvent = {
      platform: "blooio",
      messageId: "mid_bounded",
      chatId: "+15551234567",
      senderId: "+15551234567",
      text: "hello",
      rawPayload: {},
    };

    await blooioAdapter.sendReply(config, event, "hello");
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].aborted).toBe(false);

    signals = [];
    globalThis.fetch = mock(async (_url, init) => {
      if (init?.signal) signals.push(init.signal as AbortSignal);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await blooioAdapter.sendTypingIndicator(config, event);
    expect(signals.length).toBe(1);
  });
});

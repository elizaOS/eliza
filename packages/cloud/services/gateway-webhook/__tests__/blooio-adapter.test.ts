/** Focused Blooio send timing, privacy, and original-failure contracts. */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { blooioAdapter } from "../src/adapters/blooio";
import type { ChatEvent, WebhookConfig } from "../src/adapters/types";
import { logger } from "../src/logger";

function makeConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return { apiKey: "bl_live_test", fromNumber: "+15550001111", ...overrides } as WebhookConfig;
}

const originalFetch = globalThis.fetch;
const timingSpies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const spy of timingSpies.splice(0)) spy.mockRestore();
});

describe("blooio send timing", () => {
  const chatEvent: ChatEvent = {
    platform: "blooio",
    messageId: "msg_abc123",
    chatId: "+15551234567",
    senderId: "+15551234567",
    text: "hey eliza",
    rawPayload: {},
  };

  test("separates provider headers, bounded body and receipt work without logging private data", async () => {
    let clock = 100;
    timingSpies.push(spyOn(performance, "now").mockImplementation(() => clock));
    const output = spyOn(console, "log").mockImplementation(() => {});
    timingSpies.push(output);
    const originalText = Response.prototype.text;
    timingSpies.push(
      spyOn(Response.prototype, "text").mockImplementation(async function (
        this: Response,
      ) {
        const value = await originalText.call(this);
        clock = 149;
        return value;
      }),
    );
    globalThis.fetch = (async () => {
      clock = 111;
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              clock = 137;
              controller.enqueue(
                new TextEncoder().encode('{"id":"private-response-id"}'),
              );
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    }) as typeof fetch;
    const traceId = "1111111111114111a111111111111111";
    await expect(
      blooioAdapter.sendReplyWithReceipt?.(
        makeConfig({ apiKey: "private-key" }),
        { ...chatEvent, traceId },
        "private-message-text",
      ),
    ).resolves.toEqual({ providerMessageIds: ["private-response-id"] });
    expect(output).toHaveBeenCalledTimes(1);
    const encoded = String(output.mock.calls[0][0]);
    expect(JSON.parse(encoded)).toMatchObject({
      message: "Blooio send timing",
      messageId: chatEvent.messageId,
      traceId,
      headersMs: 11,
      bodyMs: 26,
      receiptMs: 12,
      outcome: "accepted",
    });
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(
      300,
    );
    for (const privateValue of [
      "private-key",
      "private-message-text",
      "private-response-id",
      chatEvent.senderId,
    ]) {
      expect(encoded).not.toContain(privateValue);
    }
  });

  test("retains the selected body failure and logs only the attempted phase", async () => {
    let clock = 100;
    timingSpies.push(spyOn(performance, "now").mockImplementation(() => clock));
    const output = spyOn(console, "log").mockImplementation(() => {});
    timingSpies.push(output);
    const failure = new DOMException("private-failure-detail", "TimeoutError");
    globalThis.fetch = (async () => {
      clock = 111;
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              clock = 137;
              controller.error(failure);
            },
          },
          { highWaterMark: 0 },
        ),
      );
    }) as typeof fetch;
    await expect(
      blooioAdapter.sendReply(makeConfig(), chatEvent, "private-text"),
    ).rejects.toBe(failure);
    expect(output).toHaveBeenCalledTimes(1);
    const encoded = String(output.mock.calls[0][0]);
    expect(JSON.parse(encoded)).toMatchObject({
      headersMs: 11,
      bodyMs: 26,
      receiptMs: null,
      outcome: "body_failed",
    });
    expect(encoded).not.toContain("private-failure-detail");
  });

  test("timing logger failure cannot replace the provider failure", async () => {
    const failure = new Error("provider failed");
    timingSpies.push(
      spyOn(logger, "info").mockImplementation(() => {
        throw new Error("logger failed");
      }),
    );
    globalThis.fetch = (async () => {
      throw failure;
    }) as typeof fetch;
    await expect(
      blooioAdapter.sendReply(makeConfig(), chatEvent, "hello"),
    ).rejects.toBe(failure);
  });

});

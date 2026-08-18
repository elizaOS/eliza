/**
 * Preserve Android SMS gateway error details with fetch timeout.
 * The helper must keep the deadline active through response.json(),
 * return non-2xx bodies to the UI boundary with details, and still
 * succeed on valid replies.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../agent-surface", () => ({ useAgentElement: () => undefined }));
vi.mock("../../bridge/plugin-bridge", () => ({ getPlugins: () => ({}) }));
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../ui/button", () => ({ Button: () => null }));
vi.mock("../ui/input", () => ({ Input: () => null }));
vi.mock("../ui/textarea", () => ({ Textarea: () => null }));
vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: () => null,
}));

import {
  ANDROID_SMS_GATEWAY_FETCH_TIMEOUT_MS,
  forwardAndroidSmsGateway,
  type IncomingSmsContext,
} from "./ElizaOsAppsView";

const incoming: IncomingSmsContext = {
  sender: "+14155550100",
  body: "hello",
  timestamp: Date.now(),
  messageId: "msg-1",
};

function stallOnSignal(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected abort signal");
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })) as typeof fetch;
}

describe("forwardAndroidSmsGateway", () => {
  it("keeps the deadline active for a stalled fetch", async () => {
    const signal = new AbortController().signal;
    await expect(
      forwardAndroidSmsGateway(incoming, signal, stallOnSignal(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("keeps the deadline active while the response body is consumed", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            // do not enqueue or close, just wait for abort to error the stream
            signal?.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true },
            );
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const signal = new AbortController().signal;
    await expect(
      forwardAndroidSmsGateway(incoming, signal, fetchImpl, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("preserves a completed provider error response body in the thrown error", async () => {
    const errorBody = { error: "quota exceeded", code: 429 };
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(errorBody), {
        status: 500,
        headers: { "content-type": "application/json" },
      });

    const signal = new AbortController().signal;
    await expect(
      forwardAndroidSmsGateway(incoming, signal, fetchImpl, 10_000),
    ).rejects.toThrow(
      `Cloud gateway failed (500): ${JSON.stringify(errorBody)}`,
    );
  });

  it("returns a successfully parsed reply on 200", async () => {
    const reply = { replyText: "hi from cloud", success: true };
    const fetchImpl: typeof fetch = async () =>
      Response.json(reply, { status: 200 });

    const signal = new AbortController().signal;
    await expect(
      forwardAndroidSmsGateway(incoming, signal, fetchImpl, 10_000),
    ).resolves.toEqual(reply);
  });

  it("throws unparseable for an ok response with invalid json shape", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(null), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const signal = new AbortController().signal;
    await expect(
      forwardAndroidSmsGateway(incoming, signal, fetchImpl, 10_000),
    ).rejects.toThrow("Cloud gateway returned an unparseable reply");
  });

  it("uses the exported timeout constant", () => {
    expect(ANDROID_SMS_GATEWAY_FETCH_TIMEOUT_MS).toBe(15_000);
  });
});

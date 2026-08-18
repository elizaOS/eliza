/**
 * Android SMS gateway forwarding preserves the provider's structured error
 * detail and stays bounded by the caller abort/deadline signal. The harness is
 * deterministic: it stubs globalThis.fetch with synthetic Response bodies and
 * drives the abort path with an already-aborted signal, so no real network or
 * wall-clock timeout is involved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { toWellFormedUnicode } from "@elizaos/core";
import {
  ANDROID_SMS_GATEWAY_ERROR_DETAIL_MAX_LENGTH,
  forwardAndroidSmsGateway,
  readAndroidSmsGatewayErrorDetail,
} from "./ElizaOsAppsView";

const incoming = {
  sender: "+14155550123",
  body: "hello eliza",
  timestamp: 1_700_000_000_000,
  messageId: "msg-1",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("forwardAndroidSmsGateway", () => {
  it("stays bounded by the caller abort signal instead of hanging", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    controller.abort(new DOMException("superseded", "AbortError"));

    await expect(
      forwardAndroidSmsGateway(incoming, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("aborts while a completed error response body is still streaming", async () => {
    const controller = new AbortController();
    let bodyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(new TextEncoder().encode("partial"));
              bodyStarted?.();
              signal?.addEventListener(
                "abort",
                () => streamController.error(signal.reason),
                { once: true },
              );
            },
          }),
          { status: 502 },
        ),
      );
    });

    const pending = forwardAndroidSmsGateway(incoming, controller.signal);
    await started;
    controller.abort(new DOMException("superseded", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces the provider's structured diagnostic detail on a non-2xx reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ reason: "recipient blocked by carrier policy" }),
        { status: 502, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      forwardAndroidSmsGateway(incoming, new AbortController().signal),
    ).rejects.toThrow(
      "Cloud gateway failed (502): recipient blocked by carrier policy",
    );
  });

  it("falls back to the bare status when the error body is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 500 }),
    );

    await expect(
      forwardAndroidSmsGateway(incoming, new AbortController().signal),
    ).rejects.toThrow(/^Cloud gateway failed \(500\)$/);
  });

  it("surfaces an unparseable non-JSON error body verbatim", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream 503 from bluebubbles", { status: 503 }),
    );

    await expect(
      forwardAndroidSmsGateway(incoming, new AbortController().signal),
    ).rejects.toThrow(
      "Cloud gateway failed (503): upstream 503 from bluebubbles",
    );
  });

  it("parses a successful 2xx reply into the gateway reply shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ handled: true, replyText: "on my way" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const reply = await forwardAndroidSmsGateway(
      incoming,
      new AbortController().signal,
    );
    expect(reply).toEqual({ handled: true, replyText: "on my way" });
  });
});

describe("readAndroidSmsGatewayErrorDetail", () => {
  it("prefers the reason field over other diagnostic keys", async () => {
    const detail = await readAndroidSmsGatewayErrorDetail(
      new Response(JSON.stringify({ reason: "quota exceeded", error: "x" }), {
        status: 429,
      }),
    );
    expect(detail).toBe("quota exceeded");
  });

  it("returns an empty string when the body is whitespace only", async () => {
    const detail = await readAndroidSmsGatewayErrorDetail(
      new Response("   ", { status: 500 }),
    );
    expect(detail).toBe("");
  });

  it("bounds an oversized structured diagnostic field", async () => {
    const detail = await readAndroidSmsGatewayErrorDetail(
      new Response(JSON.stringify({ reason: "x".repeat(2_000) }), {
        status: 502,
      }),
    );
    expect(detail.length).toBe(ANDROID_SMS_GATEWAY_ERROR_DETAIL_MAX_LENGTH);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("bounds oversized raw astral text without creating a lone surrogate", async () => {
    const detail = await readAndroidSmsGatewayErrorDetail(
      new Response("🙂".repeat(3_000), { status: 502 }),
    );
    expect(detail.length).toBeLessThanOrEqual(
      ANDROID_SMS_GATEWAY_ERROR_DETAIL_MAX_LENGTH,
    );
    expect(detail.endsWith("…")).toBe(true);
    expect(toWellFormedUnicode(detail)).toBe(detail);
  });
});

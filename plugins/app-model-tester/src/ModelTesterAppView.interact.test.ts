/** Covers the TUI `interact()` capability handler — status fetch, run-* capability-to-test mapping, param coercion, and error propagation — against a stubbed fetch (no live server). */

import { afterEach, describe, expect, it, vi } from "vitest";
import { interact } from "./ModelTesterAppView.interact.js";

const DEFAULT_PROMPT =
  "Say exactly one short sentence about the Eliza-1 model tester working.";

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function installFetch(
  responder: (call: RecordedCall) => {
    ok?: boolean;
    status?: number;
    statusText?: string;
    text: string;
  },
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : undefined;
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? "GET",
        body: bodyText
          ? (JSON.parse(bodyText) as Record<string, unknown>)
          : null,
      };
      calls.push(call);
      const r = responder(call);
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        statusText: r.statusText ?? "OK",
        text: async () => r.text,
      } as unknown as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("interact get-status", () => {
  it("fetches the status endpoint and parses JSON", async () => {
    const calls = installFetch(() => ({
      text: JSON.stringify({ tests: [{ id: "vad", available: true }] }),
    }));

    const result = await interact("get-status");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/model-tester/status");
    expect(calls[0].method).toBe("GET");
    expect(result).toEqual({ tests: [{ id: "vad", available: true }] });
  });
});

describe("interact run-* capability mapping", () => {
  const cases: Array<{ capability: string; test: string }> = [
    { capability: "run-text-small", test: "text-small" },
    { capability: "run-transcription", test: "transcription" },
    { capability: "run-vision", test: "image-description" },
    { capability: "run-vad", test: "vad" },
  ];

  for (const { capability, test } of cases) {
    it(`${capability} -> POST /run {test:'${test}'} with the default prompt`, async () => {
      const calls = installFetch(() => ({
        text: JSON.stringify({ ok: true, test }),
      }));

      const result = await interact(capability);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("/api/model-tester/run");
      expect(calls[0].method).toBe("POST");
      expect(calls[0].body?.test).toBe(test);
      expect(calls[0].body?.prompt).toBe(DEFAULT_PROMPT);
      expect(result).toEqual({ ok: true, test });
    });
  }
});

describe("interact param coercion", () => {
  it("forwards correctly-typed params and drops mistyped ones", async () => {
    const calls = installFetch(() => ({ text: JSON.stringify({ ok: true }) }));

    await interact("run-transcription", {
      prompt: "custom prompt",
      imageDataUrl: "data:image/png;base64,AAAA",
      audioDataUrl: "data:audio/wav;base64,BBBB",
      pcmSamples: [0.1, -0.2],
      sampleRateHz: 16_000,
    });

    const body = calls[0].body ?? {};
    expect(body.prompt).toBe("custom prompt");
    expect(body.imageDataUrl).toBe("data:image/png;base64,AAAA");
    expect(body.audioDataUrl).toBe("data:audio/wav;base64,BBBB");
    expect(body.pcmSamples).toEqual([0.1, -0.2]);
    expect(body.sampleRateHz).toBe(16_000);
  });

  it("drops a non-array pcmSamples and a non-number sampleRateHz", async () => {
    const calls = installFetch(() => ({ text: JSON.stringify({ ok: true }) }));

    await interact("run-vad", {
      prompt: 42, // not a string -> falls back to DEFAULT_PROMPT
      imageDataUrl: 7, // not a string -> undefined
      pcmSamples: "not-an-array",
      sampleRateHz: "16000",
    });

    const body = calls[0].body ?? {};
    // JSON.stringify drops `undefined`-valued keys, so absent === dropped.
    expect(body.prompt).toBe(DEFAULT_PROMPT);
    expect("imageDataUrl" in body).toBe(false);
    expect("pcmSamples" in body).toBe(false);
    expect("sampleRateHz" in body).toBe(false);
  });
});

describe("interact error handling", () => {
  it("throws with the response text when the response is not ok", async () => {
    installFetch(() => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: "boom: model unavailable",
    }));

    await expect(interact("get-status")).rejects.toThrow(
      "boom: model unavailable",
    );
  });

  it("throws the exact 'does not support' message for an unknown capability", async () => {
    installFetch(() => ({ text: "{}" }));

    await expect(interact("run-nonexistent")).rejects.toThrow(
      'Model Tester TUI does not support "run-nonexistent".',
    );
  });
});

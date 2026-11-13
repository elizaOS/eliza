import { expect, test } from "bun:test";
import { synthesizeCartesiaBytes } from "./cartesia-synthesis";

test("Cartesia REST synthesis uses the same Sonic 3.6 default and preserves voice and MP3 format", async () => {
  const voiceId = "47c38ca4-5f35-497b-b1a3-415245fb35e1";
  let sent: Record<string, unknown> | undefined;
  const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  const result = await synthesizeCartesiaBytes({
    apiKey: "synthetic-provider-key",
    voiceId,
    text: "Hello.",
    fetch: (async (url, init) => {
      expect(url).toBe("https://api.cartesia.ai/tts/bytes");
      sent = JSON.parse(String(init?.body));
      return new Response(audio, {
        headers: { "Content-Type": "audio/mpeg" },
      });
    }) as typeof fetch,
  });
  expect(sent).toEqual({
    model_id: "sonic-3.6",
    transcript: "Hello.",
    voice: { mode: "id", id: voiceId },
    output_format: {
      container: "mp3",
      sample_rate: 44_100,
      bit_rate: 128_000,
    },
  });
  expect(result.modelId).toBe("sonic-3.6");
  expect(result.provider).toBe("cartesia");
  expect(await new Response(result.body).bytes()).toEqual(audio);
});

import type { CartesiaWebSocketLike } from "@elizaos/host/voice/cartesia-sonic-tts";
import { synthesizeCartesiaWav } from "./cartesia-synthesis";

/** A socket that opens, then answers the first generation request with an error frame and no audio. */
function refusingSocketFactory(statusCode: number) {
  return (): CartesiaWebSocketLike => {
    const listeners: Record<string, Array<(event?: unknown) => void>> = {};
    const on = (type: string, listener: (event?: unknown) => void) => {
      const bucket = listeners[type] ?? [];
      bucket.push(listener);
      listeners[type] = bucket;
    };
    const socket = {
      readyState: 1,
      send: () => {
        for (const l of listeners.message ?? [])
          l({
            data: JSON.stringify({
              type: "error",
              status_code: statusCode,
              message: "rate limited",
              context_id: "cloud-tts",
            }),
          });
      },
      close: () => {
        for (const l of listeners.close ?? []) l({ code: 1000, reason: "" });
      },
      addEventListener: (type: string, listener: (event?: unknown) => void) => {
        on(type, listener);
        if (type === "open") queueMicrotask(() => listener());
      },
      removeEventListener: () => {},
    };
    return socket as unknown as CartesiaWebSocketLike;
  };
}

async function wavFailure(
  webSocketFactory: ReturnType<typeof refusingSocketFactory>,
) {
  return synthesizeCartesiaWav({
    apiKey: "key",
    voiceId: "00000000-0000-4000-8000-00000000c0de",
    text: "Hello.",
    sampleRate: 24_000,
    maxPcmBytes: 1 << 20,
    webSocketFactory,
    timeoutMs: 2_000,
  }).then(
    () => undefined,
    (error: unknown) =>
      error as { name?: string; status?: number; beforeAudio?: boolean },
  );
}

test("Cartesia WAV synthesis reports an error frame before any audio as a refusal", async () => {
  const error = await wavFailure(refusingSocketFactory(429));
  expect({
    name: error?.name,
    status: error?.status,
    beforeAudio: error?.beforeAudio,
  }).toEqual({
    name: "CartesiaRestTtsError",
    status: 429,
    beforeAudio: true,
  });
});

test("Cartesia WAV synthesis keeps the status of a refused WebSocket upgrade", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("quota", { status: 402 })) as unknown as typeof fetch;
  try {
    const error = await synthesizeCartesiaWav({
      apiKey: "key",
      voiceId: "00000000-0000-4000-8000-00000000c0de",
      text: "Hello.",
      sampleRate: 24_000,
      maxPcmBytes: 1 << 20,
      timeoutMs: 2_000,
    }).then(
      () => undefined,
      (caught: unknown) =>
        caught as { name?: string; status?: number; beforeAudio?: boolean },
    );
    expect({
      name: error?.name,
      status: error?.status,
      beforeAudio: error?.beforeAudio,
    }).toEqual({
      name: "CartesiaRestTtsError",
      status: 402,
      beforeAudio: true,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

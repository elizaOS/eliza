/**
 * Unit coverage for the Cartesia→WAV synthesis wrapper: drives the real
 * `CartesiaSonicTtsAdapter` through an injected in-memory socket (no network),
 * asserting audio frames are buffered and wrapped into a valid WAV, and that a
 * provider error / silent socket surfaces as a throw so the route can return an
 * honest provider failure.
 */

import { describe, expect, it } from "vitest";
import type { CartesiaWebSocketFactory } from "../../../../../shared/src/lib/services/cartesia-sonic-tts";
import {
  synthesizeCartesiaBytes,
  synthesizeCartesiaWav,
} from "../cartesia-synthesis";

/** In-memory Cartesia socket: on the generation request, replay frames+done. */
function scriptedFactory(
  script: (emit: (msg: unknown) => void) => void,
): CartesiaWebSocketFactory {
  return () => {
    const open: Array<() => void> = [];
    const message: Array<(e: { readonly data: unknown }) => void> = [];
    const close: Array<(e: { readonly code?: number }) => void> = [];
    const emit = (msg: unknown) => {
      for (const l of message) l({ data: JSON.stringify(msg) });
    };
    const socket = {
      readyState: 1,
      send() {
        queueMicrotask(() => {
          script(emit);
          for (const l of close) l({ code: 1000 });
        });
      },
      close() {
        for (const l of close) l({ code: 1000 });
      },
      addEventListener(type: string, l: unknown) {
        if (type === "open") open.push(l as () => void);
        else if (type === "message")
          message.push(l as (e: { readonly data: unknown }) => void);
        else if (type === "close")
          close.push(l as (e: { readonly code?: number }) => void);
      },
    };
    queueMicrotask(() => {
      for (const l of open) l();
    });
    return socket as never;
  };
}

const b64 = (bytes: number[]) =>
  Buffer.from(Uint8Array.from(bytes)).toString("base64");

describe("synthesizeCartesiaWav", () => {
  it("buffers pcm_s16le frames and wraps them into a valid WAV", async () => {
    const factory = scriptedFactory((emit) => {
      emit({ type: "chunk", data: b64([1, 0, 2, 0]) });
      emit({ type: "chunk", data: b64([3, 0, 4, 0]) });
      emit({ type: "done", done: true });
    });

    const result = await synthesizeCartesiaWav({
      apiKey: "k",
      voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
      text: "hello",
      sampleRate: 16000,
      maxPcmBytes: 1_000_000,
      webSocketFactory: factory,
    });

    expect(result.pcmBytes).toBe(8);
    // 44-byte canonical WAV header + 8 bytes of PCM.
    expect(result.wav.byteLength).toBe(44 + 8);
    expect(String.fromCharCode(...result.wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...result.wav.slice(8, 12))).toBe("WAVE");
    expect(result.firstAudioMs).toBeGreaterThanOrEqual(0);
  });

  it("throws when the provider errors", async () => {
    const factory = scriptedFactory((emit) => {
      emit({
        type: "error",
        title: "bad_request",
        message: "invalid voice",
        status_code: 422,
        done: true,
      });
    });

    await expect(
      synthesizeCartesiaWav({
        apiKey: "k",
        voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        text: "hello",
        sampleRate: 16000,
        maxPcmBytes: 1_000_000,
        webSocketFactory: factory,
      }),
    ).rejects.toMatchObject({
      name: "CartesiaRestTtsError",
      status: 422,
      classification: "bad_request",
      safeProviderMessage: "Cartesia text-to-speech rejected the request.",
    });
  });

  it("fails immediately when connection errors without a close event", async () => {
    const factory: CartesiaWebSocketFactory = () => {
      const error: Array<
        (event: { readonly message?: string; readonly error?: unknown }) => void
      > = [];
      const socket = {
        readyState: 0,
        send() {},
        close() {},
        addEventListener(type: string, listener: unknown) {
          if (type === "error") {
            error.push(
              listener as (event: {
                readonly message?: string;
                readonly error?: unknown;
              }) => void,
            );
          }
        },
      };
      queueMicrotask(() => {
        for (const listener of error) {
          listener({ message: "upgrade rejected" });
        }
      });
      return socket as never;
    };

    await expect(
      synthesizeCartesiaWav({
        apiKey: "bad-key",
        voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        text: "hello",
        sampleRate: 16000,
        maxPcmBytes: 1_000_000,
        webSocketFactory: factory,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      name: "CartesiaRestTtsError",
      status: 502,
      classification: "provider_unavailable",
      safeProviderMessage: "Cartesia text-to-speech is unavailable.",
    });
  });

  it("throws when the socket closes with no audio", async () => {
    const factory = scriptedFactory((emit) => {
      emit({ type: "done", done: true });
    });

    await expect(
      synthesizeCartesiaWav({
        apiKey: "k",
        voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        text: "hello",
        sampleRate: 16000,
        maxPcmBytes: 1_000_000,
        webSocketFactory: factory,
      }),
    ).rejects.toThrow(/no audio/);
  });

  it("throws instead of returning truncated audio when the PCM cap is exceeded", async () => {
    const factory = scriptedFactory((emit) => {
      emit({ type: "chunk", data: b64([1, 0, 2, 0]) });
      // Second frame pushes past the 6-byte cap — the synthesis must cancel
      // and throw, never serve a silently shortened WAV.
      emit({ type: "chunk", data: b64([3, 0, 4, 0]) });
      emit({ type: "done", done: true });
    });

    await expect(
      synthesizeCartesiaWav({
        apiKey: "k",
        voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        text: "hello",
        sampleRate: 16000,
        maxPcmBytes: 6,
        webSocketFactory: factory,
      }),
    ).rejects.toThrow(/exceeded/);
  });

  it("times out (and throws) when the stream never completes", async () => {
    // Script emits one frame and then goes silent: no done, no close — the
    // half-open-socket case the deadline exists for.
    const factory: CartesiaWebSocketFactory = () => {
      const open: Array<() => void> = [];
      const message: Array<(e: { readonly data: unknown }) => void> = [];
      const close: Array<(e: { readonly code?: number }) => void> = [];
      const socket = {
        readyState: 1,
        send() {
          queueMicrotask(() => {
            for (const l of message)
              l({
                data: JSON.stringify({ type: "chunk", data: b64([1, 0]) }),
              });
          });
        },
        close() {
          for (const l of close) l({ code: 1000 });
        },
        addEventListener(type: string, l: unknown) {
          if (type === "open") open.push(l as () => void);
          else if (type === "message")
            message.push(l as (e: { readonly data: unknown }) => void);
          else if (type === "close")
            close.push(l as (e: { readonly code?: number }) => void);
        },
      };
      queueMicrotask(() => {
        for (const l of open) l();
      });
      return socket as never;
    };

    await expect(
      synthesizeCartesiaWav({
        apiKey: "k",
        voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        text: "hello",
        sampleRate: 16000,
        maxPcmBytes: 1_000_000,
        webSocketFactory: factory,
        timeoutMs: 80,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("synthesizeCartesiaBytes", () => {
  it("posts Sonic 3.5 MP3 requests with server auth and streams the response body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([73, 68, 51]));
        controller.close();
      },
    });
    const calls: RequestInit[] = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(url)).toBe("https://api.cartesia.ai/tts/bytes");
      calls.push(init ?? {});
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }) as typeof fetch;

    const result = await synthesizeCartesiaBytes({
      apiKey: "cartesia-key",
      voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
      text: "hello",
      fetch: fetchImpl,
    });

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.provider).toBe("cartesia");
    expect(result.modelId).toBe("sonic-3.5");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers).toMatchObject({
      "X-API-Key": "cartesia-key",
      "Cartesia-Version": "2025-04-16",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(calls[0].body))).toEqual({
      model_id: "sonic-3.5",
      transcript: "hello",
      voice: { mode: "id", id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" },
      output_format: {
        container: "mp3",
        sample_rate: 44100,
        bit_rate: 128000,
      },
    });
    expect(await new Response(result.body).arrayBuffer()).toEqual(
      new Uint8Array([73, 68, 51]).buffer,
    );
  });

  it("throws a safe typed 429 error without exposing provider bodies", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ key: "secret", message: "raw quota" }), {
        status: 429,
      })) as unknown as typeof fetch;

    await expect(
      synthesizeCartesiaBytes({
        apiKey: "cartesia-key",
        voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        text: "hello",
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "CartesiaRestTtsError",
      status: 429,
      classification: "rate_limit",
      safeProviderMessage:
        "Cartesia text-to-speech is rate limited or quota constrained. Please try again later.",
    });
  });
});

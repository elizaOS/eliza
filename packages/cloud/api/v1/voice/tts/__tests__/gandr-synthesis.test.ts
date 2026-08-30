/**
 * Unit coverage for the Gandr synthesis wrappers: drives both lanes through
 * an injected fetch (no network), asserting the OpenAI compatible request
 * shape, MP3 stream passthrough, PCM-to-WAV wrapping at 24000 Hz, and that a
 * provider failure or an oversized/empty PCM body surfaces as a throw so the
 * route can return an honest provider failure.
 */

import { describe, expect, it } from "vitest";
import {
  GANDR_PCM_SAMPLE_RATE,
  synthesizeGandrBytes,
  synthesizeGandrWav,
} from "../gandr-synthesis";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("synthesizeGandrBytes", () => {
  it("posts an OpenAI compatible MP3 request with bearer auth and streams the body", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(url)).toBe("https://tts.gandr.ai/v1/audio/speech");
      calls.push(init ?? {});
      return new Response(streamOf(new Uint8Array([73, 68, 51])), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }) as typeof fetch;

    const result = await synthesizeGandrBytes({
      apiKey: "gandr-key",
      voice: "gandr-mia",
      text: "hello",
      fetch: fetchImpl,
    });

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.provider).toBe("gandr");
    expect(result.modelId).toBe("tts-1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers).toMatchObject({
      Authorization: "Bearer gandr-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(calls[0].body))).toEqual({
      model: "tts-1",
      input: "hello",
      voice: "gandr-mia",
      response_format: "mp3",
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
      synthesizeGandrBytes({
        apiKey: "gandr-key",
        voice: "gandr-mia",
        text: "hello",
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "GandrRestTtsError",
      status: 429,
      classification: "rate_limit",
      safeProviderMessage:
        "Gandr text-to-speech is rate limited or quota constrained. Please try again later.",
    });
  });
});

describe("synthesizeGandrWav", () => {
  it("requests raw PCM and wraps it into a valid 24 kHz WAV", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push(init ?? {});
      return new Response(
        streamOf(new Uint8Array([1, 0, 2, 0]), new Uint8Array([3, 0, 4, 0])),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await synthesizeGandrWav({
      apiKey: "gandr-key",
      voice: "gandr-ava",
      text: "hello",
      maxPcmBytes: 1_000_000,
      fetch: fetchImpl,
    });

    expect(JSON.parse(String(calls[0].body))).toMatchObject({
      response_format: "pcm",
    });
    // 44-byte canonical WAV header + 8 bytes of PCM.
    expect(result.wav.byteLength).toBe(44 + 8);
    expect(String.fromCharCode(...result.wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...result.wav.slice(8, 12))).toBe("WAVE");
    expect(new DataView(result.wav.buffer).getUint32(24, true)).toBe(
      GANDR_PCM_SAMPLE_RATE,
    );
  });

  it("throws when the PCM body exceeds the byte cap instead of truncating", async () => {
    const fetchImpl = (async () =>
      new Response(streamOf(new Uint8Array(16)), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      synthesizeGandrWav({
        apiKey: "gandr-key",
        voice: "gandr-ava",
        text: "hello",
        maxPcmBytes: 6,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/byte limit/);
  });

  it("throws when the provider returns no audio", async () => {
    const fetchImpl = (async () =>
      new Response(streamOf(), { status: 200 })) as unknown as typeof fetch;

    await expect(
      synthesizeGandrWav({
        apiKey: "gandr-key",
        voice: "gandr-ava",
        text: "hello",
        maxPcmBytes: 1_000_000,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/16-bit samples/);
  });
});

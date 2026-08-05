/**
 * Fish Audio plugin TTS tests with an in-memory WebSocket.
 *
 * Live Fish Audio coverage runs only with explicitly supplied credentials and
 * can write an inspectable WAV when `FISH_AUDIO_EVIDENCE_PATH` is provided:
 * `ELIZA_TTS_FISH_ENABLED=true FISH_AUDIO_API_KEY=... FISH_AUDIO_REFERENCE_ID=... \
 * FISH_AUDIO_EVIDENCE_PATH=/tmp/fish-audio-evidence.wav \
 * bun run --cwd plugins/plugin-fish-audio test -- \
 * --testNamePattern "live Fish Audio"`.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { decode, encode } from "@msgpack/msgpack";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import {
  configureFishAudioWebSocketFactory,
  fishAudioPlugin,
  handleFishAudioTextToSpeech,
} from "../src/index";

class FakeFishSocket {
  static instances: FakeFishSocket[] = [];
  static respondToText = true;
  static finishReason: "stop" | "error" = "stop";
  static calls: Array<{
    url: string;
    protocols?: string | string[];
    options?: { headers?: Record<string, string> };
  }> = [];
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) {
    FakeFishSocket.calls.push({ url, protocols, options });
    FakeFishSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.fire("open", undefined);
    });
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
    const frame = decode(data) as { event?: string; text?: string };
    if (FakeFishSocket.respondToText && frame.event === "text" && frame.text) {
      queueMicrotask(() => {
        this.fire("message", {
          data: encode({ event: "audio", audio: new Uint8Array([5, 6]) }),
        });
        this.fire("message", {
          data: encode({
            event: "finish",
            reason: FakeFishSocket.finishReason,
          }),
        });
      });
    }
  }

  close(_code?: number, reason?: string): void {
    this.readyState = 3;
    this.fire("close", { reason });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener as (event: unknown) => void);
  }

  private fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function runtime(
  settings: Record<string, string | undefined> = {},
): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
    registerModel: vi.fn(),
  } as unknown as IAgentRuntime;
}

function wrapPcm16MonoAsWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  const wav = new Uint8Array(header.byteLength + pcm.byteLength);
  wav.set(header);
  wav.set(pcm, header.byteLength);
  return wav;
}

function sentFrames(): Record<string, unknown>[] {
  const socket = FakeFishSocket.instances.at(-1);
  if (!socket) throw new Error("Expected a Fish Audio WebSocket");
  return socket.sent.map((frame) => decode(frame) as Record<string, unknown>);
}

afterEach(() => {
  FakeFishSocket.instances = [];
  FakeFishSocket.calls = [];
  FakeFishSocket.respondToText = true;
  FakeFishSocket.finishReason = "stop";
  configureFishAudioWebSocketFactory(undefined);
  Reflect.deleteProperty(globalThis, "WebSocket");
});

describe("fishAudioPlugin", () => {
  test("does not register TEXT_TO_SPEECH by default", async () => {
    const rt = runtime({
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    await fishAudioPlugin.init?.({}, rt);

    expect(rt.registerModel).not.toHaveBeenCalled();
  });

  test("registers TEXT_TO_SPEECH when ELIZA_TTS_FISH_ENABLED is true", async () => {
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    await fishAudioPlugin.init?.({}, rt);

    expect(rt.registerModel).toHaveBeenCalledWith(
      ModelType.TEXT_TO_SPEECH,
      expect.any(Function),
      "fish-audio",
      undefined,
    );
  });

  test("returns AudioStreamResult when audioStream is true and sends MessagePack frames", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeFishSocket,
      configurable: true,
    });
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    const result = await handleFishAudioTextToSpeech(rt, {
      text: "hello",
      audioStream: true,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.audioStream) chunks.push(chunk);

    expect(chunks).toEqual([new Uint8Array([5, 6])]);
    expect(await result.bytes).toEqual(new Uint8Array([5, 6]));
    expect(FakeFishSocket.calls.at(-1)).toEqual({
      url: "wss://api.fish.audio/v1/tts/live",
      protocols: undefined,
      options: {
        headers: { Authorization: "Bearer key", model: "s2.1-pro" },
      },
    });
    expect(sentFrames()).toEqual([
      {
        event: "start",
        request: {
          text: "",
          reference_id: "voice",
          format: "pcm",
          sample_rate: 24000,
          latency: "normal",
        },
      },
      { event: "text", text: "hello" },
      { event: "flush" },
      { event: "stop" },
    ]);
  });

  test("rejects when Fish closes before a finish frame", async () => {
    FakeFishSocket.respondToText = false;
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeFishSocket,
      configurable: true,
    });
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "close early", audioStream: true },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");
    await Promise.resolve();
    FakeFishSocket.instances.at(-1)?.close(1011, "provider failed");

    await expect(result.bytes).rejects.toThrow(
      "Fish Audio WebSocket closed before finish: provider failed",
    );
  });

  test("rejects a provider finish frame whose reason is error", async () => {
    FakeFishSocket.finishReason = "error";
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeFishSocket,
      configurable: true,
    });
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "provider error", audioStream: true },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");

    await expect(result.bytes).rejects.toThrow(
      "Fish Audio TTS failed to finish synthesis",
    );
  });

  test("rejects an already-aborted request", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeFishSocket,
      configurable: true,
    });
    const controller = new AbortController();
    controller.abort();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "cancelled", audioStream: true, signal: controller.signal },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");

    await expect(result.bytes).rejects.toThrow("Fish Audio TTS aborted");
  });

  test("buffers bytes when audioStream is false", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeFishSocket,
      configurable: true,
    });
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    const result = await handleFishAudioTextToSpeech(rt, { text: "buffer me" });

    expect(result).toEqual(new Uint8Array([5, 6]));
  });

  test("wraps live PCM evidence in a valid mono WAV container", () => {
    const wav = wrapPcm16MonoAsWav(new Uint8Array([1, 2, 3, 4]), 24_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(Buffer.from(wav.subarray(0, 4)).toString("ascii")).toBe("RIFF");
    expect(Buffer.from(wav.subarray(8, 12)).toString("ascii")).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect(wav.subarray(44)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  const liveReferenceId =
    process.env.FISH_AUDIO_REFERENCE_ID ?? process.env.FISH_AUDIO_VOICE_ID;
  const liveTest =
    process.env.FISH_AUDIO_API_KEY && liveReferenceId ? test : test.skip;

  liveTest(
    "live Fish Audio realtime WebSocket returns PCM bytes",
    async () => {
      configureFishAudioWebSocketFactory(
        (url, options) => new WebSocket(url, { headers: options.headers }),
      );
      const startedAt = performance.now();
      const result = await handleFishAudioTextToSpeech(
        runtime({
          ELIZA_TTS_FISH_ENABLED: "true",
          FISH_AUDIO_API_KEY: process.env.FISH_AUDIO_API_KEY,
          FISH_AUDIO_REFERENCE_ID: liveReferenceId,
          FISH_AUDIO_MODEL: process.env.FISH_AUDIO_MODEL,
        }),
        { text: "Fish Audio live integration test.", audioStream: true },
      );
      if (result instanceof Uint8Array)
        throw new Error("Expected streaming Fish Audio result");

      let firstAudioMs: number | undefined;
      for await (const chunk of result.audioStream) {
        if (chunk.byteLength > 0 && firstAudioMs === undefined)
          firstAudioMs = performance.now() - startedAt;
      }
      const pcm = await result.bytes;
      const totalMs = performance.now() - startedAt;
      expect(firstAudioMs).toBeDefined();
      expect(pcm.byteLength).toBeGreaterThan(0);
      expect(pcm.byteLength % 2).toBe(0);

      const wav = wrapPcm16MonoAsWav(pcm, 24_000);
      const evidencePath = process.env.FISH_AUDIO_EVIDENCE_PATH;
      if (evidencePath) await writeFile(evidencePath, wav);
      process.stdout.write(
        `${JSON.stringify({
          event: "fish_audio_live_evidence",
          model: process.env.FISH_AUDIO_MODEL ?? "s2.1-pro",
          sampleRate: 24_000,
          firstAudioMs: Math.round(firstAudioMs ?? 0),
          totalMs: Math.round(totalMs),
          pcmBytes: pcm.byteLength,
          wavBytes: wav.byteLength,
          wavSha256: createHash("sha256").update(wav).digest("hex"),
          evidenceWritten: evidencePath !== undefined,
        })}\n`,
      );
    },
    60_000,
  );
});

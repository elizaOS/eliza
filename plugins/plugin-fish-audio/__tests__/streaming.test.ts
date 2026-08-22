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

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.fire("close", { code, reason });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener as (event: unknown) => void);
  }

  emitAudio(bytes: Uint8Array): void {
    this.fire("message", { data: encode({ event: "audio", audio: bytes }) });
  }

  emitFinish(): void {
    this.fire("message", { data: encode({ event: "finish", reason: "stop" }) });
  }

  emitError(message: string, error: unknown): void {
    this.fire("error", { message, error });
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

function useFakeSocket(): void {
  configureFishAudioWebSocketFactory(
    (url, options) => new FakeFishSocket(url, undefined, options),
  );
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
  vi.useRealTimers();
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

  test("does not register when data-governance approval is absent", async () => {
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    await fishAudioPlugin.init?.({}, rt);

    expect(rt.registerModel).not.toHaveBeenCalled();
  });

  test("registers TEXT_TO_SPEECH when enablement and governance approval are explicit", async () => {
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
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
    useFakeSocket();
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
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
          latency: "balanced",
          chunk_length: 100,
        },
      },
      { event: "text", text: "hello" },
      { event: "flush" },
      { event: "stop" },
    ]);
  });

  test("rejects synthesis timeouts above node's timer limit", async () => {
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    await expect(
      handleFishAudioTextToSpeech(rt, {
        text: "hello",
        synthesisTimeoutMs: 2_147_483_648,
      }),
    ).rejects.toMatchObject({ code: "FISH_AUDIO_SYNTHESIS_TIMEOUT_INVALID" });
  });

  test("rejects when Fish closes before a finish frame", async () => {
    FakeFishSocket.respondToText = false;
    useFakeSocket();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "close early", audioStream: true },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");
    await Promise.resolve();
    FakeFishSocket.instances.at(-1)?.close(1011, "provider failed");

    await expect(result.bytes).rejects.toThrow(
      "Fish Audio WebSocket closed before synthesis completed",
    );
  });

  test("does not preserve provider-controlled WebSocket error text or causes", async () => {
    FakeFishSocket.respondToText = false;
    useFakeSocket();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "transport error", audioStream: true },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");
    await Promise.resolve();
    const secret = "WS_CAUSE_SECRET_do-not-reflect_88fd";
    FakeFishSocket.instances
      .at(-1)
      ?.emitError(
        "Unexpected server response: 401",
        new Error(`cause ${secret}`),
      );

    const failure = await result.bytes.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "FISH_AUDIO_AUTH_FAILED",
      message: "Fish Audio authentication failed",
      context: { retryable: false, statusCode: 401 },
    });
    const error = failure as Error & {
      cause?: unknown;
      context?: Record<string, unknown>;
    };
    expect(error.cause).toBeUndefined();
    expect(
      [
        String(error),
        error.stack,
        JSON.stringify(error),
        JSON.stringify(error.context),
        String(error.cause),
      ].join("\n"),
    ).not.toContain(secret);
  });

  test("does not classify injected status digits as an upgrade status", async () => {
    FakeFishSocket.respondToText = false;
    useFakeSocket();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "ambiguous transport error", audioStream: true },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");
    await Promise.resolve();
    const secret = "WS_STATUS_SECRET_429_then_401_778a";
    FakeFishSocket.instances
      .at(-1)
      ?.emitError(
        `provider text ${secret}`,
        new Error(`Unexpected server response: 401 ${secret}`),
      );

    const failure = await result.bytes.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "FISH_AUDIO_WEBSOCKET_ERROR",
      message: "Fish Audio WebSocket transport failed",
      context: { retryable: true },
    });
    const error = failure as Error & { cause?: unknown };
    expect(error.cause).toBeUndefined();
    expect(
      [String(error), error.stack, JSON.stringify(error)].join("\n"),
    ).not.toContain(secret);
  });

  test("rejects a provider finish frame whose reason is error", async () => {
    FakeFishSocket.finishReason = "error";
    useFakeSocket();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "provider error", audioStream: true },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");

    await expect(result.bytes).rejects.toThrow(
      "Fish Audio provider reported a synthesis failure",
    );
  });

  test("rejects an already-aborted request", async () => {
    useFakeSocket();
    const controller = new AbortController();
    controller.abort();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "cancelled", audioStream: true, signal: controller.signal },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");

    await expect(result.bytes).rejects.toThrow("Fish Audio TTS aborted");
  });

  test("detaches the abort listener once synthesis finishes on its own", async () => {
    useFakeSocket();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "hello", audioStream: true, signal: controller.signal },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");
    await result.bytes;

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  test("buffers bytes when audioStream is false", async () => {
    useFakeSocket();
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    const result = await handleFishAudioTextToSpeech(rt, { text: "buffer me" });

    expect(result).toEqual(new Uint8Array([5, 6]));
  });

  test("accepts audio exactly at the configured buffer ceiling", async () => {
    FakeFishSocket.respondToText = false;
    useFakeSocket();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "bounded", audioStream: true, maxBufferBytes: 4 },
    );
    if (result instanceof Uint8Array)
      throw new Error("Expected streaming result");
    await Promise.resolve();
    const socket = FakeFishSocket.instances.at(-1);
    socket?.emitAudio(new Uint8Array([1, 2]));
    socket?.emitAudio(new Uint8Array([3, 4]));
    socket?.emitFinish();

    await expect(result.bytes).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("rejects both result surfaces and closes when audio exceeds the buffer ceiling", async () => {
    FakeFishSocket.respondToText = false;
    useFakeSocket();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "too large", audioStream: true, maxBufferBytes: 3 },
    );
    if (result instanceof Uint8Array)
      throw new Error("Expected streaming result");
    const iterator = result.audioStream[Symbol.asyncIterator]();
    await Promise.resolve();
    const socket = FakeFishSocket.instances.at(-1);
    socket?.emitAudio(new Uint8Array([1, 2]));
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: new Uint8Array([1, 2]),
    });
    socket?.emitAudio(new Uint8Array([3, 4]));

    await expect(result.bytes).rejects.toMatchObject({
      code: "FISH_AUDIO_MAX_BUFFER_BYTES_EXCEEDED",
    });
    await expect(iterator.next()).rejects.toMatchObject({
      code: "FISH_AUDIO_MAX_BUFFER_BYTES_EXCEEDED",
    });
    expect(socket?.readyState).toBe(3);
  });

  test("rejects and closes a stalled synthesis at the wall-clock deadline", async () => {
    vi.useFakeTimers();
    FakeFishSocket.respondToText = false;
    useFakeSocket();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "stall", audioStream: true, synthesisTimeoutMs: 25 },
    );
    if (result instanceof Uint8Array)
      throw new Error("Expected streaming result");
    vi.advanceTimersByTime(25);

    await expect(result.bytes).rejects.toMatchObject({
      code: "FISH_AUDIO_SYNTHESIS_TIMEOUT",
    });
    expect(FakeFishSocket.instances.at(-1)?.readyState).toBe(3);
  });

  test("suppresses provider frames and deadline work after cancellation", async () => {
    vi.useFakeTimers();
    FakeFishSocket.respondToText = false;
    useFakeSocket();
    const controller = new AbortController();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      {
        text: "cancel",
        audioStream: true,
        signal: controller.signal,
        synthesisTimeoutMs: 25,
      },
    );
    if (result instanceof Uint8Array)
      throw new Error("Expected streaming result");
    controller.abort();
    const socket = FakeFishSocket.instances.at(-1);
    await expect(result.bytes).rejects.toMatchObject({
      code: "FISH_AUDIO_STREAM_ABORTED",
    });
    socket?.emitAudio(new Uint8Array([9, 9]));
    vi.advanceTimersByTime(25);

    expect(socket?.readyState).toBe(3);
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
          FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
          FISH_AUDIO_API_KEY: process.env.FISH_AUDIO_API_KEY,
          FISH_AUDIO_REFERENCE_ID: liveReferenceId,
          FISH_AUDIO_MODEL: process.env.FISH_AUDIO_MODEL,
        }),
        {
          text: "Fish Audio should begin speaking before this complete sentence has finished synthesizing. This longer live sample verifies that playback receives multiple incremental audio frames instead of one buffered response.",
          audioStream: true,
        },
      );
      if (result instanceof Uint8Array)
        throw new Error("Expected streaming Fish Audio result");

      let firstAudioMs: number | undefined;
      let lastAudioMs: number | undefined;
      let audioFrames = 0;
      for await (const chunk of result.audioStream) {
        if (chunk.byteLength > 0) {
          const elapsedMs = performance.now() - startedAt;
          firstAudioMs ??= elapsedMs;
          lastAudioMs = elapsedMs;
          audioFrames += 1;
        }
      }
      const pcm = await result.bytes;
      const totalMs = performance.now() - startedAt;
      expect(firstAudioMs).toBeDefined();
      expect(lastAudioMs).toBeDefined();
      expect(audioFrames).toBeGreaterThan(1);
      expect(firstAudioMs ?? totalMs).toBeLessThan(totalMs);
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
          lastAudioMs: Math.round(lastAudioMs ?? 0),
          totalMs: Math.round(totalMs),
          audioFrames,
          streamedBeforeComplete: (firstAudioMs ?? totalMs) < totalMs,
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

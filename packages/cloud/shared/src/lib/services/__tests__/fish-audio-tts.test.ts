/**
 * Fish Audio realtime adapter contract tests using in-memory WebSockets.
 *
 * The harness drives the real adapter and only mocks transport. The standalone
 * plugin suite owns the credential-gated provider round trip.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { decode, encode } from "@msgpack/msgpack";
import {
  FISH_AUDIO_MODEL_S21_PRO,
  FISH_AUDIO_TTS_WEBSOCKET_URL,
  FishAudioTtsAdapter,
  type FishAudioWebSocketFactory,
  type FishAudioWebSocketFactoryOptions,
  type FishAudioWebSocketLike,
} from "../fish-audio-tts";

class FakeFishSocket implements FishAudioWebSocketLike {
  static readonly OPEN = 1;
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  sent: Uint8Array[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = {
    open: new Set<() => void>(),
    message: new Set<(event: { readonly data: unknown }) => void>(),
    error: new Set<(event: { readonly message?: string; readonly error?: unknown }) => void>(),
    close: new Set<(event: { readonly code?: number; readonly reason?: string }) => void>(),
  };

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
    for (const listener of this.listeners.close) listener({ code, reason });
  }

  addEventListener(type: string, listener: never): void {
    if (type === "open") this.listeners.open.add(listener as () => void);
    if (type === "message") {
      this.listeners.message.add(listener as (event: { readonly data: unknown }) => void);
    }
    if (type === "error") {
      this.listeners.error.add(
        listener as (event: { readonly message?: string; readonly error?: unknown }) => void,
      );
    }
    if (type === "close") {
      this.listeners.close.add(
        listener as (event: { readonly code?: number; readonly reason?: string }) => void,
      );
    }
  }

  emitOpen(): void {
    this.readyState = FakeFishSocket.OPEN;
    for (const listener of this.listeners.open) listener();
  }

  emitAudio(bytes: Uint8Array): void {
    for (const listener of this.listeners.message) {
      listener({ data: encode({ event: "audio", audio: bytes }) });
    }
  }

  emitDone(reason: "stop" | "error" = "stop"): void {
    for (const listener of this.listeners.message) {
      listener({ data: encode({ event: "finish", reason }) });
    }
  }

  emitError(message: string): void {
    for (const listener of this.listeners.error) listener({ message });
  }
}

function makeHarness(opts?: { maxQueuedFrames?: number; firstAudioTimeoutMs?: number }) {
  const sockets: FakeFishSocket[] = [];
  const calls: Array<{ url: string; options: FishAudioWebSocketFactoryOptions }> = [];
  const factory: FishAudioWebSocketFactory = (url, options) => {
    calls.push({ url, options });
    const socket = new FakeFishSocket();
    sockets.push(socket);
    return socket;
  };
  const metrics: string[] = [];
  const adapter = new FishAudioTtsAdapter({
    apiKey: "fish-key",
    referenceId: "voice-1",
    websocketFactory: factory,
    maxQueuedFrames: opts?.maxQueuedFrames,
    firstAudioTimeoutMs: opts?.firstAudioTimeoutMs ?? 10_000,
    metrics: (event) => metrics.push(event.name),
  });
  return { adapter, calls, metrics, socket: () => sockets[0], sockets };
}

function sentFrames(socket: FakeFishSocket): Record<string, unknown>[] {
  return socket.sent.map((frame) => decode(frame) as Record<string, unknown>);
}

describe("FishAudioTtsAdapter", () => {
  test("opens Fish public realtime WebSocket and sends MessagePack start/text/stop frames", () => {
    const { adapter, calls, socket } = makeHarness();
    const stream = adapter.createStream({ contextId: "ctx-1", traceId: "trace-1" }, {});

    stream.sendPhrase({ text: "Hello Fish.", continueContext: false });
    expect(socket().sent).toEqual([]);
    socket().emitOpen();

    expect(calls[0]).toEqual({
      url: FISH_AUDIO_TTS_WEBSOCKET_URL,
      options: {
        headers: { Authorization: "Bearer fish-key", model: "s2.1-pro" },
      },
    });
    expect(adapter.metadata).toMatchObject({
      provider: "fish-audio",
      modelId: FISH_AUDIO_MODEL_S21_PRO,
      output: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
    });
    expect(sentFrames(socket())).toEqual([
      {
        event: "start",
        request: {
          text: "",
          reference_id: "voice-1",
          format: "pcm",
          sample_rate: 16000,
          latency: "normal",
        },
      },
      { event: "text", text: "Hello Fish." },
      { event: "stop" },
    ]);
  });

  test("reports first-audio latency metric and emits downlink PCM bytes", () => {
    const { adapter, metrics, socket } = makeHarness();
    const firstAudio: number[] = [];
    const frames: Uint8Array[] = [];
    const stream = adapter.createStream(
      { contextId: "ctx-1", traceId: "trace-1" },
      {
        onFirstAudio: (event) => firstAudio.push(event.elapsedMs),
        onAudioFrame: (event) => frames.push(event.bytes),
      },
    );
    socket().emitOpen();
    stream.sendPhrase({ text: "bytes", continueContext: false });

    socket().emitAudio(new Uint8Array([1, 2, 3, 4]));

    expect(firstAudio.length).toBe(1);
    expect(firstAudio[0]).toBeGreaterThanOrEqual(0);
    expect(metrics).toContain("fish_tts_first_audio");
    expect(frames).toEqual([new Uint8Array([1, 2, 3, 4])]);
  });

  test("flushes continuation text so short realtime phrases synthesize immediately", () => {
    const { adapter, socket } = makeHarness();
    const stream = adapter.createStream({ contextId: "ctx-1" }, {});
    socket().emitOpen();

    stream.sendPhrase({ text: "Short phrase. ", continueContext: true, flush: true });

    expect(sentFrames(socket()).slice(1)).toEqual([
      { event: "text", text: "Short phrase. " },
      { event: "flush" },
    ]);
  });

  test("treats a finish frame with reason error as provider failure", () => {
    const { adapter, socket } = makeHarness();
    const codes: Array<string | undefined> = [];
    adapter.createStream(
      { contextId: "ctx-1" },
      { onProviderError: (event) => codes.push(event.code) },
    );
    socket().emitOpen();

    socket().emitDone("error");

    expect(codes).toEqual(["provider_finish_error"]);
  });

  test("reports an opened socket closing before audio as a fallback-eligible transport error", () => {
    const { adapter, socket } = makeHarness();
    const codes: Array<string | undefined> = [];
    const stream = adapter.createStream(
      { contextId: "ctx-1" },
      { onProviderError: (event) => codes.push(event.code) },
    );
    socket().emitOpen();
    stream.sendPhrase({ text: "connect then close", continueContext: false });

    socket().close(1006, "connection lost");

    expect(codes).toEqual(["websocket_error"]);
  });

  test("bounds pre-open outbound queue for backpressure", () => {
    const { adapter } = makeHarness({ maxQueuedFrames: 1 });
    const stream = adapter.createStream({ contextId: "ctx-1" }, {});

    stream.sendPhrase({ text: "one", continueContext: true });
    expect(() => stream.sendPhrase({ text: "two", continueContext: true })).toThrow(
      "Fish outbound queue exceeded",
    );
  });

  test("rejects an invalid per-stream first-audio timeout with a structured error", () => {
    const { adapter } = makeHarness();

    expect(() => adapter.createStream({ contextId: "ctx-1", firstAudioTimeoutMs: 0 }, {})).toThrow(
      expect.objectContaining<Partial<ElizaError>>({
        code: "CONFIG_FIRST_AUDIO_TIMEOUT_INVALID",
      }),
    );
  });

  test("abort/barge-in cancellation closes socket and suppresses later audio", () => {
    const { adapter, socket, sockets } = makeHarness();
    const frames: Uint8Array[] = [];
    const stream = adapter.createStream({ contextId: "ctx-1" }, {});
    const liveStream = adapter.createStream(
      { contextId: "ctx-2" },
      {
        onAudioFrame: (event) => frames.push(event.bytes),
      },
    );
    void stream.opened.catch(() => undefined);
    void liveStream.opened.catch(() => undefined);

    stream.sendPhrase({ text: "queued", continueContext: true });
    stream.cancel("barge-in");
    socket().emitOpen();
    liveStream.cancel("barge-in");
    sockets[1].emitAudio(new Uint8Array([9, 9]));

    expect(sentFrames(socket())).toEqual([]);
    expect(socket().closes.at(-1)).toEqual({ code: 1000, reason: "barge-in" });
    expect(frames).toEqual([]);
  });
});

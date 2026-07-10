/**
 * Exercises the Cartesia Sonic streaming adapter with an injected WebSocket.
 *
 * The fake socket drives the provider protocol directly, so the suite proves
 * callback ordering, cancellation, and request framing without touching HTTP
 * routes, playback, or phrase chunking.
 */

import { describe, expect, test } from "bun:test";
import {
  CARTESIA_API_VERSION,
  CARTESIA_SONIC_MODEL_ID,
  CartesiaSonicTtsAdapter,
  type CartesiaWebSocketFactory,
  type CartesiaWebSocketFactoryOptions,
  type CartesiaWebSocketLike,
} from "../cartesia-sonic-tts";

const VOICE_ID = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";

class FakeCartesiaWebSocket implements CartesiaWebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeCartesiaWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = {
    open: new Set<() => void>(),
    message: new Set<(event: { readonly data: unknown }) => void>(),
    error: new Set<(event: { readonly message?: string; readonly error?: unknown }) => void>(),
    close: new Set<(event: { readonly code?: number; readonly reason?: string }) => void>(),
  };

  send(data: string): void {
    if (this.readyState !== FakeCartesiaWebSocket.OPEN) {
      throw new Error("Fake WebSocket send requires OPEN readyState");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = FakeCartesiaWebSocket.CLOSED;
    this.closes.push({ code, reason });
    this.emitClose(code, reason);
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(
    type: "error",
    listener: (event: { readonly message?: string; readonly error?: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { readonly code?: number; readonly reason?: string }) => void,
  ): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener:
      | (() => void)
      | ((event: { readonly data: unknown }) => void)
      | ((event: { readonly message?: string; readonly error?: unknown }) => void)
      | ((event: { readonly code?: number; readonly reason?: string }) => void),
  ): void {
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
    this.readyState = FakeCartesiaWebSocket.OPEN;
    for (const listener of this.listeners.open) listener();
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.message) listener({ data });
  }

  emitError(message: string): void {
    for (const listener of this.listeners.error) listener({ message });
  }

  private emitClose(code?: number, reason?: string): void {
    for (const listener of this.listeners.close) listener({ code, reason });
  }
}

function makeHarness() {
  const sockets: FakeCartesiaWebSocket[] = [];
  const calls: Array<{
    readonly url: string;
    readonly options: CartesiaWebSocketFactoryOptions;
  }> = [];
  const factory: CartesiaWebSocketFactory = (url, options) => {
    calls.push({ url, options });
    const socket = new FakeCartesiaWebSocket();
    sockets.push(socket);
    return socket;
  };
  const metrics: string[] = [];
  const adapter = new CartesiaSonicTtsAdapter({
    apiKey: "cartesia-server-key",
    voiceId: VOICE_ID,
    websocketFactory: factory,
    metrics: (event) => metrics.push(event.name),
  });
  return { adapter, calls, metrics, socket: () => sockets[0] };
}

function chunk(data: Uint8Array, sequenceExtras?: Record<string, unknown>) {
  return JSON.stringify({
    type: "chunk",
    data: encodeBase64(data),
    done: false,
    status_code: 206,
    context_id: "ctx-1",
    ...sequenceExtras,
  });
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("CartesiaSonicTtsAdapter", () => {
  test("queues a phrase sent immediately after createStream until the socket opens", () => {
    const { adapter, socket } = makeHarness();
    const stream = adapter.createStream({ contextId: "ctx-1" }, {});

    stream.sendPhrase({ text: "queued now", continueContext: true });

    expect(socket().sent).toEqual([]);
    socket().emitOpen();
    expect(JSON.parse(socket().sent[0])).toMatchObject({
      transcript: "queued now",
      context_id: "ctx-1",
      continue: true,
    });
  });

  test("flushes queued phrases in order when the socket opens", () => {
    const { adapter, socket } = makeHarness();
    const stream = adapter.createStream({ contextId: "ctx-1" }, {});

    stream.sendPhrase({ text: "first", continueContext: true });
    stream.sendPhrase({ text: "second", continueContext: true, flush: true });
    stream.sendPhrase({ text: "third", continueContext: false });

    expect(socket().sent).toEqual([]);
    socket().emitOpen();
    expect(socket().sent.map((frame) => JSON.parse(frame).transcript)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("discards queued synthesis when cancellation happens before open", async () => {
    const { adapter, socket } = makeHarness();
    const stream = adapter.createStream({ contextId: "ctx-1" }, {});
    const opened = stream.opened.catch((error) => error);

    stream.sendPhrase({ text: "do not synthesize", continueContext: true });
    stream.cancel("barge-in-before-open");
    socket().emitOpen();

    const openError = await opened;
    expect(openError).toBeInstanceOf(Error);
    expect(openError.message).toBe("Cartesia WebSocket closed during cancellation");
    expect(socket().sent).toEqual([]);
    expect(socket().closes.at(-1)).toEqual({
      code: 1000,
      reason: "barge-in-before-open",
    });
  });

  test("discards queued synthesis when the provider fails before open", async () => {
    const { adapter, socket } = makeHarness();
    const errors: string[] = [];
    const stream = adapter.createStream(
      { contextId: "ctx-1" },
      {
        onProviderError: (event) => errors.push(`${event.code}:${event.message}`),
      },
    );
    const opened = stream.opened.catch((error) => error);

    stream.sendPhrase({ text: "provider should never receive this", continueContext: true });
    socket().emitError("tls failure");
    socket().emitOpen();

    const openError = await opened;
    expect(openError).toBeInstanceOf(Error);
    expect(openError.message).toBe("tls failure");
    expect(errors).toEqual(["websocket_error:tls failure"]);
    expect(socket().sent).toEqual([]);
  });

  test("opens a server-authenticated Cartesia WebSocket and frames Sonic 3.5 PCM requests", () => {
    const { adapter, calls, socket } = makeHarness();
    const stream = adapter.createStream(
      { contextId: "ctx-1", traceId: "trace-1", maxBufferDelayMs: 80 },
      {},
    );
    socket().emitOpen();

    expect(stream.contextId).toBe("ctx-1");
    expect(calls[0].url).toBe(
      `wss://api.cartesia.ai/tts/websocket?cartesia_version=${CARTESIA_API_VERSION}`,
    );
    expect(calls[0].options.headers).toEqual({
      "Cartesia-Version": CARTESIA_API_VERSION,
      "X-API-Key": "cartesia-server-key",
    });
    expect(adapter.metadata).toEqual({
      provider: "cartesia-sonic",
      modelId: CARTESIA_SONIC_MODEL_ID,
      apiVersion: CARTESIA_API_VERSION,
      transport: "websocket",
      output: {
        container: "raw",
        encoding: "pcm_s16le",
        sampleRate: 16000,
        channels: 1,
      },
    });

    stream.sendPhrase({
      text: "Hello, ",
      continueContext: true,
      flush: true,
    });

    expect(JSON.parse(socket().sent[0])).toEqual({
      model_id: CARTESIA_SONIC_MODEL_ID,
      transcript: "Hello, ",
      voice: { mode: "id", id: VOICE_ID },
      language: "en",
      context_id: "ctx-1",
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: 16000,
      },
      continue: true,
      max_buffer_delay_ms: 80,
      flush: true,
    });
  });

  test("emits first-audio once and ordered continuous PCM frames", () => {
    const { adapter, metrics, socket } = makeHarness();
    const firstAudio: number[] = [];
    const frames: Array<{ sequence: number; bytes: number[]; flushId?: number }> = [];
    const stream = adapter.createStream(
      { contextId: "ctx-1", traceId: "trace-frames" },
      {
        onFirstAudio: (event) => firstAudio.push(event.elapsedMs),
        onAudioFrame: (event) =>
          frames.push({
            sequence: event.sequence,
            bytes: [...event.bytes],
            flushId: event.flushId,
          }),
      },
    );
    socket().emitOpen();

    socket().emitMessage(chunk(new Uint8Array([1, 2]), { flush_id: 1 }));
    socket().emitMessage(chunk(new Uint8Array([3, 4]), { flush_id: 1 }));

    expect(stream.contextId).toBe("ctx-1");
    expect(firstAudio).toHaveLength(1);
    expect(frames).toEqual([
      { sequence: 1, bytes: [1, 2], flushId: 1 },
      { sequence: 2, bytes: [3, 4], flushId: 1 },
    ]);
    expect(metrics).toContain("cartesia_tts_first_audio");
    expect(metrics.filter((name) => name === "cartesia_tts_audio_frame")).toHaveLength(2);
  });

  test("rejects opened and emits one provider error when the socket closes before opening", async () => {
    const { adapter, metrics, socket } = makeHarness();
    const errors: string[] = [];
    const stream = adapter.createStream(
      { contextId: "ctx-1", traceId: "trace-pre-open-close" },
      {
        onProviderError: (event) => errors.push(`${event.code}:${event.message}`),
      },
    );
    const opened = stream.opened.catch((error) => error);

    socket().close(1006, "upstream closed");
    await stream.closed;

    const openError = await opened;
    expect(openError).toBeInstanceOf(Error);
    expect(openError.message).toBe("Cartesia WebSocket closed before opening: upstream closed");
    expect(errors).toEqual([
      "websocket_closed_before_open:Cartesia WebSocket closed before opening: upstream closed",
    ]);
    expect(metrics.filter((name) => name === "cartesia_tts_provider_error")).toHaveLength(1);
  });

  test("does not duplicate provider errors when an error event precedes pre-open close", async () => {
    const { adapter, metrics, socket } = makeHarness();
    const errors: string[] = [];
    const stream = adapter.createStream(
      { contextId: "ctx-1", traceId: "trace-pre-open-error-close" },
      {
        onProviderError: (event) => errors.push(`${event.code}:${event.message}`),
      },
    );
    const opened = stream.opened.catch((error) => error);

    socket().emitError("tls failure");
    socket().close(1006, "closed after error");
    await stream.closed;

    const openError = await opened;
    expect(openError).toBeInstanceOf(Error);
    expect(openError.message).toBe("tls failure");
    expect(errors).toEqual(["websocket_error:tls failure"]);
    expect(metrics.filter((name) => name === "cartesia_tts_provider_error")).toHaveLength(1);
  });

  test("emits completion after done and closes the provider socket", () => {
    const { adapter, socket } = makeHarness();
    const completions: number[] = [];
    adapter
      .createStream(
        { contextId: "ctx-1" },
        { onComplete: (event) => completions.push(event.frameCount) },
      )
      .sendPhrase({ text: "Done.", continueContext: false });
    socket().emitOpen();

    socket().emitMessage(chunk(new Uint8Array([9])));
    socket().emitMessage(
      JSON.stringify({
        type: "done",
        done: true,
        status_code: 206,
        context_id: "ctx-1",
      }),
    );

    expect(completions).toEqual([1]);
    expect(socket().closes.at(-1)).toEqual({
      code: 1000,
      reason: "Cartesia context complete",
    });
  });

  test("emits provider errors without fabricating completion", () => {
    const { adapter, metrics, socket } = makeHarness();
    const errors: string[] = [];
    const completions: number[] = [];
    adapter.createStream(
      { contextId: "ctx-1" },
      {
        onProviderError: (event) => errors.push(`${event.code}:${event.message}`),
        onComplete: (event) => completions.push(event.frameCount),
      },
    );
    socket().emitOpen();

    socket().emitMessage(
      JSON.stringify({
        type: "error",
        done: true,
        title: "Invalid voice",
        message: "Voice not found",
        error_code: "voice_not_found",
        status_code: 400,
        request_id: "req-1",
        context_id: "ctx-1",
      }),
    );

    expect(errors).toEqual(["voice_not_found:Voice not found"]);
    expect(completions).toEqual([]);
    expect(metrics).toContain("cartesia_tts_provider_error");
    expect(socket().closes.at(-1)).toEqual({
      code: 1011,
      reason: "Cartesia provider error",
    });
  });

  test("rejects malformed chunk frames inside message handling and closes the socket", () => {
    const { adapter, metrics, socket } = makeHarness();
    const errors: string[] = [];
    const firstAudio: number[] = [];
    const frames: number[] = [];
    adapter.createStream(
      { contextId: "ctx-1", traceId: "trace-malformed-chunk" },
      {
        onProviderError: (event) => errors.push(`${event.code}:${event.message}`),
        onFirstAudio: (event) => firstAudio.push(event.elapsedMs),
        onAudioFrame: (event) => frames.push(event.sequence),
      },
    );
    socket().emitOpen();

    socket().emitMessage(
      JSON.stringify({
        type: "chunk",
        data: "not-base64",
        done: false,
        context_id: "ctx-1",
      }),
    );

    expect(errors).toEqual([
      "PROVIDER_CHUNK_DATA_INVALID_BASE64:Cartesia chunk message has invalid base64 audio data",
    ]);
    expect(firstAudio).toEqual([]);
    expect(frames).toEqual([]);
    expect(metrics.filter((name) => name === "cartesia_tts_provider_error")).toHaveLength(1);
    expect(socket().closes.at(-1)).toEqual({
      code: 1011,
      reason: "Invalid Cartesia provider message",
    });
  });

  test("cancels by context and suppresses all post-cancel audio callbacks", () => {
    const { adapter, metrics, socket } = makeHarness();
    const cancellations: string[] = [];
    const frames: number[] = [];
    const stream = adapter.createStream(
      { contextId: "ctx-1", traceId: "trace-cancel" },
      {
        onCancelled: (event) => cancellations.push(event.reason ?? ""),
        onAudioFrame: (event) => frames.push(event.sequence),
      },
    );
    socket().emitOpen();

    stream.cancel("barge-in");
    socket().emitMessage(chunk(new Uint8Array([1, 2, 3])));

    expect(JSON.parse(socket().sent[0])).toEqual({
      context_id: "ctx-1",
      cancel: true,
    });
    expect(cancellations).toEqual(["barge-in"]);
    expect(frames).toEqual([]);
    expect(metrics).toContain("cartesia_tts_cancelled");
    expect(socket().closes.at(-1)).toEqual({ code: 1000, reason: "barge-in" });
  });

  test("rejects missing server key and invalid Cartesia voice IDs", () => {
    const { adapter } = makeHarness();
    expect(adapter.metadata.modelId).toBe(CARTESIA_SONIC_MODEL_ID);
    expect(
      () =>
        new CartesiaSonicTtsAdapter({
          apiKey: " ",
          voiceId: VOICE_ID,
          websocketFactory: () => new FakeCartesiaWebSocket(),
        }),
    ).toThrow("CARTESIA_API_KEY is required");
    expect(
      () =>
        new CartesiaSonicTtsAdapter({
          apiKey: "cartesia-server-key",
          voiceId: "not-a-uuid",
          websocketFactory: () => new FakeCartesiaWebSocket(),
        }),
    ).toThrow("Cartesia voiceId must be a UUID");
  });
});

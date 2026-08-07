/**
 * Unit coverage for the Cartesia Ink realtime adapter with an injected socket
 * transport. Protocol mapping, credentials, PCM framing, draining, and cleanup
 * run through production adapter code without opening a provider connection.
 */

import { describe, expect, it } from "bun:test";
import {
  buildCartesiaInkUrl,
  CARTESIA_INK_API_VERSION,
  CARTESIA_INK_CHUNK_BYTES,
  CARTESIA_INK_MODEL_ID,
  CARTESIA_INK_WEBSOCKET_URL,
  CartesiaInkAudioChunkError,
  CartesiaInkConfigError,
  CartesiaInkConnectionError,
  type CartesiaInkMetric,
  type CartesiaInkRealtimeEvent,
  type CartesiaInkTransportRequest,
  type CartesiaInkWebSocket,
  type CartesiaInkWebSocketEventMap,
  createCartesiaInkRealtimeSession,
  mapCartesiaInkMessage,
  resolveCartesiaInkConfig,
  validateCartesiaInkAudioChunk,
} from "./cartesia-ink";

class FakeCartesiaInkSocket implements CartesiaInkWebSocket {
  readyState = 1;
  binaryType?: BinaryType;
  sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  listeners = {
    open: new Set<(event: Event) => void>(),
    message: new Set<(event: MessageEvent) => void>(),
    error: new Set<(event: Event) => void>(),
    close: new Set<(event: CloseEvent) => void>(),
  };

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  addEventListener<K extends keyof CartesiaInkWebSocketEventMap>(
    type: K,
    listener: (event: CartesiaInkWebSocketEventMap[K]) => void,
  ): void {
    this.listeners[type].add(listener as never);
  }

  removeEventListener<K extends keyof CartesiaInkWebSocketEventMap>(
    type: K,
    listener: (event: CartesiaInkWebSocketEventMap[K]) => void,
  ): void {
    this.listeners[type].delete(listener as never);
  }

  emitOpen(): void {
    for (const listener of this.listeners.open) listener(new Event("open"));
  }

  emitMessage(data: string): void {
    for (const listener of this.listeners.message) {
      listener(new MessageEvent("message", { data }));
    }
  }

  emitError(): void {
    for (const listener of this.listeners.error) listener(new Event("error"));
  }

  emitClose(code: number, reason: string, wasClean: boolean): void {
    for (const listener of this.listeners.close) {
      listener(new CloseEvent("close", { code, reason, wasClean }));
    }
  }
}

function createHarness() {
  const socket = new FakeCartesiaInkSocket();
  const requests: CartesiaInkTransportRequest[] = [];
  const events: CartesiaInkRealtimeEvent[] = [];
  const metrics: CartesiaInkMetric[] = [];
  const session = createCartesiaInkRealtimeSession({
    cartesiaApiKey: "cartesia-secret",
    webSocketFactory(request) {
      requests.push(request);
      return socket;
    },
    hooks: { onMetric: (metric) => metrics.push(metric) },
    onEvent: (event) => events.push(event),
  });
  return { events, metrics, requests, session, socket };
}

describe("Cartesia Ink realtime adapter", () => {
  it("builds the Ink-2 auto-finalize URL for 16kHz PCM16", () => {
    const config = resolveCartesiaInkConfig({
      cartesiaApiKey: " cartesia-secret ",
    });
    const url = new URL(buildCartesiaInkUrl(config));

    expect(url.origin + url.pathname).toBe(CARTESIA_INK_WEBSOCKET_URL);
    expect(url.searchParams.get("model")).toBe(CARTESIA_INK_MODEL_ID);
    expect(url.searchParams.get("encoding")).toBe("pcm_s16le");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("cartesia_version")).toBe(
      CARTESIA_INK_API_VERSION,
    );
  });

  it("keeps the server API key in headers and out of the URL", () => {
    const { requests, socket } = createHarness();

    expect(requests).toHaveLength(1);
    expect(requests[0].headers["X-API-Key"]).toBe("cartesia-secret");
    expect(requests[0].headers["Cartesia-Version"]).toBe(
      CARTESIA_INK_API_VERSION,
    );
    expect(requests[0].url).not.toContain("cartesia-secret");
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("maps the complete native turn lifecycle", () => {
    const { events, socket } = createHarness();
    for (const event of [
      { type: "connected", request_id: "request-1" },
      { type: "turn.start", request_id: "request-1" },
      {
        type: "turn.update",
        request_id: "request-1",
        transcript: "hello",
      },
      {
        type: "turn.eager_end",
        request_id: "request-1",
        transcript: "hello there",
      },
      { type: "turn.resume", request_id: "request-1" },
      {
        type: "turn.end",
        request_id: "request-1",
        transcript: "hello there",
      },
    ]) {
      socket.emitMessage(JSON.stringify(event));
    }

    expect(events).toMatchObject([
      { type: "connected", requestId: "request-1" },
      { type: "start-of-turn", transcript: "" },
      { type: "transcript-update", transcript: "hello" },
      { type: "eager-end-of-turn", transcript: "hello there" },
      { type: "turn-resumed", transcript: "" },
      { type: "end-of-turn", transcript: "hello there" },
    ]);
  });

  it("maps provider and malformed messages to explicit errors", () => {
    expect(
      mapCartesiaInkMessage(
        JSON.stringify({
          type: "error",
          error_code: "model_not_found",
          message: "invalid model",
        }),
      ),
    ).toMatchObject({
      type: "error",
      code: "model_not_found",
      message: "invalid model",
    });
    expect(mapCartesiaInkMessage("{not json")).toMatchObject({
      type: "error",
      code: "malformed_event",
    });
    expect(
      mapCartesiaInkMessage(JSON.stringify({ type: "turn.update" })),
    ).toMatchObject({ type: "error", code: "malformed_event" });
    expect(
      mapCartesiaInkMessage(JSON.stringify({ type: "mystery" })),
    ).toMatchObject({ type: "error", code: "malformed_event" });
  });

  it("validates and sends exact 100ms PCM chunks", () => {
    const { metrics, session, socket } = createHarness();
    const chunk = new Uint8Array(CARTESIA_INK_CHUNK_BYTES);

    validateCartesiaInkAudioChunk(chunk);
    session.sendAudioChunk(chunk);

    expect(socket.sent).toEqual([chunk]);
    expect(metrics).toContainEqual({
      name: "cartesia_ink_audio_chunk_sent",
      value: 1,
    });
    expect(() => session.sendAudioChunk(new Uint8Array(3_199))).toThrow(
      CartesiaInkAudioChunkError,
    );
  });

  it("drains provider events after the close command", () => {
    const { events, session, socket } = createHarness();

    session.close();
    session.close();
    socket.emitMessage(
      JSON.stringify({ type: "turn.end", transcript: "final words" }),
    );

    expect(socket.sent).toEqual([JSON.stringify({ type: "close" })]);
    expect(() =>
      session.sendAudioChunk(new Uint8Array(CARTESIA_INK_CHUNK_BYTES)),
    ).toThrow(CartesiaInkConnectionError);
    expect(events).toMatchObject([
      { type: "end-of-turn", transcript: "final words" },
    ]);

    socket.emitClose(1000, "finished", true);
    expect(events).toMatchObject([
      { type: "end-of-turn", transcript: "final words" },
      { type: "close", code: 1000, reason: "finished", wasClean: true },
    ]);
    expect(socket.listeners.message.size).toBe(0);
  });

  it("cancels idempotently and removes protocol listeners", () => {
    const controller = new AbortController();
    const socket = new FakeCartesiaInkSocket();
    const events: CartesiaInkRealtimeEvent[] = [];
    const session = createCartesiaInkRealtimeSession({
      cartesiaApiKey: "cartesia-secret",
      signal: controller.signal,
      webSocketFactory: () => socket,
      onEvent: (event) => events.push(event),
    });

    controller.abort();
    session.cancel("second-cancel");
    socket.emitMessage(JSON.stringify({ type: "turn.start" }));

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "cancelled" }]);
    expect(events).toMatchObject([
      { type: "close", code: 1000, reason: "cancelled", wasClean: true },
    ]);
    expect(socket.listeners.message.size).toBe(0);
    expect(() =>
      session.sendAudioChunk(new Uint8Array(CARTESIA_INK_CHUNK_BYTES)),
    ).toThrow(CartesiaInkConnectionError);
  });

  it("surfaces metrics hook, transport error, and transport close events", () => {
    const socket = new FakeCartesiaInkSocket();
    const events: CartesiaInkRealtimeEvent[] = [];
    const session = createCartesiaInkRealtimeSession({
      cartesiaApiKey: "cartesia-secret",
      webSocketFactory: () => socket,
      hooks: {
        onMetric() {
          throw new Error("metrics unavailable");
        },
      },
      onEvent: (event) => events.push(event),
    });

    expect(() =>
      session.sendAudioChunk(new Uint8Array(CARTESIA_INK_CHUNK_BYTES)),
    ).not.toThrow();
    socket.emitError();
    socket.emitClose(1011, "upstream-failed", false);

    expect(events).toMatchObject([
      { type: "error", code: "metrics_hook_error" },
      { type: "error", code: "transport_error" },
      { type: "error", code: "metrics_hook_error" },
      {
        type: "close",
        code: 1011,
        reason: "upstream-failed",
        wasClean: false,
      },
    ]);
  });

  it("fails fast for missing keys, unsupported models, and invalid URLs", () => {
    expect(() => resolveCartesiaInkConfig({})).toThrow(CartesiaInkConfigError);
    expect(() =>
      resolveCartesiaInkConfig({
        cartesiaApiKey: "cartesia-secret",
        model: "ink-future",
      }),
    ).toThrow(CartesiaInkConfigError);
    expect(() =>
      resolveCartesiaInkConfig({
        cartesiaApiKey: "cartesia-secret",
        baseUrl: "https://api.cartesia.ai/stt/turns/websocket",
      }),
    ).toThrow(CartesiaInkConfigError);
  });
});

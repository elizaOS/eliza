/**
 * Unit coverage for the server-side Deepgram Flux realtime adapter. The harness
 * injects a minimal WebSocket transport so protocol mapping, cancellation,
 * cleanup, config, and 80ms audio framing are tested without opening a network
 * connection or importing the STT route's billing graph.
 */

import { describe, expect, it } from "bun:test";
import {
  buildDeepgramFluxListenUrl,
  createDeepgramFluxRealtimeSession,
  DEEPGRAM_FLUX_CHUNK_BYTES,
  DEEPGRAM_FLUX_DEFAULT_MODEL,
  DEEPGRAM_FLUX_LISTEN_URL,
  DeepgramFluxAudioChunkError,
  DeepgramFluxConfigError,
  DeepgramFluxConnectionError,
  type DeepgramFluxMetric,
  type DeepgramFluxRealtimeEvent,
  type DeepgramFluxTransportRequest,
  type DeepgramFluxWebSocket,
  type DeepgramFluxWebSocketEventMap,
  mapDeepgramFluxMessage,
  resolveDeepgramFluxConfig,
  validateDeepgramFluxAudioChunk,
} from "./deepgram-flux";

class FakeDeepgramFluxWebSocket implements DeepgramFluxWebSocket {
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

  addEventListener<K extends keyof DeepgramFluxWebSocketEventMap>(
    type: K,
    listener: (event: DeepgramFluxWebSocketEventMap[K]) => void,
  ): void {
    this.listeners[type].add(listener as never);
  }

  removeEventListener<K extends keyof DeepgramFluxWebSocketEventMap>(
    type: K,
    listener: (event: DeepgramFluxWebSocketEventMap[K]) => void,
  ): void {
    this.listeners[type].delete(listener as never);
  }

  emitOpen(): void {
    for (const listener of this.listeners.open) {
      listener(new Event("open"));
    }
  }

  emitMessage(data: string): void {
    for (const listener of this.listeners.message) {
      listener(new MessageEvent("message", { data }));
    }
  }

  emitError(): void {
    for (const listener of this.listeners.error) {
      listener(new Event("error"));
    }
  }

  emitClose(code: number, reason: string, wasClean: boolean): void {
    for (const listener of this.listeners.close) {
      listener(new CloseEvent("close", { code, reason, wasClean }));
    }
  }
}

function createHarness() {
  const socket = new FakeDeepgramFluxWebSocket();
  const requests: DeepgramFluxTransportRequest[] = [];
  const events: DeepgramFluxRealtimeEvent[] = [];
  const metrics: DeepgramFluxMetric[] = [];
  const session = createDeepgramFluxRealtimeSession({
    deepgramApiKey: "dg-secret",
    webSocketFactory(request) {
      requests.push(request);
      return socket;
    },
    hooks: {
      onMetric(metric) {
        metrics.push(metric);
      },
    },
    onEvent(event) {
      events.push(event);
    },
  });

  return { events, metrics, requests, session, socket };
}

describe("Deepgram Flux realtime adapter", () => {
  it("builds the /v2/listen URL with raw linear16 mono 16kHz Flux parameters", () => {
    const config = resolveDeepgramFluxConfig({
      deepgramApiKey: " dg-secret ",
      eagerEotThreshold: "0.4",
      eotThreshold: 0.9,
      eotTimeoutMs: "1500",
    });
    const url = new URL(buildDeepgramFluxListenUrl(config));

    expect(url.origin + url.pathname).toBe(DEEPGRAM_FLUX_LISTEN_URL);
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("channels")).toBe("1");
    expect(url.searchParams.get("model")).toBe(DEEPGRAM_FLUX_DEFAULT_MODEL);
    expect(url.searchParams.get("eager_eot_threshold")).toBe("0.4");
    expect(url.searchParams.get("eot_threshold")).toBe("0.9");
    expect(url.searchParams.get("eot_timeout_ms")).toBe("1500");
  });

  it("passes the server-side API key by Authorization header and never in the query URL", () => {
    const { requests, socket } = createHarness();

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.Authorization).toBe("Token dg-secret");
    expect(requests[0].url).not.toContain("dg-secret");
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("maps Flux turn and transcript events", () => {
    const { events, socket } = createHarness();

    socket.emitMessage(
      JSON.stringify({
        type: "TurnInfo",
        event: "StartOfTurn",
        request_id: "request-1",
        sequence_id: 1,
        turn_index: 0,
        words: [],
      }),
    );
    socket.emitMessage(
      JSON.stringify({
        type: "TurnInfo",
        event: "Update",
        request_id: "request-1",
        sequence_id: 2,
        turn_index: 0,
        transcript: "hello",
        words: [{ word: "hello" }],
        end_of_turn_confidence: 0.42,
      }),
    );
    socket.emitMessage(
      JSON.stringify({
        type: "TurnInfo",
        event: "EndOfTurn",
        request_id: "request-1",
        sequence_id: 3,
        turn_index: 0,
        transcript: "hello",
        words: [{ word: "hello" }],
        end_of_turn_confidence: 0.91,
      }),
    );

    expect(events).toMatchObject([
      { type: "start-of-turn", requestId: "request-1", transcript: "" },
      {
        type: "transcript-update",
        transcript: "hello",
        sequenceId: 2,
        endOfTurnConfidence: 0.42,
      },
      { type: "end-of-turn", transcript: "hello" },
    ]);
  });

  it("maps eager end of turn and resumed turn without local VAD state", () => {
    const { events, socket } = createHarness();

    socket.emitMessage(
      JSON.stringify({
        type: "TurnInfo",
        event: "EagerEndOfTurn",
        transcript: "hello",
        words: [],
      }),
    );
    socket.emitMessage(
      JSON.stringify({
        type: "TurnInfo",
        event: "TurnResumed",
        transcript: "hello again",
        words: [],
      }),
    );

    expect(events).toMatchObject([
      { type: "eager-end-of-turn" },
      { type: "turn-resumed" },
    ]);
  });

  it("maps Deepgram error frames and malformed frames as explicit error events", () => {
    expect(
      mapDeepgramFluxMessage(
        JSON.stringify({
          type: "Error",
          code: "BAD_REQUEST",
          message: "bad query",
        }),
      ),
    ).toMatchObject({
      type: "error",
      code: "BAD_REQUEST",
      message: "bad query",
    });

    expect(mapDeepgramFluxMessage("{not json")).toMatchObject({
      type: "error",
      code: "malformed_event",
    });
    expect(
      mapDeepgramFluxMessage(
        JSON.stringify({ type: "TurnInfo", event: "Update", words: [] }),
      ),
    ).toMatchObject({
      type: "error",
      code: "malformed_event",
    });
    expect(
      mapDeepgramFluxMessage(
        JSON.stringify({ type: "TurnInfo", event: "Mystery", transcript: "" }),
      ),
    ).toMatchObject({
      type: "error",
      code: "malformed_event",
    });
  });

  it("surfaces metrics hook failures without breaking the streaming data path", () => {
    const socket = new FakeDeepgramFluxWebSocket();
    const events: DeepgramFluxRealtimeEvent[] = [];
    const session = createDeepgramFluxRealtimeSession({
      deepgramApiKey: "dg-secret",
      webSocketFactory: () => socket,
      hooks: {
        onMetric() {
          throw new Error("metrics unavailable");
        },
      },
      onEvent(event) {
        events.push(event);
      },
    });

    expect(() =>
      session.sendAudioChunk(new Uint8Array(DEEPGRAM_FLUX_CHUNK_BYTES)),
    ).not.toThrow();
    expect(events).toMatchObject([
      { type: "error", code: "metrics_hook_error" },
    ]);
  });

  it("validates 80ms linear16 mono 16kHz chunks before sending", () => {
    const { metrics, session, socket } = createHarness();
    const chunk = new Uint8Array(DEEPGRAM_FLUX_CHUNK_BYTES);

    validateDeepgramFluxAudioChunk(chunk);
    session.sendAudioChunk(chunk);

    expect(socket.sent).toEqual([chunk]);
    expect(metrics).toContainEqual({
      name: "deepgram_flux_audio_chunk_sent",
      value: 1,
    });
    expect(() => session.sendAudioChunk(new Uint8Array(2_559))).toThrow(
      DeepgramFluxAudioChunkError,
    );
  });

  it("keeps listening for final Flux events after a graceful close request", () => {
    const { events, session, socket } = createHarness();

    session.close("finished");
    session.close("ignored");
    socket.emitMessage(
      JSON.stringify({
        type: "TurnInfo",
        event: "EndOfTurn",
        transcript: "final words",
        words: [],
      }),
    );

    expect(socket.sent).toEqual([JSON.stringify({ type: "CloseStream" })]);
    expect(() =>
      session.sendAudioChunk(new Uint8Array(DEEPGRAM_FLUX_CHUNK_BYTES)),
    ).toThrow(DeepgramFluxConnectionError);
    expect(socket.closeCalls).toEqual([]);
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

  it("cancels and cleans up idempotently", () => {
    const controller = new AbortController();
    const socket = new FakeDeepgramFluxWebSocket();
    const events: DeepgramFluxRealtimeEvent[] = [];
    const session = createDeepgramFluxRealtimeSession({
      deepgramApiKey: "dg-secret",
      signal: controller.signal,
      webSocketFactory: () => socket,
      onEvent: (event) => events.push(event),
    });

    controller.abort();
    session.cancel("second-cancel");
    socket.emitMessage(
      JSON.stringify({
        type: "TurnInfo",
        event: "StartOfTurn",
        transcript: "",
      }),
    );
    socket.emitClose(1000, "late-close", true);

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "cancelled" }]);
    expect(events).toMatchObject([
      { type: "close", code: 1000, reason: "cancelled", wasClean: true },
    ]);
    expect(() =>
      session.sendAudioChunk(new Uint8Array(DEEPGRAM_FLUX_CHUNK_BYTES)),
    ).toThrow(DeepgramFluxConnectionError);
    expect(socket.listeners.message.size).toBe(0);
    expect(socket.listeners.close.size).toBe(0);
  });

  it("maps transport close and error events", () => {
    const { events, metrics, socket } = createHarness();

    socket.emitError();
    socket.emitClose(1011, "upstream-failed", false);

    expect(events).toMatchObject([
      { type: "error", code: "transport_error" },
      {
        type: "close",
        code: 1011,
        reason: "upstream-failed",
        wasClean: false,
      },
    ]);
    expect(metrics).toContainEqual({
      name: "deepgram_flux_closed",
      value: 1,
      tags: { code: "1011" },
    });
  });

  it("fails fast for missing key, unsupported model, invalid /v2/listen URL, and invalid tunables", () => {
    expect(() => resolveDeepgramFluxConfig({})).toThrow(
      DeepgramFluxConfigError,
    );
    expect(() =>
      resolveDeepgramFluxConfig({
        deepgramApiKey: "dg-secret",
        model: "nova-3",
      }),
    ).toThrow(DeepgramFluxConfigError);
    expect(() =>
      resolveDeepgramFluxConfig({
        deepgramApiKey: "dg-secret",
        baseUrl: "https://api.deepgram.com/v2/listen",
      }),
    ).toThrow(DeepgramFluxConfigError);
    expect(() =>
      resolveDeepgramFluxConfig({
        deepgramApiKey: "dg-secret",
        baseUrl: "not a url",
      }),
    ).toThrow(DeepgramFluxConfigError);
    expect(() =>
      resolveDeepgramFluxConfig({
        deepgramApiKey: "dg-secret",
        baseUrl: "wss://api.deepgram.com/v1/listen",
      }),
    ).toThrow(DeepgramFluxConfigError);
    expect(
      resolveDeepgramFluxConfig({
        deepgramApiKey: "dg-secret",
        eagerEotThreshold: " ",
        eotThreshold: "",
        eotTimeoutMs: "  ",
      }),
    ).toMatchObject({
      eagerEotThreshold: 0.35,
      eotThreshold: 0.8,
      eotTimeoutMs: 5_000,
    });
    expect(() =>
      resolveDeepgramFluxConfig({
        deepgramApiKey: "dg-secret",
        eotThreshold: 0.49,
      }),
    ).toThrow(DeepgramFluxConfigError);
    expect(() =>
      resolveDeepgramFluxConfig({
        deepgramApiKey: "dg-secret",
        eagerEotThreshold: 0.9,
        eotThreshold: 0.8,
      }),
    ).toThrow(DeepgramFluxConfigError);
    expect(() =>
      resolveDeepgramFluxConfig({
        deepgramApiKey: "dg-secret",
        eotTimeoutMs: 10_001,
      }),
    ).toThrow(DeepgramFluxConfigError);
  });
});

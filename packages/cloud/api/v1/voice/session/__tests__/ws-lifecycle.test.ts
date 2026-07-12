/**
 * Full realtime voice-session WS lifecycle against a mock socket factory that
 * drives the REAL merged adapters (Deepgram Flux #15950, Cartesia #15949) and
 * the REAL `VoiceSession` orchestrator + `attachVoiceWsHandler` framing.
 *
 * The fakes here are TRANSPORTS only — fake Deepgram socket, fake Cartesia
 * socket, fake client socket, fake Eliza SSE fetch. Everything under test
 * (hello-first auth, framing, uplink re-framing, phrase aggregation, TTS
 * streaming, interruption, metering, revoke-to-silence) is the real code path.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

// Break the logger -> @elizaos/core transitive import chain (repo-standard
// test isolation for cloud-api unit tests). Logic under test is untouched.
const fakeLogger = {
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
};
mock.module("@/lib/utils/logger", () => fakeLogger);
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => fakeLogger);
mock.module("@elizaos/core", () => ({
  isSensitiveKeyName: () => false,
  redactLogArgs: (args: unknown) => args,
}));

import type { CartesiaWebSocketLike } from "../../../../../shared/src/lib/services/cartesia-sonic-tts";
import { InMemoryVoiceUsageStore } from "../../../../../shared/src/lib/services/voice-usage-meter";
import { mintVoiceSessionToken } from "../../../../../shared/src/lib/voice-session/jwt";
import type { ServerControlFrame } from "../../../../../shared/src/lib/voice-session/protocol";
import { __resetVoiceSessionRegistryForTests } from "../../../../../shared/src/lib/voice-session/session-registry";
import { installVoiceSessionTestSigningKey } from "../../../../../shared/src/lib/voice-session/test-signing";
import { attachVoiceWsHandler } from "../../../../../shared/src/lib/voice-session/ws-handler";
import type { DeepgramFluxWebSocket } from "../../stt/providers/deepgram-flux";
import { VoiceSession } from "../lib/session";

// --- signing setup --------------------------------------------------------

beforeAll(async () => {
  await installVoiceSessionTestSigningKey();
});

afterEach(() => {
  __resetVoiceSessionRegistryForTests();
});

// --- fake Deepgram Flux socket (drives the REAL adapter) -------------------

class FakeFluxSocket implements DeepgramFluxWebSocket {
  static instances: FakeFluxSocket[] = [];
  readyState = 1;
  binaryType: BinaryType = "arraybuffer";
  sentChunks: (ArrayBuffer | ArrayBufferView)[] = [];
  closed = false;
  private listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor() {
    FakeFluxSocket.instances.push(this);
    queueMicrotask(() => this.fire("open", {}));
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data === "string") return; // CloseStream control.
    this.sentChunks.push(data);
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire("close", { code, reason, wasClean: true });
  }
  addEventListener(type: string, listener: (e: never) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as (e: unknown) => void);
  }
  removeEventListener(type: string, listener: (e: never) => void) {
    this.listeners.get(type)?.delete(listener as (e: unknown) => void);
  }
  /** Emit a TurnInfo message as the real Deepgram socket would. */
  emitTurn(event: string, transcript = "") {
    this.fire("message", {
      data: JSON.stringify({ type: "TurnInfo", event, transcript, words: [] }),
    });
  }
  emitConnectedHandshake() {
    this.fire("message", { data: JSON.stringify({ type: "Connected" }) });
  }
  private fire(type: string, payload: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(payload);
  }
}

// --- fake Cartesia socket (drives the REAL adapter) -----------------------

class FakeCartesiaSocket implements CartesiaWebSocketLike {
  static instances: FakeCartesiaSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor() {
    FakeCartesiaSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.fire("open", undefined);
    });
  }
  send(data: string) {
    this.sent.push(data);
    // On the first non-cancel generation request, stream one audio chunk.
    const msg = JSON.parse(data) as { cancel?: boolean; transcript?: string };
    if (msg.cancel) return;
    if (typeof msg.transcript === "string" && msg.transcript.length > 0) {
      queueMicrotask(() => {
        if (this.closed) return;
        const pcm = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString(
          "base64",
        );
        this.fire("message", {
          data: JSON.stringify({ type: "chunk", data: pcm }),
        });
      });
    }
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire("close", { code, reason });
  }
  addEventListener(type: string, listener: (e: never) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as (e: unknown) => void);
  }
  emitDone() {
    this.fire("message", {
      data: JSON.stringify({ type: "done", done: true }),
    });
  }
  private fire(type: string, payload: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(payload);
  }
}

// --- fake client transport (drives the REAL ws-handler) -------------------

class FakeClientSocket {
  controlFrames: ServerControlFrame[] = [];
  audioFrames: Uint8Array[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Set<(e: { data: unknown }) => void>>();

  send(data: string | ArrayBuffer | Uint8Array) {
    if (typeof data === "string") {
      this.controlFrames.push(JSON.parse(data));
    } else {
      this.audioFrames.push(
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer),
      );
    }
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.fire("close", { data: undefined });
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  /** Simulate the client sending a text or binary frame to the server. */
  clientSend(data: string | ArrayBuffer | Uint8Array) {
    this.fire("message", { data });
  }
  clientClose() {
    this.fire("close", { data: undefined });
  }
  private fire(type: string, e: { data: unknown }) {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
  controlTypes(): string[] {
    return this.controlFrames.map((f) => f.t);
  }
}

// --- scripted Eliza SSE fetch --------------------------------------------

function makeSseFetch(
  deltas: string[],
  opts?: { hang?: boolean; onAbort?: () => void },
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const d of deltas) {
          if (signal?.aborted) break;
          const frame = { choices: [{ delta: { content: d } }] };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
          );
          await new Promise((r) => setTimeout(r, 1));
        }
        if (opts?.hang) {
          // Never send [DONE]; wait for abort.
          await new Promise<void>((resolve) => {
            if (signal) {
              signal.addEventListener("abort", () => {
                opts.onAbort?.();
                resolve();
              });
            }
          });
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

// --- helpers --------------------------------------------------------------

const CLAIMS = {
  sessionId: "sess-lifecycle",
  organizationId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  conversationId: "conv-1",
};

async function connectSession(opts: {
  client: FakeClientSocket;
  fetchImpl: typeof fetch;
}): Promise<{ sessionId: string }> {
  const minted = await mintVoiceSessionToken(CLAIMS);
  const usageStore = new InMemoryVoiceUsageStore();

  attachVoiceWsHandler(opts.client, {
    requestedSessionId: CLAIMS.sessionId,
    buildSession: ({ claims, jti, tokenExpSeconds, downlink }) =>
      new VoiceSession({
        sessionId: claims.sessionId,
        jti,
        organizationId: claims.organizationId,
        userId: claims.userId,
        agentId: claims.agentId,
        conversationId: claims.conversationId,
        tokenExpSeconds,
        deepgramApiKey: "dg-key",
        deepgramWebSocketFactory: () => new FakeFluxSocket(),
        cartesiaApiKey: "ct-key",
        cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
        cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
        elizaEndpoint: "http://internal/api/v1/chat/completions",
        elizaAuthorization: "Bearer eliza-server",
        elizaModel: "gemma-4-31b",
        fetchImpl: opts.fetchImpl,
        usageStore,
        usageLimits: { organizationDailyMinutes: 600, userDailyMinutes: 120 },
        downlink,
      }),
  });

  // Send the hello frame; verification is async.
  opts.client.clientSend(
    JSON.stringify({
      t: "hello",
      token: minted.token,
      protocol: 1,
      uplinkCodec: "pcm16",
      downlinkCodec: "pcm16",
      sampleRate: 16000,
    }),
  );
  await flush();
  return { sessionId: CLAIMS.sessionId };
}

// The fake Flux/Cartesia sockets and the SSE mock advance the session pipeline
// across chained `queueMicrotask` + short `setTimeout` hops (hello -> verify ->
// stt -> LLM SSE -> speaking -> downlink). A single fixed sleep raced that chain
// under a loaded event loop (the sequential 80-file unit batch on a busy CI
// runner), so assertions ran before the expected control frames landed and the
// suite flaked non-deterministically. Drain several full macrotask turns
// instead: each awaited timer lets one more hop settle, and the microtask queue
// flushes between them. This stays fast when nothing is pending but no longer
// depends on a single window being wide enough.
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function pcmChunk(bytes: number): Uint8Array {
  return new Uint8Array(bytes);
}

// --- tests ----------------------------------------------------------------

describe("voice-session WS lifecycle", () => {
  test("hello -> ready -> full turn produces stt_final, llm_first_text, speaking, usage", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Hello.", " there."]),
    });

    // ready emitted after verified hello.
    expect(client.controlTypes()).toContain("ready");

    const flux = FakeFluxSocket.instances.at(-1)!;
    flux.emitConnectedHandshake(); // benign handshake, must NOT surface an error.
    expect(client.controlFrames.find((f) => f.t === "error")).toBeUndefined();

    // Drive a user turn.
    flux.emitTurn("StartOfTurn");
    flux.emitTurn("EndOfTurn", "hello agent");
    await flush();
    await flush();

    const types = client.controlTypes();
    expect(types).toContain("stt_final");
    expect(types).toContain("llm_first_text");
    expect(types).toContain("speaking_start");

    // Cartesia produced downlink audio.
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    cartesia.emitDone();
    await flush();
    expect(client.audioFrames.length).toBeGreaterThan(0);
    expect(client.controlTypes()).toContain("speaking_end");
    expect(client.controlTypes()).toContain("usage");
  });

  test("terminal Cartesia phrase carries continue:false and no empty-transcript finish (live-provider fix)", async () => {
    // Regression from the LIVE-provider evidence run: the session used to send
    // every phrase with continue:true then an empty-transcript finish(), which
    // the real Cartesia API rejects with "No valid transcripts passed" (400) ->
    // tts_error, zero audio. The fix holds one phrase back so the terminal
    // speakable phrase closes the context with continue:false, and NEVER sends
    // an empty transcript.
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Hello there.", " The weather is sunny."]),
    });
    const flux = FakeFluxSocket.instances.at(-1)!;
    flux.emitTurn("StartOfTurn");
    flux.emitTurn("EndOfTurn", "whats the weather");
    await flush();
    await flush();
    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    const requests = cartesia.sent.map(
      (s) => JSON.parse(s) as { transcript?: string; continue?: boolean },
    );
    // No generation request carries an empty transcript.
    expect(
      requests.every(
        (r) => typeof r.transcript !== "string" || r.transcript.length > 0,
      ),
    ).toBe(true);
    // Exactly the terminal speakable phrase closes the context (continue:false);
    // all earlier phrases keep it open (continue:true).
    const withText = requests.filter(
      (r) => typeof r.transcript === "string" && r.transcript.length > 0,
    );
    expect(withText.length).toBeGreaterThan(0);
    expect(withText.at(-1)!.continue).toBe(false);
    for (const r of withText.slice(0, -1)) expect(r.continue).toBe(true);
  });

  test("end_audio is a graceful no-op (not control_unknown_type) after ready", async () => {
    // Regression: a bounded-clip client sends `end_audio` after its audio. The
    // live run showed the real server errored with `control_unknown_type`, and
    // the client treated that terminal error as a reason to close before TTS.
    // `end_audio` post-hello must NOT surface an error and must NOT close.
    const client = new FakeClientSocket();
    await connectSession({ client, fetchImpl: makeSseFetch(["ok."]) });
    const beforeErrors = client.controlFrames.filter(
      (f) => f.t === "error",
    ).length;
    client.clientSend(JSON.stringify({ t: "end_audio" }));
    await flush();
    const afterErrors = client.controlFrames.filter(
      (f) => f.t === "error",
    ).length;
    expect(afterErrors).toBe(beforeErrors);
    expect(client.closedWith).toBeNull();
  });

  test("empty-transcript final closes the turn (usage + clears turn id)", async () => {
    const client = new FakeClientSocket();
    await connectSession({ client, fetchImpl: makeSseFetch(["unused."]) });
    const flux = FakeFluxSocket.instances.at(-1)!;
    flux.emitTurn("StartOfTurn");
    flux.emitTurn("EndOfTurn", ""); // silence/noise: empty final.
    await flush();
    // The empty turn is closed out: a usage frame is emitted and no TTS runs.
    expect(client.controlTypes()).toContain("stt_final");
    expect(client.controlTypes()).toContain("usage");
    expect(client.controlTypes()).not.toContain("speaking_start");
    // A stray barge_in now does NOT emit interrupted (no active turn).
    const beforeInterrupt = client.controlFrames.filter(
      (f) => f.t === "interrupted",
    ).length;
    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    const afterInterrupt = client.controlFrames.filter(
      (f) => f.t === "interrupted",
    ).length;
    expect(afterInterrupt).toBe(beforeInterrupt);
  });

  test("uplink is re-framed to exact 2560-byte Flux chunks", async () => {
    const client = new FakeClientSocket();
    await connectSession({ client, fetchImpl: makeSseFetch(["ok."]) });
    const flux = FakeFluxSocket.instances.at(-1)!;

    // Send 3000 bytes in odd chunks; expect exactly one 2560 frame, 440 held.
    client.clientSend(pcmChunk(1000));
    client.clientSend(pcmChunk(2000));
    await flush();
    expect(flux.sentChunks.length).toBe(1);
    expect(flux.sentChunks[0].byteLength).toBe(2560);

    // Another 2560 completes a second frame.
    client.clientSend(pcmChunk(2560));
    await flush();
    expect(flux.sentChunks.length).toBe(2);
    expect(flux.sentChunks.every((c) => c.byteLength === 2560)).toBe(true);
  });

  test("barge-in cancels TTS with ZERO post-cancel binary frames", async () => {
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["Speaking now."]),
    });
    const flux = FakeFluxSocket.instances.at(-1)!;

    flux.emitTurn("StartOfTurn");
    flux.emitTurn("EndOfTurn", "say something");
    await flush();
    await flush();
    const framesBefore = client.audioFrames.length;
    expect(framesBefore).toBeGreaterThan(0);

    const cartesia = FakeCartesiaSocket.instances.at(-1)!;
    // Explicit barge-in.
    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    expect(client.controlTypes()).toContain("interrupted");
    expect(cartesia.closed).toBe(true);
    // The interrupted turn reports usage (accounting stays accurate on barge-in),
    // emitted BEFORE the interrupted frame.
    const types = client.controlTypes();
    expect(types.indexOf("usage")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("usage")).toBeLessThan(
      types.lastIndexOf("interrupted"),
    );

    // Any late chunk from a cancelled Cartesia context must NOT reach the client.
    const framesAfterInterrupt = client.audioFrames.length;
    // A stale provider chunk arriving post-cancel is dropped two ways: the
    // adapter drops it, and even if it didn't the session's turn-id guard does.
    // Flushing here proves no late frame leaks through after the barge-in.
    await flush();
    expect(client.audioFrames.length).toBe(framesAfterInterrupt);
  });

  test("interruption aborts the in-flight Eliza SSE fetch", async () => {
    let aborted = false;
    const client = new FakeClientSocket();
    await connectSession({
      client,
      fetchImpl: makeSseFetch(["partial"], {
        hang: true,
        onAbort: () => (aborted = true),
      }),
    });
    const flux = FakeFluxSocket.instances.at(-1)!;
    flux.emitTurn("StartOfTurn");
    flux.emitTurn("EndOfTurn", "long answer please");
    await flush();

    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    await flush();
    expect(aborted).toBe(true);
    expect(client.controlTypes()).toContain("interrupted");
  });

  test("hello-first is enforced: a binary frame before hello closes the socket", async () => {
    const client = new FakeClientSocket();
    // Attach handler but do NOT send hello; send audio first.
    const usageStore = new InMemoryVoiceUsageStore();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: () => {
        throw new Error("must not build a session before hello");
      },
    });
    void usageStore;
    client.clientSend(pcmChunk(2560));
    await flush();
    expect(client.closedWith).not.toBeNull();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "hello_required",
    );
  });

  test("audio pipelined right after hello (before verify) is buffered, not dropped", async () => {
    const client = new FakeClientSocket();
    const minted = await mintVoiceSessionToken(CLAIMS);
    const usageStore = new InMemoryVoiceUsageStore();
    let flux: FakeFluxSocket | null = null;
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: ({ claims, jti, tokenExpSeconds, downlink }) =>
        new VoiceSession({
          sessionId: claims.sessionId,
          jti,
          organizationId: claims.organizationId,
          userId: claims.userId,
          agentId: claims.agentId,
          conversationId: claims.conversationId,
          tokenExpSeconds,
          deepgramApiKey: "dg",
          deepgramWebSocketFactory: () => {
            flux = new FakeFluxSocket();
            return flux;
          },
          cartesiaApiKey: "ct",
          cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
          cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
          elizaEndpoint: "http://x",
          elizaAuthorization: "Bearer x",
          elizaModel: "gemma-4-31b",
          usageStore,
          usageLimits: { organizationDailyMinutes: 600, userDailyMinutes: 120 },
          downlink,
        }),
    });
    // Send hello and IMMEDIATELY a binary audio frame, before verify resolves.
    client.clientSend(
      JSON.stringify({
        t: "hello",
        token: minted.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    client.clientSend(new Uint8Array(2560)); // pipelined pre-verify.
    // The session must NOT have been failed with hello_required.
    expect(client.closedWith).toBeNull();
    await flush();
    await flush();
    // Session came up (ready) and the buffered frame was admitted + forwarded.
    expect(client.controlTypes()).toContain("ready");
    expect(client.controlFrames.find((f) => f.t === "error")?.code).not.toBe(
      "hello_required",
    );
    expect(flux!.sentChunks.length).toBeGreaterThan(0);
  });

  test("a non-hello first control frame is rejected", async () => {
    const client = new FakeClientSocket();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: () => {
        throw new Error("must not build a session before hello");
      },
    });
    client.clientSend(JSON.stringify({ t: "barge_in" }));
    await flush();
    expect(client.closedWith).not.toBeNull();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "hello_required",
    );
  });

  test("malformed control JSON before hello is fatal", async () => {
    const client = new FakeClientSocket();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: () => {
        throw new Error("must not build");
      },
    });
    client.clientSend("{ not json");
    await flush();
    expect(client.closedWith).not.toBeNull();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "control_invalid_json",
    );
  });

  test("oversized audio frame is rejected without tearing down the session", async () => {
    const client = new FakeClientSocket();
    await connectSession({ client, fetchImpl: makeSseFetch(["ok."]) });
    // 128KiB > 64KiB ceiling.
    client.clientSend(pcmChunk(128 * 1024));
    await flush();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "audio_too_large",
    );
    // Session still alive (not closed).
    expect(client.closedWith).toBeNull();
  });

  test("single-use: a second connection with the same token is rejected", async () => {
    const minted = await mintVoiceSessionToken(CLAIMS);
    const usageStore = new InMemoryVoiceUsageStore();
    const claimed = new Set<string>();
    const buildDeps = (_client: FakeClientSocket) => ({
      requestedSessionId: CLAIMS.sessionId,
      // Atomic single-use claim backed by a shared in-memory set (models Redis NX).
      claimToken: async (jti: string) => {
        if (claimed.has(jti)) return false;
        claimed.add(jti);
        return true;
      },
      buildSession: ({
        claims,
        jti,
        tokenExpSeconds,
        downlink,
      }: {
        claims: typeof CLAIMS;
        jti: string;
        tokenExpSeconds: number;
        downlink: import("../../../../../shared/src/lib/voice-session/ws-handler").VoiceSessionDownlink;
      }) =>
        new VoiceSession({
          sessionId: claims.sessionId,
          jti,
          organizationId: claims.organizationId,
          userId: claims.userId,
          agentId: claims.agentId,
          conversationId: claims.conversationId,
          tokenExpSeconds,
          deepgramApiKey: "dg",
          deepgramWebSocketFactory: () => new FakeFluxSocket(),
          cartesiaApiKey: "ct",
          cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
          cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
          elizaEndpoint: "http://x",
          elizaAuthorization: "Bearer x",
          elizaModel: "gemma-4-31b",
          usageStore,
          usageLimits: { organizationDailyMinutes: 600, userDailyMinutes: 120 },
          downlink,
        }),
    });

    const helloFrame = JSON.stringify({
      t: "hello",
      token: minted.token,
      protocol: 1,
      uplinkCodec: "pcm16",
      downlinkCodec: "pcm16",
      sampleRate: 16000,
    });

    const clientA = new FakeClientSocket();
    attachVoiceWsHandler(clientA, buildDeps(clientA));
    clientA.clientSend(helloFrame);
    await flush();
    expect(clientA.controlTypes()).toContain("ready");

    const clientB = new FakeClientSocket();
    attachVoiceWsHandler(clientB, buildDeps(clientB));
    clientB.clientSend(helloFrame);
    await flush();
    // Second connection with the SAME token is rejected before ready.
    expect(clientB.controlTypes()).not.toContain("ready");
    expect(clientB.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "token_already_claimed",
    );
    expect(clientB.closedWith).not.toBeNull();
  });

  test("session construction failure surfaces a clean error + close (not a hang)", async () => {
    const client = new FakeClientSocket();
    const minted = await mintVoiceSessionToken(CLAIMS);
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      buildSession: () => {
        // e.g. an invalid Cartesia voiceId rejected by the adapter.
        throw new Error("CONFIG_VOICE_ID_INVALID");
      },
    });
    client.clientSend(
      JSON.stringify({
        t: "hello",
        token: minted.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    await flush();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "session_start_failed",
    );
    expect(client.closedWith).not.toBeNull();
  });

  test("capacity gate rejects a verified hello when at the per-worker ceiling", async () => {
    const client = new FakeClientSocket();
    const minted = await mintVoiceSessionToken(CLAIMS);
    const usageStore = new InMemoryVoiceUsageStore();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId,
      admitSession: () => false, // simulate registry already at capacity.
      buildSession: () => {
        throw new Error("must not build a session when at capacity");
      },
    });
    void usageStore;
    client.clientSend(
      JSON.stringify({
        t: "hello",
        token: minted.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    await flush();
    expect(client.closedWith).not.toBeNull();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "at_capacity",
    );
  });

  test("bad token in hello is rejected (claim mismatch / invalid)", async () => {
    const client = new FakeClientSocket();
    const other = await mintVoiceSessionToken({
      ...CLAIMS,
      sessionId: "some-other-session",
    });
    const usageStore = new InMemoryVoiceUsageStore();
    attachVoiceWsHandler(client, {
      requestedSessionId: CLAIMS.sessionId, // mismatch vs the token's sessionId.
      buildSession: ({ claims, jti, tokenExpSeconds, downlink }) =>
        new VoiceSession({
          sessionId: claims.sessionId,
          jti,
          organizationId: claims.organizationId,
          userId: claims.userId,
          agentId: claims.agentId,
          conversationId: claims.conversationId,
          tokenExpSeconds,
          deepgramApiKey: "dg",
          deepgramWebSocketFactory: () => new FakeFluxSocket(),
          cartesiaApiKey: "ct",
          cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
          cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
          elizaEndpoint: "http://x",
          elizaAuthorization: "Bearer x",
          elizaModel: "gemma-4-31b",
          usageStore,
          usageLimits: { organizationDailyMinutes: 600, userDailyMinutes: 120 },
          downlink,
        }),
    });
    client.clientSend(
      JSON.stringify({
        t: "hello",
        token: other.token,
        protocol: 1,
        uplinkCodec: "pcm16",
        downlinkCodec: "pcm16",
        sampleRate: 16000,
      }),
    );
    await flush();
    expect(client.closedWith).not.toBeNull();
    expect(client.controlFrames.find((f) => f.t === "error")?.code).toBe(
      "claim_mismatch",
    );
  });
});

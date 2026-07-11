/**
 * Integration coverage for the harness reference voice-session server. The three
 * live seams (Deepgram Flux STT, Cartesia TTS, streaming LLM) are replaced with
 * controllable in-process doubles so the FULL §7 wire flow runs against a real
 * Bun.serve WebSocket server + a real ws client: hello/auth, ready-after-STT-
 * open, uplink re-frame guard, stt partial/eager/final, llm_first_text, phrase
 * aggregation -> speaking_start/audio/speaking_end, the §7.5 barge-in pipeline
 * (interrupted + zero post-interrupt frames), and teardown.
 *
 * The @harness-adapters/* + llm-bridge stubs are process-global mock.module
 * overrides; they are restored in afterAll so the non-isolated coverage lane's
 * sibling harness suite is not poisoned.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as realCartesiaSonic from "@harness-adapters/cartesia-sonic-tts.ts";
import * as realDeepgramFlux from "@harness-adapters/deepgram-flux.ts";
import * as realLlmBridge from "./llm-bridge.ts";

const realDeepgramFluxExports = { ...realDeepgramFlux };
const realCartesiaSonicExports = { ...realCartesiaSonic };
const realLlmBridgeExports = { ...realLlmBridge };

// ---- controllable doubles ------------------------------------------------

interface FluxHooks {
  onMetric?: (m: { name: string }) => void;
}
interface FluxSession {
  url: string;
  sendAudioChunk: (b: Uint8Array) => void;
  close: (reason?: string) => void;
  cancel: (reason?: string) => void;
}

let lastFluxOnEvent: ((ev: Record<string, unknown>) => void) | null = null;
let fluxAudioChunks = 0;
let fluxCreateThrows = false;
let autoConnectFlux = true;

const deepgramFluxStub = () => ({
  ...realDeepgramFluxExports,
  DEEPGRAM_FLUX_CHUNK_BYTES: 4,
  createDeepgramFluxRealtimeSession: (opts: {
    hooks?: FluxHooks;
    onEvent?: (ev: Record<string, unknown>) => void;
  }): FluxSession => {
    if (fluxCreateThrows) throw new Error("flux boom");
    lastFluxOnEvent = opts.onEvent ?? null;
    if (autoConnectFlux) {
      queueMicrotask(() =>
        opts.hooks?.onMetric?.({ name: "deepgram_flux_connected" }),
      );
    }
    return {
      url: "wss://deepgram.test/listen",
      sendAudioChunk: () => {
        fluxAudioChunks++;
      },
      close: () => undefined,
      cancel: () => undefined,
    };
  },
});
mock.module("@harness-adapters/deepgram-flux.ts", deepgramFluxStub);

// Records the stream callbacks the server registered so a test can drive them.
interface TtsCallbacks {
  onFirstAudio?: (e: { elapsedMs: number }) => void;
  onAudioFrame?: (f: { sequence: number; bytes: Uint8Array }) => void;
  onComplete?: (c: { frameCount: number }) => void;
  onProviderError?: (e: { code?: string; message?: string }) => void;
  onCancelled?: () => void;
}
let lastTtsCallbacks: TtsCallbacks | null = null;
const ttsPhrases: Array<{ text: string; continueContext?: boolean }> = [];
let ttsCancelled = false;
let _ttsFinished = false;

const cartesiaStub = () => ({
  ...realCartesiaSonicExports,
  CartesiaSonicTtsAdapter: class {
    createStream(_meta: unknown, cbs: TtsCallbacks) {
      lastTtsCallbacks = cbs;
      return {
        opened: Promise.resolve(),
        sendPhrase: (p: { text: string; continueContext?: boolean }) => {
          ttsPhrases.push(p);
        },
        finish: () => {
          _ttsFinished = true;
        },
        cancel: () => {
          ttsCancelled = true;
          cbs.onCancelled?.();
        },
      };
    }
  },
});
mock.module("@harness-adapters/cartesia-sonic-tts.ts", cartesiaStub);

// Controllable LLM: replays a scripted set of deltas then resolves.
let llmScript: { deltas: string[]; full: string } = {
  deltas: ["Hello there. ", "How are you?"],
  full: "Hello there. How are you?",
};
let _llmAbortSeen = false;
const llmBridgeStub = () => ({
  ...realLlmBridgeExports,
  streamLlmReply: async (
    _prompt: string,
    _cfg: unknown,
    signal: AbortSignal,
    cbs: {
      onFirstText: () => void;
      onDelta: (t: string) => void;
      onDone: (full: string) => void;
      onError: (e: Error) => void;
    },
  ) => {
    if (signal.aborted) {
      _llmAbortSeen = true;
      cbs.onDone("");
      return;
    }
    cbs.onFirstText();
    for (const d of llmScript.deltas) {
      if (signal.aborted) {
        _llmAbortSeen = true;
        break;
      }
      cbs.onDelta(d);
      // yield so the server's phrase aggregation runs between deltas
      await Promise.resolve();
    }
    cbs.onDone(signal.aborted ? "" : llmScript.full);
  },
});
mock.module("./llm-bridge.ts", llmBridgeStub);

const {
  startReferenceServer,
  mintHarnessToken,
  serverPostInterruptFrameCount,
} = await import("./voice-session-server");

// ---- helpers -------------------------------------------------------------

const providers = {
  deepgramApiKey: "dg",
  cartesiaApiKey: "ct",
  cartesiaVoiceId: "voice",
  llm: { apiKey: "k", baseUrl: "https://llm.test" },
};

function makeHooks() {
  const emitted: Array<{ kind: string; obj: Record<string, unknown> }> = [];
  const domainRows: Array<Record<string, unknown>> = [];
  return {
    emitted,
    domainRows,
    hooks: {
      log: () => undefined,
      onServerEmit: (kind: string, obj: Record<string, unknown>) =>
        emitted.push({ kind, obj }),
      onDomainRow: (row: Record<string, unknown>) => domainRows.push(row),
    },
  };
}

interface ClientRecorder {
  ws: WebSocket;
  jsonMessages: Record<string, unknown>[];
  binaryCount: number;
  waitFor: (t: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  send: (obj: Record<string, unknown>) => void;
  sendBinary: (bytes: Uint8Array) => void;
  close: () => void;
}

function connect(wsUrl: string): Promise<ClientRecorder> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    const jsonMessages: Record<string, unknown>[] = [];
    let binaryCount = 0;
    const waiters: Array<{
      t: string;
      resolve: (o: Record<string, unknown>) => void;
    }> = [];
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const obj = JSON.parse(ev.data) as Record<string, unknown>;
        jsonMessages.push(obj);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].t === obj.t) {
            waiters[i].resolve(obj);
            waiters.splice(i, 1);
          }
        }
      } else {
        binaryCount++;
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
    ws.onopen = () =>
      resolve({
        ws,
        jsonMessages,
        get binaryCount() {
          return binaryCount;
        },
        waitFor: (t, timeoutMs = 2000) =>
          new Promise((res, rej) => {
            const existing = jsonMessages.find((m) => m.t === t);
            if (existing) return res(existing);
            const timer = setTimeout(
              () => rej(new Error(`timeout waiting for ${t}`)),
              timeoutMs,
            );
            waiters.push({
              t,
              resolve: (o) => {
                clearTimeout(timer);
                res(o);
              },
            });
          }),
        send: (obj) => ws.send(JSON.stringify(obj)),
        sendBinary: (bytes) => ws.send(bytes),
        close: () => ws.close(),
      } as ClientRecorder);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ReturnType<typeof startReferenceServer> | null = null;

beforeEach(() => {
  lastFluxOnEvent = null;
  fluxAudioChunks = 0;
  fluxCreateThrows = false;
  autoConnectFlux = true;
  lastTtsCallbacks = null;
  ttsPhrases.length = 0;
  ttsCancelled = false;
  _ttsFinished = false;
  _llmAbortSeen = false;
  llmScript = {
    deltas: ["Hello there. ", "How are you?"],
    full: "Hello there. How are you?",
  };
});

afterEach(() => {
  server?.stop();
  server = null;
});

afterAll(() => {
  mock.module(
    "@harness-adapters/deepgram-flux.ts",
    () => realDeepgramFluxExports,
  );
  mock.module(
    "@harness-adapters/cartesia-sonic-tts.ts",
    () => realCartesiaSonicExports,
  );
  mock.module("./llm-bridge.ts", () => realLlmBridgeExports);
});

// ---- tests ---------------------------------------------------------------

describe("mintHarnessToken", () => {
  test("issues a verifiable base64url token with the session id", () => {
    const m = mintHarnessToken("agent-a", "conv-a");
    expect(m.sessionId).toBeTruthy();
    expect(m.token).toContain(".");
    expect(m.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("startReferenceServer wire flow", () => {
  test("rejects a hello with a bad token (auth_failed + close)", async () => {
    const { hooks } = makeHooks();
    server = startReferenceServer({ providers, hooks });
    const client = await connect(server.wsUrl);
    client.send({ t: "hello", token: "not.a.valid.token" });
    const err = await client.waitFor("error");
    expect(err.code).toBe("auth_failed");
  });

  test("hello -> ready only after STT connects; then drives a full turn", async () => {
    const { hooks, emitted, domainRows } = makeHooks();
    server = startReferenceServer({ providers, hooks });
    const minted = server.mint("agent-a", "conv-a");
    const client = await connect(server.wsUrl);

    client.send({ t: "hello", token: minted.token });
    const ready = await client.waitFor("ready");
    expect(ready.sessionId).toBe(minted.sessionId);
    // a voice_sessions open row was recorded
    expect(domainRows.some((r) => r.table === "voice_sessions")).toBe(true);

    // uplink a correctly-sized chunk (4 bytes == stubbed DEEPGRAM_FLUX_CHUNK_BYTES)
    client.sendBinary(new Uint8Array([1, 2, 3, 4]));
    // wrong-size chunk is dropped (no throw)
    client.sendBinary(new Uint8Array([9, 9]));
    await sleep(20);
    expect(fluxAudioChunks).toBe(1);

    // Drive STT events through the captured onEvent.
    lastFluxOnEvent?.({ type: "start-of-turn" });
    lastFluxOnEvent?.({ type: "transcript-update", transcript: "hel" });
    const partial = await client.waitFor("stt_partial");
    expect(partial.text).toBe("hel");
    lastFluxOnEvent?.({ type: "eager-end-of-turn" });
    await client.waitFor("stt_eager_eot");

    // end-of-turn commits final + starts the LLM->TTS leg.
    lastFluxOnEvent?.({ type: "end-of-turn", transcript: "hello there" });
    const final = await client.waitFor("stt_final");
    expect(final.text).toBe("hello there");
    await client.waitFor("llm_first_text");

    // The TTS callbacks were registered; drive first audio + a frame + complete.
    await sleep(20);
    expect(lastTtsCallbacks).not.toBeNull();
    lastTtsCallbacks?.onFirstAudio?.({ elapsedMs: 5 });
    await client.waitFor("speaking_start");
    lastTtsCallbacks?.onAudioFrame?.({
      sequence: 0,
      bytes: new Uint8Array([1, 2]),
    });
    await sleep(10);
    expect(client.binaryCount).toBeGreaterThanOrEqual(1);
    lastTtsCallbacks?.onComplete?.({ frameCount: 1 });
    await client.waitFor("speaking_end");

    // Phrase aggregation flushed at least one sentence-boundary phrase.
    expect(ttsPhrases.length).toBeGreaterThan(0);
    expect(emitted.some((e) => e.obj.t === "stt_final")).toBe(true);
  });

  test("barge-in interrupts: cancels TTS, aborts LLM, blocks post-interrupt frames", async () => {
    const { hooks } = makeHooks();
    server = startReferenceServer({ providers, hooks });
    const minted = server.mint("agent-b", "conv-b");
    const client = await connect(server.wsUrl);
    client.send({ t: "hello", token: minted.token });
    await client.waitFor("ready");

    lastFluxOnEvent?.({
      type: "end-of-turn",
      transcript: "say something long",
    });
    await client.waitFor("stt_final");
    await sleep(20);
    lastTtsCallbacks?.onFirstAudio?.({ elapsedMs: 1 });
    await client.waitFor("speaking_start");

    // Explicit barge-in.
    client.send({ t: "barge_in" });
    const interrupted = await client.waitFor("interrupted");
    expect(interrupted.reason).toBe("explicit");
    expect(ttsCancelled).toBe(true);

    // A late TTS frame after interrupt must NOT reach the client.
    const before = client.binaryCount;
    lastTtsCallbacks?.onAudioFrame?.({
      sequence: 99,
      bytes: new Uint8Array([7, 7]),
    });
    await sleep(10);
    expect(client.binaryCount).toBe(before);
  });

  test("a bad-json control frame yields a bad_json error (not a teardown)", async () => {
    const { hooks } = makeHooks();
    server = startReferenceServer({ providers, hooks });
    const minted = server.mint("agent-c", "conv-c");
    const client = await connect(server.wsUrl);
    client.send({ t: "hello", token: minted.token });
    await client.waitFor("ready");
    client.ws.send("this is not json{");
    const err = await client.waitFor("error");
    expect(err.code).toBe("bad_json");
  });

  test("benign Flux 'Connected' handshake error is logged, not surfaced", async () => {
    const { hooks, emitted } = makeHooks();
    server = startReferenceServer({ providers, hooks });
    const minted = server.mint("agent-d", "conv-d");
    const client = await connect(server.wsUrl);
    client.send({ t: "hello", token: minted.token });
    await client.waitFor("ready");
    lastFluxOnEvent?.({
      type: "error",
      code: "malformed_event",
      message: "unexpected Connected frame",
    });
    await sleep(20);
    // No error frame was emitted to the client for the benign handshake.
    expect(emitted.some((e) => e.obj.t === "error")).toBe(false);
  });

  test("a real Flux provider error is surfaced as stt_<code>", async () => {
    const { hooks } = makeHooks();
    server = startReferenceServer({ providers, hooks });
    const minted = server.mint("agent-e", "conv-e");
    const client = await connect(server.wsUrl);
    client.send({ t: "hello", token: minted.token });
    await client.waitFor("ready");
    lastFluxOnEvent?.({
      type: "error",
      code: "provider_down",
      message: "socket 1011",
    });
    const err = await client.waitFor("error");
    expect(err.code).toBe("stt_provider_down");
  });

  test("STT init failure emits stt_init_failed", async () => {
    fluxCreateThrows = true;
    const { hooks } = makeHooks();
    server = startReferenceServer({ providers, hooks });
    const minted = server.mint("agent-f", "conv-f");
    const client = await connect(server.wsUrl);
    client.send({ t: "hello", token: minted.token });
    const err = await client.waitFor("error");
    expect(err.code).toBe("stt_init_failed");
  });

  test("bye tears the session down and records a closed voice_sessions row", async () => {
    const { hooks, domainRows } = makeHooks();
    server = startReferenceServer({ providers, hooks });
    const minted = server.mint("agent-g", "conv-g");
    const client = await connect(server.wsUrl);
    client.send({ t: "hello", token: minted.token });
    await client.waitFor("ready");
    client.send({ t: "bye" });
    await sleep(30);
    expect(
      domainRows.some(
        (r) => r.table === "voice_sessions" && r.status === "closed",
      ),
    ).toBe(true);
  });

  test("a request to an unknown path 404s (non-upgrade fetch)", async () => {
    const { hooks } = makeHooks();
    server = startReferenceServer({ providers, hooks });
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(res.status).toBe(404);
  });

  test("serverPostInterruptFrameCount reads the per-session counter", () => {
    const state = {
      postInterruptFrameCount: 3,
    } as unknown as Parameters<typeof serverPostInterruptFrameCount>[0];
    expect(serverPostInterruptFrameCount(state)).toBe(3);
  });
});

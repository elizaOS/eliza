/**
 * Behavior tests for the voice evidence harness helpers. Live providers and
 * ffmpeg are kept at the boundary; the tests assert artifact, WAV, client, LLM,
 * and CLI failure behavior with deterministic local doubles.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realCartesiaSonic from "@harness-adapters/cartesia-sonic-tts.ts";
// The @harness-adapters/* aliases and the harness-real-server specifier resolve
// to REAL cloud/api + cloud/shared modules that sibling changed-tests import
// directly (uplink-reframer / ws-lifecycle need validateDeepgramFluxAudioChunk
// and the DeepgramFluxWebSocket class from stt/providers/deepgram-flux.ts). The
// coverage lane runs all changed files in ONE non-isolated bun process and
// mock.module is process-global with no per-file teardown, so a stub that drops
// exports here poisons those siblings. Capture the real surfaces and restore
// them in afterAll. The absolute-URL forms below are computed from
// import.meta.url so they resolve on any checkout (the previous hardcoded
// /home/shad0w/…/wt-voice-slice path resolved nowhere on CI, which is why the
// real-server seam was never stubbed and the “real target bridge” test failed).
import * as realDeepgramFlux from "@harness-adapters/deepgram-flux.ts";
import * as realHarnessRealServer from "../../../cloud/api/v1/voice/session/lib/harness-real-server.ts";

const realDeepgramFluxExports = { ...realDeepgramFlux };
const realCartesiaSonicExports = { ...realCartesiaSonic };
const realHarnessRealServerExports = { ...realHarnessRealServer };
const harnessRealServerUrl = new URL(
  "../../../cloud/api/v1/voice/session/lib/harness-real-server.ts",
  import.meta.url,
).href;

const fakeWsInstances: FakeProviderSocket[] = [];

class FakeProviderSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = "nodebuffer";
  readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly sent: unknown[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> },
  ) {
    fakeWsInstances.push(this);
  }
  on(type: string, handler: (...args: unknown[]) => void) {
    const handlers = this.handlers.get(type) ?? new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers);
  }
  off(type: string, handler: (...args: unknown[]) => void) {
    this.handlers.get(type)?.delete(handler);
  }
  emit(type: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(type) ?? []) handler(...args);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closed.push({ code, reason });
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }
}

mock.module("ws", () => ({
  default: FakeProviderSocket,
  WebSocket: FakeProviderSocket,
  WebSocketServer: class {},
}));

const deepgramFluxStub = () => ({
  ...realDeepgramFluxExports,
  DEEPGRAM_FLUX_CHUNK_BYTES: 4,
  createDeepgramFluxRealtimeSession: (options: {
    hooks?: { onMetric?: (metric: { name: string }) => void };
    onEvent?: (event: unknown) => void;
  }) => {
    queueMicrotask(() =>
      options.hooks?.onMetric?.({ name: "deepgram_flux_connected" }),
    );
    return {
      url: "wss://deepgram.test/listen",
      sendAudioChunk: () => undefined,
      close: () => undefined,
      cancel: () => undefined,
    };
  },
});
mock.module("@harness-adapters/deepgram-flux.ts", deepgramFluxStub);

const cartesiaSonicStub = () => ({
  ...realCartesiaSonicExports,
  CartesiaSonicTtsAdapter: class {
    createStream() {
      return {
        opened: Promise.resolve(),
        sendPhrase: () => undefined,
        finish: () => undefined,
        cancel: () => undefined,
      };
    }
  },
});
mock.module("@harness-adapters/cartesia-sonic-tts.ts", cartesiaSonicStub);

const realServerCalls: unknown[] = [];
const harnessRealServerStub = () => ({
  installHarnessSigningKey: async () => {
    realServerCalls.push({ type: "install-key" });
  },
  startRealVoiceServer: async (config: unknown) => {
    realServerCalls.push({ type: "start", config });
    return {
      wsUrl: "ws://real.test/session?sessionId=",
      mint: async () => ({
        sessionId: "s",
        token: "t",
        expiresAt: "2026-07-10T00:00:00.000Z",
      }),
      stop: async () => undefined,
    };
  },
});
// Register on the specifier `real-target.ts` actually imports (a repo-relative
// path bun canonicalizes to this absolute URL) so the stub really takes effect.
mock.module(harnessRealServerUrl, harnessRealServerStub);

// Restore the REAL shared modules so sibling changed-tests in the same (non-
// isolated) coverage-lane process see the full export surface, not our stubs.
afterAll(() => {
  mock.module(
    "@harness-adapters/deepgram-flux.ts",
    () => realDeepgramFluxExports,
  );
  mock.module(
    "@harness-adapters/cartesia-sonic-tts.ts",
    () => realCartesiaSonicExports,
  );
  mock.module(harnessRealServerUrl, () => realHarnessRealServerExports);
});

const wav = await import("./wav");
const evidenceModule = await import("./evidence");
const mp4 = await import("./mp4");
const llmBridge = await import("./reference/llm-bridge");
const clientModule = await import("./client");
const serverModule = await import("./reference/voice-session-server");
const wsFactories = await import("./ws-factories");
const realTarget = await import("./real/real-target");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "voice-harness-test-"));
}

describe("wav helpers", () => {
  test("writes parseable PCM WAV bytes and pads fixed-size chunks", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5]);
    const bytes = wav.writeWav({
      pcm,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    });
    const parsed = wav.parseWav(bytes);
    expect(parsed).toMatchObject({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      audioFormat: 1,
    });
    expect([...parsed.pcm]).toEqual([...pcm]);

    const framed = wav.frameFixedChunks(pcm, 4);
    expect(framed.paddedBytes).toBe(3);
    expect(framed.chunks.map((chunk) => [...chunk])).toEqual([
      [1, 2, 3, 4],
      [5, 0, 0, 0],
    ]);
  });

  test("rejects malformed WAV input loudly", () => {
    expect(() => wav.parseWav(new TextEncoder().encode("nope"))).toThrow(
      "Not a RIFF/WAV file",
    );
    const missingData = wav
      .writeWav({
        pcm: new Uint8Array([1, 2]),
        sampleRate: 8000,
        channels: 1,
        bitsPerSample: 16,
      })
      .subarray(0, 36);
    expect(() => wav.parseWav(missingData)).toThrow("WAV missing data chunk");
  });
});

describe("evidence sink", () => {
  test("redacts secrets, records missing stages as absent, and writes hashed artifacts", () => {
    const dir = tempDir();
    try {
      const ev = new evidenceModule.Evidence(dir);
      ev.log("client", "info", "Bearer abcdefghijklmnop", {
        apiKey: "secret",
        nested: { Authorization: "Token abcdefghijklmnop" },
      });
      ev.wsEvent("c2s", "json", { token: "secret-token-value", text: "hello" });
      ev.mark("mint");
      ev.mark("ready");
      const sha = ev.writeArtifact(
        "artifact.bin",
        new Uint8Array([1, 2, 3]),
        "binary",
      );
      ev.flushLogs();

      expect(sha).toHaveLength(64);
      expect(existsSync(join(dir, "artifact.bin"))).toBe(true);
      expect(ev.stageDelta("mint", "ready")).toBeGreaterThanOrEqual(0);
      const timing = ev.timingReport(["mint", "stt_final"]);
      expect(timing.missing).toEqual(["stt_final"]);
      expect(timing.deltas["ready->stt_final"]).toBeNull();

      const allLogs = readFileSync(join(dir, "all.log.json"), "utf8");
      expect(allLogs).toContain("<REDACTED>");
      expect(allLogs).not.toContain("abcdefghijklmnop");
      const transcript = readFileSync(join(dir, "ws-transcript.json"), "utf8");
      expect(transcript).toContain("<REDACTED>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mp4 helper", () => {
  test("reports ffmpeg availability and missing input WAV as explicit failures", () => {
    const ffmpeg = mp4.ensureFfmpeg();
    expect(ffmpeg.installHint).toContain("ffmpeg is required");
    expect(typeof ffmpeg.ok).toBe("boolean");
    const dir = tempDir();
    try {
      const result = mp4.assembleMp4({
        dir,
        inputWav: "missing.wav",
        outputWav: "out.wav",
        timelineLines: [],
        out: "x.mp4",
      });
      if (ffmpeg.ok) {
        expect(result.ok).toBe(false);
        expect(result.error).toContain("missing input wav");
      } else {
        expect(result).toEqual({ ok: false, error: ffmpeg.installHint });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LLM bridge", () => {
  afterEach(() => {
    mock.restore();
  });

  test("streams SSE deltas, emits first-text once, and reports upstream errors", async () => {
    const originalFetch = globalThis.fetch;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
          ),
        );
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":" there"}}]}\n',
          ),
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n"));
        controller.close();
      },
    });
    globalThis.fetch = (async () =>
      new Response(stream, { status: 200 })) as typeof fetch;
    const deltas: string[] = [];
    const first: number[] = [];
    const done: string[] = [];
    await llmBridge.streamLlmReply(
      "weather",
      { apiKey: "key", baseUrl: "https://llm.test" },
      new AbortController().signal,
      {
        onFirstText: (ms) => first.push(ms),
        onDelta: (text) => deltas.push(text),
        onDone: (text) => done.push(text),
        onError: (err) => {
          throw err;
        },
      },
    );
    expect(first).toHaveLength(1);
    expect(deltas).toEqual(["Hi", " there"]);
    expect(done).toEqual(["Hi there"]);

    const errors: string[] = [];
    globalThis.fetch = (async () =>
      new Response("bad", { status: 503, statusText: "Nope" })) as typeof fetch;
    await llmBridge.streamLlmReply(
      "weather",
      { apiKey: "key", baseUrl: "https://llm.test" },
      new AbortController().signal,
      {
        onFirstText: () => undefined,
        onDelta: () => undefined,
        onDone: () => undefined,
        onError: (err) => errors.push(err.message),
      },
    );
    expect(errors).toEqual(["LLM HTTP 503 Nope"]);
    globalThis.fetch = originalFetch;
  });
});

describe("client and reference-server contract helpers", () => {
  test("mints signed harness tokens and exposes post-interrupt frame counts", () => {
    const minted = serverModule.mintHarnessToken("agent-a", "conversation-a");
    expect(minted.sessionId).toBeString();
    expect(minted.token.split(".")).toHaveLength(2);
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
    expect(
      serverModule.serverPostInterruptFrameCount({
        postInterruptFrameCount: 7,
      } as never),
    ).toBe(7);
  });

  test("client sends hello, pumps framed audio after ready, and counts post-interrupt frames", async () => {
    class FakeWebSocket extends EventTarget {
      static instances: FakeWebSocket[] = [];
      readyState = 1;
      binaryType = "blob";
      sent: unknown[] = [];
      constructor(readonly url: string) {
        super();
        FakeWebSocket.instances.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(data: unknown) {
        this.sent.push(data);
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
      serverJson(payload: Record<string, unknown>) {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(payload) }),
        );
      }
      serverAudio(bytes: Uint8Array) {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          }),
        );
      }
    }

    const originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const dir = tempDir();
    try {
      const ev = new evidenceModule.Evidence(dir);
      const run = clientModule.runClient({
        wsUrl: "ws://unit",
        token: "token",
        uplinkPcm: new Uint8Array([1, 2, 3, 4, 5]),
        evidence: ev,
        bargeInAfterFirstAudioMs: 1,
        maxRunMs: 1000,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const ws = FakeWebSocket.instances[0]!;
      expect(JSON.parse(String(ws.sent[0]))).toMatchObject({
        t: "hello",
        token: "token",
      });
      ws.serverJson({ t: "ready", sessionId: "s" });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(ws.sent.some((sent) => sent instanceof Uint8Array)).toBe(true);
      ws.serverJson({ t: "stt_final", text: "hello" });
      ws.serverJson({ t: "llm_first_text" });
      ws.serverJson({ t: "speaking_start" });
      ws.serverAudio(new Uint8Array([9, 9]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      ws.serverJson({ t: "interrupted", reason: "explicit" });
      ws.serverAudio(new Uint8Array([8, 8]));
      const result = await run;
      expect(result.sawReady).toBe(true);
      expect(result.sawSttFinal).toBe(true);
      expect(result.sawSpeakingStart).toBe(true);
      expect(result.sawInterrupted).toBe(true);
      expect(result.downlinkFrameCount).toBe(2);
      expect(result.postBargeInFrameCount).toBe(1);
      expect(result.downlinkPcm.byteLength).toBe(4);
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket =
        originalWebSocket;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provider websocket factories", () => {
  test("strip Deepgram channels, preserve headers, normalize events, and close sockets", () => {
    fakeWsInstances.length = 0;
    const log: unknown[] = [];
    const deepgram = wsFactories.makeDeepgramFactory({
      log: (msg, data) => log.push({ msg, data }),
    })({
      url: "wss://deepgram.test/v2/listen?encoding=linear16&channels=1",
      headers: { Authorization: "Token dg" },
    });
    expect(fakeWsInstances[0]?.url).toBe(
      "wss://deepgram.test/v2/listen?encoding=linear16",
    );
    expect(fakeWsInstances[0]?.options?.headers).toEqual({
      Authorization: "Token dg",
    });
    expect(log).toHaveLength(1);

    const messages: unknown[] = [];
    const closes: unknown[] = [];
    const errors: unknown[] = [];
    deepgram.addEventListener("message", (event) => messages.push(event));
    deepgram.addEventListener("close", (event) => closes.push(event));
    deepgram.addEventListener("error", (event) => errors.push(event));
    fakeWsInstances[0]?.emit("message", Buffer.from('{"ok":true}'));
    fakeWsInstances[0]?.emit("error", new Error("boom"));
    fakeWsInstances[0]?.emit("close", 1008, Buffer.from("auth"));
    expect(messages).toEqual([{ type: "message", data: '{"ok":true}' }]);
    expect(errors[0]).toMatchObject({ type: "error", message: "boom" });
    expect(closes[0]).toMatchObject({
      type: "close",
      code: 1008,
      reason: "auth",
      wasClean: false,
    });
    deepgram.send("hello");
    deepgram.close(1000, "done");
    expect(fakeWsInstances[0]?.sent).toEqual(["hello"]);
    expect(fakeWsInstances[0]?.closed.at(-1)).toEqual({
      code: 1000,
      reason: "done",
    });

    const cartesia = wsFactories.makeCartesiaFactory()(
      "wss://cartesia.test/tts",
      {
        headers: { "X-API-Key": "cartesia" },
      },
    );
    expect(fakeWsInstances[1]?.url).toBe("wss://cartesia.test/tts");
    expect(fakeWsInstances[1]?.options?.headers).toEqual({
      "X-API-Key": "cartesia",
    });
    cartesia.binaryType = "arraybuffer";
    expect(cartesia.binaryType).toBe("arraybuffer");
  });
});

describe("real target bridge", () => {
  test("sets the production voice-session environment and delegates to the real-server seam", async () => {
    realServerCalls.length = 0;
    const originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "openrouter";
    try {
      const handle = await realTarget.startRealTarget({
        providers: {
          deepgramApiKey: "dg",
          cartesiaApiKey: "cartesia",
          cartesiaVoiceId: "voice",
          llm: { apiKey: "llm" },
        },
        faultInjection: "deepgram-auth-fail",
        hooks: { log: () => undefined },
      });
      expect(handle.wsUrl).toBe("ws://real.test/session?sessionId=");
      expect(process.env.MOCK_REDIS).toBe("1");
      expect(process.env.VOICE_REALTIME_WS_ENABLED).toBe("true");
      expect(process.env.DEEPGRAM_API_KEY).toBe("dg");
      expect(process.env.CARTESIA_API_KEY).toBe("cartesia");
      expect(realServerCalls[0]).toEqual({ type: "install-key" });
      expect(realServerCalls[1]).toMatchObject({
        type: "start",
        config: {
          deepgramApiKey: "dg",
          cartesiaApiKey: "cartesia",
          cartesiaVoiceId: "voice",
          faultInjection: "deepgram-auth-fail",
        },
      });
    } finally {
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalKey;
    }
  });
});

describe("cli entrypoint", () => {
  test("can be imported safely on the invalid-target path before live-provider setup", async () => {
    const originalArgv = process.argv;
    const originalExit = process.exit;
    const originalError = console.error;
    const errors: string[] = [];
    process.argv = [
      "bun",
      "src/cli.ts",
      "--target=bogus",
      "--scenario=baseline",
    ];
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    const exitCalls: Array<string | number | null | undefined> = [];
    process.exit = ((code?: string | number | null | undefined) => {
      exitCalls.push(code);
      if (code === 2) throw new Error(`exit:${code}`);
      return undefined as never;
    }) as typeof process.exit;
    try {
      await import(`./cli.ts?invalid-target=${Date.now()}`);
      expect(errors.join("\n")).toContain("invalid --target=bogus");
      expect(exitCalls).toEqual([2, 1]);
    } finally {
      process.argv = originalArgv;
      process.exit = originalExit;
      console.error = originalError;
    }
  });
});

/** Verifies voice-session client (real framing/state/barge-in/reconnect) through the package's configured test harness. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVoiceSessionClient,
  VoiceSessionMintError,
  type VoiceTraceMark,
} from "../voice-session-client";
import type { VoiceSessionClientDiagnosticEvent } from "../voice-session-media-diagnostics";
import {
  FakeMicAudioContext,
  FakeMicWorkletAudioContext,
  FakePlaybackAudioContext,
  FakeVoiceAudioWorkletNode,
  FakeWebSocket,
  fakeGetUserMedia,
  makeWsFactory,
} from "./voice-session-fakes";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface MintOverrides {
  token?: string;
  uplinkCodecs?: string[];
  downlinkCodecs?: string[];
  status?: number;
  malformed?: boolean;
  code?: string;
  expiresAtMs?: number;
}

/** A mint fetch that returns the §7.1 shape, tracking each call. */
function makeMintFetch(overrides: MintOverrides[] = []) {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push(body);
    const o = overrides[n] ?? {};
    n += 1;
    const status = o.status ?? 200;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: "nope", code: o.code }), {
        status,
      });
    }
    const payload = o.malformed
      ? { sessionId: "", wsUrl: "", token: "" }
      : {
          sessionId: `sess-${n}`,
          wsUrl: `wss://cloud/api/v1/voice/session/ws?sessionId=sess-${n}`,
          token: o.token ?? `tok-${n}`,
          expiresAt: o.expiresAtMs ?? Date.now() + 60_000,
          uplink: { codecs: o.uplinkCodecs ?? ["pcm16"] },
          downlink: { codecs: o.downlinkCodecs ?? ["pcm16"] },
          iceServers: null,
        };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return { fetch, calls };
}

function baseDeps(
  mintFetch: ReturnType<typeof makeMintFetch>,
  ws: ReturnType<typeof makeWsFactory>,
) {
  const marks: VoiceTraceMark[] = [];
  const errors: Error[] = [];
  let t = 0;
  const client = createVoiceSessionClient({
    agentId: "11111111-1111-1111-1111-111111111111",
    conversationId: "22222222-2222-2222-2222-222222222222",
    getConsentNonce: async () => "nonce-1",
    fetch: mintFetch.fetch,
    webSocketFactory: ws.factory,
    getUserMedia: fakeGetUserMedia(),
    createMicAudioContext: () => new FakeMicAudioContext(16_000),
    createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
    onTraceMark: (m) => marks.push(m),
    onError: (e) => errors.push(e),
    now: () => (t += 1),
  });
  return { client, marks, errors };
}

async function flush(): Promise<void> {
  // Let queued microtasks (mint fetch, capture start) settle.
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function playbackScriptNodeOf(ctx: FakePlaybackAudioContext) {
  const node = ctx.scriptNode;
  if (!node) throw new Error("no playback script node created");
  return node;
}

describe("voice-session client (real framing/state/barge-in/reconnect)", () => {
  it("retries a transient post-mint agent_not_found race, then connects", async () => {
    const mint = makeMintFetch([
      { status: 404, code: "agent_not_found" },
      { status: 404, code: "agent_not_found" },
      {},
    ]);
    const ws = makeWsFactory();
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => crypto.randomUUID(),
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      preLiveRetryDelayMs: 0,
    });

    await client.start();
    expect(mint.calls).toHaveLength(3);
    expect(ws.sockets).toHaveLength(1);
    await client.stop();
  });
  it("invokes playback resume before the first mint await consumes user activation", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const playback = new FakePlaybackAudioContext(16_000);
    let mintStarted = false;
    let consentStarted = false;
    const resume = vi.spyOn(playback, "resume").mockImplementation(async () => {
      expect(consentStarted).toBe(false);
      expect(mintStarted).toBe(false);
      playback.state = "running";
    });
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => {
        consentStarted = true;
        return "activation";
      },
      fetch: async (url, init) => {
        mintStarted = true;
        return mint.fetch(url, init);
      },
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => playback,
    });

    const start = client.start();
    expect(resume).toHaveBeenCalledTimes(1);
    // The client function has not reached its first consent await yet, proving
    // playback resume was invoked synchronously in the start gesture.
    expect(consentStarted).toBe(false);
    await start;
    await client.stop();
  });

  it("reports every validated mint so reconnect telemetry keeps its session correlation", async () => {
    const mint = makeMintFetch([{ token: "A" }, { token: "B" }]);
    const ws = makeWsFactory();
    const minted = vi.fn();
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "mint-callback",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onMinted: minted,
    });

    await client.start();
    const first = ws.last();
    first.emitOpen();
    first.emitClose(1006, "remint");
    await flush();

    expect(minted).toHaveBeenCalledTimes(2);
    expect(minted.mock.calls.map(([value]) => value.sessionId)).toEqual([
      "sess-1",
      "sess-2",
    ]);
    await client.stop();
  });

  it("constructs and validates the native WebSocket when no factory is injected", async () => {
    class NativeWebSocket extends FakeWebSocket {
      static readonly instances: NativeWebSocket[] = [];

      constructor(url: string) {
        super(url);
        NativeWebSocket.instances.push(this);
      }
    }
    vi.stubGlobal("WebSocket", NativeWebSocket);
    const mint = makeMintFetch();
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "native-ws",
      fetch: mint.fetch,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onError: (error) => errors.push(error),
    });

    await client.start();
    await flush();
    const socket = NativeWebSocket.instances[0];
    expect(socket?.url).toBe(
      "wss://cloud/api/v1/voice/session/ws?sessionId=sess-1",
    );
    expect(socket?.binaryType).toBe("arraybuffer");
    socket?.emitOpen();
    expect(socket?.sentControls()[0]).toMatchObject({
      t: "hello",
      token: "tok-1",
    });
    expect(errors).toEqual([]);
    await client.stop();
  });

  it("rejects a malformed native WebSocket runtime", async () => {
    class InvalidWebSocket {
      static latest: InvalidWebSocket | null = null;
      readonly close = vi.fn();

      constructor() {
        InvalidWebSocket.latest = this;
      }
    }
    vi.stubGlobal("WebSocket", InvalidWebSocket);
    const mint = makeMintFetch();
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "invalid-native-ws",
      fetch: mint.fetch,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onError: (error) => errors.push(error),
    });

    await client.start();
    await flush();

    expect(
      errors.some((error) => /required voice API/.test(error.message)),
    ).toBe(true);
    expect(InvalidWebSocket.latest?.close).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  it("enforces hello-first: the FIRST frame sent is a JSON hello carrying the token", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const { client } = baseDeps(mint, ws);
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    const controls = sock.sentControls();
    expect(controls[0]).toMatchObject({
      t: "hello",
      token: "tok-1",
      protocol: 1,
      uplinkCodec: "pcm16",
      downlinkCodec: "pcm16",
      sampleRate: 16000,
    });
    // No audio was sent before hello.
    expect(sock.sent[0]).toBe(JSON.stringify(controls[0]));
    await client.stop();
  });

  it("runs the full lifecycle event sequence and starts mic capture on ready", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const micCtx = new FakeMicAudioContext(16_000);
    const marks: VoiceTraceMark[] = [];
    const phases: string[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "n",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => micCtx,
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onState: (s) => phases.push(s.phase),
      onTraceMark: (m) => marks.push(m),
      now: () => marks.length + 1,
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "sess-1", traceId: "T1" });
    await flush();
    // Mic capture started on ready → ScriptProcessor node exists + listening.
    expect(micCtx.scriptNode).not.toBeNull();
    expect(client.state.phase).toBe("listening");

    sock.emitControl({ t: "stt_partial", text: "he", traceId: "T1" });
    sock.emitControl({ t: "stt_eager_eot", traceId: "provider-turn" });
    sock.emitControl({ t: "stt_final", text: "hello", traceId: "T1" });
    expect(client.state.finalTranscript).toBe("hello");
    sock.emitControl({ t: "llm_first_text", traceId: "T1" });
    expect(client.state.phase).toBe("thinking");
    sock.emitControl({
      t: "trace_mark",
      name: "tts_requested",
      traceId: "T1",
    });
    sock.emitControl({ t: "speaking_start", traceId: "T1" });
    expect(client.state.phase).toBe("speaking");
    // downlink audio during speaking
    sock.emitAudio(new Uint8Array(320));
    sock.emitControl({ t: "speaking_end", traceId: "T1" });
    // speaking_end → complete → looped to listening
    expect(client.state.phase).toBe("listening");
    sock.emitControl({ t: "usage", sttMs: 100, ttsChars: 20, traceId: "T1" });

    const markNames = marks.map((m) => m.name);
    expect(markNames).toContain("hello_sent");
    expect(markNames).toContain("ready");
    expect(markNames).toContain("stt_final");
    expect(markNames).toContain("acoustic_speech_ended");
    expect(markNames).toContain("llm_first_text");
    expect(markNames).toContain("tts_requested");
    expect(markNames).toContain("speaking_start");
    expect(markNames).toContain("downlink_audio");
    expect(markNames).toContain("speaking_end");
    // Every server-derived mark carries the turn traceId (not synthesized).
    const sttMark = marks.find((m) => m.name === "stt_final");
    expect(sttMark?.traceId).toBe("T1");
    await client.stop();
  });

  it("emits typed content-free device diagnostics at capture, first consumption, and drain", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const playbackContext = new FakePlaybackAudioContext(48_000);
    const diagnostics: VoiceSessionClientDiagnosticEvent[] = [];
    const marks: VoiceTraceMark[] = [];
    let atMs = 100;
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "diagnostics",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(48_000),
      createPlaybackAudioContext: () => playbackContext,
      onDiagnostic: (event) => diagnostics.push(event),
      onTraceMark: (mark) => marks.push(mark),
      now: () => (atMs += 1),
    });

    await client.start();
    await flush();
    const socket = ws.last();
    socket.emitOpen();
    socket.emitControl({
      t: "ready",
      sessionId: "session-diagnostics",
      traceId: "trace-diagnostics",
    });
    await flush();
    socket.emitControl({
      t: "speaking_start",
      traceId: "trace-diagnostics",
    });
    socket.emitAudio(new Uint8Array(320));
    playbackScriptNodeOf(playbackContext).render(600);

    expect(diagnostics.map((event) => event.type)).toEqual([
      "playback_ready",
      "capture_ready",
      "playback_started",
      "playback_drained",
    ]);
    expect(diagnostics[0]).toMatchObject({
      type: "playback_ready",
      traceId: null,
      playback: {
        backend: "scriptprocessor",
        requestedSampleRateHz: 16_000,
        actualSampleRateHz: 48_000,
        sampleRateConversion: "streaming_linear",
      },
    });
    expect(diagnostics[1]).toMatchObject({
      type: "capture_ready",
      traceId: "trace-diagnostics",
      capture: {
        frameDurationMs: 20,
        audioContextSampleRateHz: 48_000,
        granted: {
          sampleRateHz: "unknown",
          channelCount: "unknown",
          echoCancellation: "unknown",
          noiseSuppression: "unknown",
          autoGainControl: "unknown",
        },
      },
    });
    const started = diagnostics[2];
    const drained = diagnostics[3];
    expect(started).toMatchObject({
      type: "playback_started",
      traceId: "trace-diagnostics",
    });
    expect(drained).toMatchObject({
      type: "playback_drained",
      traceId: "trace-diagnostics",
    });
    if (started.type !== "playback_started") {
      throw new Error("expected playback_started diagnostic");
    }
    expect(drained).toMatchObject({ sequence: started.sequence });
    expect(marks.map((mark) => mark.name)).toContain("first_audio_playout");
    expect(marks.map((mark) => mark.name)).toContain("playback_drained");
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /(?:deviceId|groupId|label|transcript|audioData)/,
    );
    await client.stop();
  });

  it("mutes the live microphone as PCM silence without ending the session", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const micCtx = new FakeMicAudioContext(16_000);
    const clientWithMic = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "mute",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => micCtx,
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
    });
    await clientWithMic.start();
    await flush();
    const socket = ws.last();
    socket.emitOpen();
    socket.emitControl({
      t: "ready",
      sessionId: "sess-mute",
      traceId: "T-mute",
    });
    await flush();

    const input = new Float32Array(1600).fill(0.25);
    micCtx.scriptNode?.feed(input);
    let frames = socket.sent.filter(
      (value): value is ArrayBuffer => value instanceof ArrayBuffer,
    );
    expect(frames).toHaveLength(5);
    expect(
      frames.every((frame) =>
        Array.from(new Uint8Array(frame)).some((byte) => byte !== 0),
      ),
    ).toBe(true);

    clientWithMic.setMicrophoneMuted(true);
    expect(clientWithMic.microphoneMuted).toBe(true);
    micCtx.scriptNode?.feed(input);
    frames = socket.sent.filter(
      (value): value is ArrayBuffer => value instanceof ArrayBuffer,
    );
    expect(frames).toHaveLength(10);
    expect(
      frames
        .slice(5)
        .every((frame) =>
          Array.from(new Uint8Array(frame)).every((byte) => byte === 0),
        ),
    ).toBe(true);
    expect(clientWithMic.state.phase).toBe("listening");

    clientWithMic.setMicrophoneMuted(false);
    micCtx.scriptNode?.feed(input);
    frames = socket.sent.filter(
      (value): value is ArrayBuffer => value instanceof ArrayBuffer,
    );
    expect(frames).toHaveLength(15);
    expect(
      frames
        .slice(10)
        .every((frame) =>
          Array.from(new Uint8Array(frame)).some((byte) => byte !== 0),
        ),
    ).toBe(true);
    await clientWithMic.stop();
    expect(clientWithMic.microphoneMuted).toBe(false);
  });

  it("an empty stt_final (noise EOT) loops straight back to listening (#16662)", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "n",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "sess-noise", traceId: "T9" });
    await flush();
    expect(client.state.phase).toBe("listening");

    // A cough: StartOfTurn fires, eot_timeout commits an EMPTY transcript. The
    // server sends stt_final("") and dispatches NO LLM leg — no speaking_end
    // will ever arrive for this turn.
    sock.emitControl({ t: "stt_partial", text: "uh", traceId: "T9" });
    sock.emitControl({ t: "stt_final", text: "", traceId: "T9" });
    expect(client.state.phase).toBe("listening");
    expect(client.state.interimTranscript).toBe("");
    expect(client.state.finalTranscript).toBe("");
    await client.stop();
  });

  it("a whitespace-only stt_final loops back to listening (server dispatch gate is trim-based) (#16662)", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "n",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "sess-ws", traceId: "T10" });
    await flush();
    expect(client.state.phase).toBe("listening");

    // The wire carries the RAW provider transcript; the server's LLM-dispatch
    // gate is transcript.trim() === "" (session.ts commitTurn). A whitespace-
    // only final therefore dispatches no LLM leg — no speaking_end will ever
    // arrive, exactly like the empty case.
    sock.emitControl({ t: "stt_partial", text: "uh", traceId: "T10" });
    sock.emitControl({ t: "stt_final", text: " \t", traceId: "T10" });
    expect(client.state.phase).toBe("listening");
    expect(client.state.interimTranscript).toBe("");
    expect(client.state.finalTranscript).toBe("");
    await client.stop();
  });

  it.each(["no_response", "error"] as const)(
    "returns from thinking when turn_end reports %s without speaking audio",
    async (outcome) => {
      const mint = makeMintFetch();
      const ws = makeWsFactory();
      const marks: VoiceTraceMark[] = [];
      const client = createVoiceSessionClient({
        agentId: "11111111-1111-1111-1111-111111111111",
        conversationId: "22222222-2222-2222-2222-222222222222",
        getConsentNonce: async () => "terminal",
        fetch: mint.fetch,
        webSocketFactory: ws.factory,
        getUserMedia: fakeGetUserMedia(),
        createMicAudioContext: () => new FakeMicAudioContext(16_000),
        createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
        onTraceMark: (mark) => marks.push(mark),
      });
      await client.start();
      await flush();
      const sock = ws.last();
      sock.emitOpen();
      sock.emitControl({
        t: "ready",
        sessionId: "sess-terminal",
        traceId: "T-terminal",
      });
      await flush();

      sock.emitControl({
        t: "stt_final",
        text: "please respond",
        traceId: "T-terminal",
      });
      expect(client.state.phase).toBe("thinking");

      sock.emitControl({ t: "turn_end", outcome, traceId: "T-terminal" });

      expect(client.state.phase).toBe("listening");
      expect(marks.map((mark) => mark.name)).toContain(`turn_end(${outcome})`);
      await client.stop();
    },
  );

  it("recovers from a malformed turn_end at terminal usage without stranding Thinking", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const marks: VoiceTraceMark[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "malformed",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onTraceMark: (mark) => marks.push(mark),
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({
      t: "ready",
      sessionId: "sess-malformed",
      traceId: "T-malformed",
    });
    await flush();

    sock.emitControl({
      t: "stt_final",
      text: "please respond",
      traceId: "T-malformed",
    });
    expect(client.state.phase).toBe("thinking");

    sock.emitControl({ t: "turn_end", traceId: "T-malformed" });

    expect(client.state.phase).toBe("thinking");
    expect(marks.map((mark) => mark.name)).toContain(
      "not_reached(unparseable_control)",
    );

    sock.emitControl({
      t: "usage",
      sttMs: 100,
      ttsChars: 0,
      traceId: "T-malformed",
    });
    expect(client.state.phase).toBe("listening");
    await client.stop();
  });

  it("barge-in flushes local playback BEFORE the server interrupted ack, then reconciles", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const pbCtx = new FakePlaybackAudioContext(16_000);
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "n",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => pbCtx,
      now: () => 1,
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
    await flush();
    await client.unlockPlayback();
    sock.emitControl({ t: "speaking_start", traceId: "T1" });
    // Fill the playback queue with audible audio.
    sock.emitAudio(floatSpeaking(200));
    expect(client.state.phase).toBe("speaking");

    // Barge-in: local flush happens NOW, and the barge_in control is sent,
    // WITHOUT any server interrupted event yet.
    client.bargeIn();
    // Optimistic state: speaking → listening pre-ack.
    expect(client.state.phase).toBe("listening");
    // Playback queue is empty already → a pull yields pure silence.
    const outPreAck = playbackScriptNodeOf(pbCtx).render(100);
    expect(outPreAck.every((v) => v === 0)).toBe(true);
    // barge_in control frame was sent to the server.
    expect(sock.sentControls().some((c) => c.t === "barge_in")).toBe(true);

    // Now the server's authoritative interrupted arrives → reconcile (idempotent).
    sock.emitControl({ t: "interrupted", reason: "explicit", traceId: "T1" });
    expect(client.state.phase).toBe("listening");
    await client.stop();
  });

  it("provisionally pauses on local speech and resumes retained audio after no server confirmation", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const micCtx = new FakeMicAudioContext(16_000);
    const pbCtx = new FakePlaybackAudioContext(16_000);
    const marks: VoiceTraceMark[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "n",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => micCtx,
      createPlaybackAudioContext: () => pbCtx,
      onTraceMark: (mark) => marks.push(mark),
      provisionalBargeIn: { confirmationTimeoutMs: 350 },
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T-local" });
    await flush();
    await client.unlockPlayback();
    sock.emitControl({ t: "speaking_start", traceId: "T-local" });
    sock.emitAudio(floatSpeaking(200));

    vi.useFakeTimers();
    try {
      micCtx.scriptNode?.feed(new Float32Array(4096).fill(0.1));
      expect(marks.map((mark) => mark.name)).toContain("local_speech_start");
      expect(
        playbackScriptNodeOf(pbCtx)
          .render(100)
          .every((value) => value === 0),
      ).toBe(true);
      expect(sock.sentControls().some((frame) => frame.t === "barge_in")).toBe(
        false,
      );

      await vi.advanceTimersByTimeAsync(350);
      const resumed = playbackScriptNodeOf(pbCtx).render(100);
      expect(resumed.some((value) => value !== 0)).toBe(true);
      expect(marks.map((mark) => mark.name)).toContain(
        "local_speech_start_unconfirmed",
      );
    } finally {
      vi.useRealTimers();
      await client.stop();
    }
  });

  it("flushes provisionally paused audio when server STT confirms speech", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const micCtx = new FakeMicAudioContext(16_000);
    const pbCtx = new FakePlaybackAudioContext(16_000);
    const marks: VoiceTraceMark[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "n",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => micCtx,
      createPlaybackAudioContext: () => pbCtx,
      onTraceMark: (mark) => marks.push(mark),
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T-confirm" });
    await flush();
    await client.unlockPlayback();
    sock.emitControl({ t: "speaking_start", traceId: "T-confirm" });
    sock.emitAudio(floatSpeaking(200));
    micCtx.scriptNode?.feed(new Float32Array(4096).fill(0.1));

    sock.emitControl({
      t: "stt_partial",
      text: "wait",
      traceId: "T-confirm",
    });

    expect(
      playbackScriptNodeOf(pbCtx)
        .render(200)
        .every((value) => value === 0),
    ).toBe(true);
    expect(marks.map((mark) => mark.name)).toContain(
      "local_speech_start_confirmed",
    );
    expect(sock.sentControls().some((frame) => frame.t === "barge_in")).toBe(
      false,
    );
    await client.stop();
  });

  it("resumes a buffered tail when punctuation-only STT ends no_response", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const micCtx = new FakeMicAudioContext(16_000);
    const pbCtx = new FakePlaybackAudioContext(16_000);
    const marks: VoiceTraceMark[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "punctuation-false-start",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => micCtx,
      createPlaybackAudioContext: () => pbCtx,
      onTraceMark: (mark) => marks.push(mark),
      provisionalBargeIn: { confirmationTimeoutMs: 350 },
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T-old" });
    await flush();
    await client.unlockPlayback();
    sock.emitControl({ t: "speaking_start", traceId: "T-old" });
    sock.emitAudio(floatSpeaking(300));
    sock.emitControl({ t: "speaking_end", traceId: "T-old" });

    vi.useFakeTimers();
    try {
      micCtx.scriptNode?.feed(new Float32Array(4096).fill(0.1));
      expect(marks.map((mark) => mark.name)).toContain("local_speech_start");
      expect(
        playbackScriptNodeOf(pbCtx)
          .render(100)
          .every((value) => value === 0),
      ).toBe(true);

      sock.emitControl({ t: "stt_final", text: "...", traceId: "T-noise" });
      sock.emitControl({
        t: "usage",
        sttMs: 100,
        ttsChars: 0,
        traceId: "T-noise",
      });
      sock.emitControl({
        t: "turn_end",
        outcome: "no_response",
        traceId: "T-noise",
      });

      const resumed = playbackScriptNodeOf(pbCtx).render(300);
      expect(resumed.some((value) => value !== 0)).toBe(true);
      expect(marks.map((mark) => mark.name)).toContain(
        "local_speech_start_unconfirmed",
      );
      expect(marks.map((mark) => mark.name)).not.toContain(
        "local_speech_start_confirmed",
      );
      expect(marks.map((mark) => mark.name)).not.toContain(
        "server_speech_start_confirmed",
      );
    } finally {
      vi.useRealTimers();
      await client.stop();
    }
  });

  it("flushes buffered audio when authoritative STT arrives after the provisional timeout", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const micCtx = new FakeMicAudioContext(16_000);
    const pbCtx = new FakePlaybackAudioContext(16_000);
    const marks: VoiceTraceMark[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "late-confirm",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => micCtx,
      createPlaybackAudioContext: () => pbCtx,
      onTraceMark: (mark) => marks.push(mark),
      provisionalBargeIn: { confirmationTimeoutMs: 350 },
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T-late" });
    await flush();
    await client.unlockPlayback();
    sock.emitControl({ t: "speaking_start", traceId: "T-late" });
    sock.emitAudio(floatSpeaking(300));

    vi.useFakeTimers();
    try {
      micCtx.scriptNode?.feed(new Float32Array(4096).fill(0.1));
      await vi.advanceTimersByTimeAsync(350);
      expect(
        playbackScriptNodeOf(pbCtx)
          .render(50)
          .some((value) => value !== 0),
      ).toBe(true);

      sock.emitControl({
        t: "stt_partial",
        text: "late but authoritative",
        traceId: "T-next",
      });

      expect(
        playbackScriptNodeOf(pbCtx)
          .render(400)
          .every((value) => value === 0),
      ).toBe(true);
      expect(marks.map((mark) => mark.name)).toContain(
        "server_speech_start_confirmed",
      );
    } finally {
      vi.useRealTimers();
      await client.stop();
    }
  });

  it.each(["stt_partial", "stt_final", "interrupted"] as const)(
    "flushes a buffered tail on authoritative %s when local onset detection misses",
    async (eventType) => {
      const mint = makeMintFetch();
      const ws = makeWsFactory();
      const pbCtx = new FakePlaybackAudioContext(16_000);
      const marks: VoiceTraceMark[] = [];
      const client = createVoiceSessionClient({
        agentId: "11111111-1111-1111-1111-111111111111",
        conversationId: "22222222-2222-2222-2222-222222222222",
        getConsentNonce: async () => `detector-miss-${eventType}`,
        fetch: mint.fetch,
        webSocketFactory: ws.factory,
        getUserMedia: fakeGetUserMedia(),
        createMicAudioContext: () => new FakeMicAudioContext(16_000),
        createPlaybackAudioContext: () => pbCtx,
        onTraceMark: (mark) => marks.push(mark),
      });
      await client.start();
      await flush();
      const sock = ws.last();
      sock.emitOpen();
      sock.emitControl({
        t: "ready",
        sessionId: "s",
        traceId: "T-missed",
      });
      await flush();
      await client.unlockPlayback();
      sock.emitControl({ t: "speaking_start", traceId: "T-old" });
      sock.emitAudio(floatSpeaking(300));
      sock.emitControl({ t: "speaking_end", traceId: "T-old" });

      sock.emitControl(
        eventType === "interrupted"
          ? { t: eventType, reason: "acoustic", traceId: "T-old" }
          : { t: eventType, text: "next turn", traceId: "T-next" },
      );

      expect(
        playbackScriptNodeOf(pbCtx)
          .render(400)
          .every((value) => value === 0),
      ).toBe(true);
      expect(marks.map((mark) => mark.name)).toContain(
        "server_speech_start_confirmed",
      );
      await client.stop();
    },
  );

  it("forces old buffered response audio silent on turn_end(stopped)", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const pbCtx = new FakePlaybackAudioContext(16_000);
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "stopped-terminal",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => pbCtx,
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T-stop" });
    await flush();
    await client.unlockPlayback();
    sock.emitControl({ t: "speaking_start", traceId: "T-old" });
    sock.emitAudio(floatSpeaking(300));
    sock.emitControl({ t: "speaking_end", traceId: "T-old" });

    sock.emitControl({ t: "turn_end", outcome: "stopped", traceId: "T-old" });

    expect(client.state.phase).toBe("listening");
    expect(
      playbackScriptNodeOf(pbCtx)
        .render(400)
        .every((value) => value === 0),
    ).toBe(true);
    await client.stop();
  });

  it("does not provisionally interrupt playback while the microphone is muted", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const micCtx = new FakeMicAudioContext(16_000);
    const pbCtx = new FakePlaybackAudioContext(16_000);
    const marks: VoiceTraceMark[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "muted-onset",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => micCtx,
      createPlaybackAudioContext: () => pbCtx,
      onTraceMark: (mark) => marks.push(mark),
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T-muted" });
    await flush();
    await client.unlockPlayback();
    sock.emitControl({ t: "speaking_start", traceId: "T-muted" });
    sock.emitAudio(floatSpeaking(200));
    client.setMicrophoneMuted(true);

    micCtx.scriptNode?.feed(new Float32Array(4096).fill(0.1));

    expect(marks.map((mark) => mark.name)).not.toContain("local_speech_start");
    expect(
      playbackScriptNodeOf(pbCtx)
        .render(100)
        .some((value) => value !== 0),
    ).toBe(true);
    await client.stop();
  });

  it("keeps buffered browser audio interruptible after server speaking_end", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const micCtx = new FakeMicAudioContext(16_000);
    const pbCtx = new FakePlaybackAudioContext(16_000);
    const marks: VoiceTraceMark[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "tail",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => micCtx,
      createPlaybackAudioContext: () => pbCtx,
      onTraceMark: (mark) => marks.push(mark),
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T-tail" });
    await flush();
    await client.unlockPlayback();
    sock.emitControl({ t: "speaking_start", traceId: "T-tail" });
    sock.emitAudio(floatSpeaking(300));
    sock.emitControl({ t: "speaking_end", traceId: "T-tail" });
    expect(client.state.phase).toBe("listening");

    micCtx.scriptNode?.feed(new Float32Array(4096).fill(0.1));
    expect(marks.map((mark) => mark.name)).toContain("local_speech_start");
    expect(
      playbackScriptNodeOf(pbCtx)
        .render(100)
        .every((value) => value === 0),
    ).toBe(true);

    sock.emitControl({ t: "stt_partial", text: "wait", traceId: "T-next" });
    expect(marks.map((mark) => mark.name)).toContain(
      "local_speech_start_confirmed",
    );
    expect(
      playbackScriptNodeOf(pbCtx)
        .render(300)
        .every((value) => value === 0),
    ).toBe(true);
    await client.stop();
  });

  it("disarms tail interruption after the browser playback queue drains", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const micCtx = new FakeMicAudioContext(16_000);
    const pbCtx = new FakePlaybackAudioContext(16_000);
    const marks: VoiceTraceMark[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "drained-tail",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => micCtx,
      createPlaybackAudioContext: () => pbCtx,
      onTraceMark: (mark) => marks.push(mark),
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T-drained" });
    await flush();
    await client.unlockPlayback();
    sock.emitControl({ t: "speaking_start", traceId: "T-drained" });
    sock.emitAudio(floatSpeaking(100));
    sock.emitControl({ t: "speaking_end", traceId: "T-drained" });
    playbackScriptNodeOf(pbCtx).render(300);
    expect(marks.map((mark) => mark.name)).toContain("playback_drained");

    micCtx.scriptNode?.feed(new Float32Array(4096).fill(0.1));

    expect(marks.map((mark) => mark.name)).not.toContain("local_speech_start");
    await client.stop();
  });

  it("re-mints a FRESH token on a non-clean close (revoked/expired can't reconnect)", async () => {
    const mint = makeMintFetch([{ token: "tok-A" }, { token: "tok-B" }]);
    const ws = makeWsFactory();
    const { client, marks } = baseDeps(mint, ws);
    await client.start();
    await flush();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();
    expect(first.sentControls()[0].token).toBe("tok-A");

    // Abnormal close → reconnect via RE-MINT (new socket, fresh token).
    first.emitClose(1006, "abnormal");
    await flush();
    expect(mint.calls.length).toBe(2); // minted again
    const second = ws.last();
    expect(second).not.toBe(first);
    // Late callbacks from the detached transport are ignored by socket
    // identity, even though the browser/fake still holds its listeners.
    first.emitControl({ t: "stt_final", text: "stale", traceId: "OLD" });
    expect(client.state.finalTranscript).toBe("");
    second.emitOpen();
    const secondHello = second.sentControls()[0];
    expect(secondHello.t).toBe("hello");
    // Fresh token, NOT the revoked/expired old one.
    expect(secondHello.token).toBe("tok-B");
    expect(secondHello.token).not.toBe("tok-A");
    expect(marks.some((m) => m.name.startsWith("reconnect_remint"))).toBe(true);
    await client.stop();
  });

  it("re-mints and tears down a live mic on an unexpected clean close", async () => {
    const mint = makeMintFetch([{}, {}]);
    const ws = makeWsFactory();
    const firstMicContext = new FakeMicAudioContext(16_000);
    let micContextCreates = 0;
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => `nonce-${mint.calls.length + 1}`,
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () =>
        micContextCreates++ === 0
          ? firstMicContext
          : new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
    });
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();
    expect(client.state.phase).toBe("listening");
    sock.emitClose(1000, "normal");
    await flush();
    expect(firstMicContext.closed).toBe(true);
    expect(mint.calls.length).toBe(2);
    expect(ws.sockets).toHaveLength(2);
    await client.stop();
  });

  it("publishes connecting before a delayed mic teardown completes", async () => {
    const micClose = deferred<void>();
    class DeferredMicCloseContext extends FakeMicAudioContext {
      override async close(): Promise<void> {
        await micClose.promise;
        await super.close();
      }
    }
    const mint = makeMintFetch([{}, {}]);
    const ws = makeWsFactory();
    const phases: string[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => `nonce-${mint.calls.length + 1}`,
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new DeferredMicCloseContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onState: (next) => phases.push(next.phase),
    });

    await client.start();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await vi.waitFor(() => expect(client.state.phase).toBe("listening"));

    first.emitClose(1006, "transport lost");
    expect(client.state.phase).toBe("connecting");
    expect(phases.at(-1)).toBe("connecting");
    expect(ws.sockets).toHaveLength(1);

    micClose.resolve();
    await vi.waitFor(() => expect(ws.sockets).toHaveLength(2));
    await client.stop();
  });

  it("uses a fresh one-use consent nonce for every reconnect mint", async () => {
    const ws = makeWsFactory();
    const calls: Array<Record<string, unknown>> = [];
    const seenNonces = new Set<string>();
    let nonceNumber = 0;
    const fetch = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      const nonce = String(body.consentNonce ?? "");
      if (seenNonces.has(nonce)) {
        return new Response(JSON.stringify({ error: "nonce_replayed" }), {
          status: 409,
        });
      }
      seenNonces.add(nonce);
      const n = calls.length;
      return new Response(
        JSON.stringify({
          sessionId: `sess-${n}`,
          wsUrl: `wss://cloud/ws?sessionId=sess-${n}`,
          token: `tok-${n}`,
          expiresAt: Date.now() + 60_000,
          uplink: { codecs: ["pcm16"] },
          downlink: { codecs: ["pcm16"] },
          iceServers: null,
        }),
      );
    };
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => `one-use-${++nonceNumber}`,
      fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onError: (error) => errors.push(error),
    });

    await client.start();
    ws.last().emitOpen();
    ws.last().emitClose(1006, "reconnect");
    await flush();

    expect(calls.map((call) => call.consentNonce)).toEqual([
      "one-use-1",
      "one-use-2",
    ]);
    expect(errors).toEqual([]);
    expect(ws.sockets).toHaveLength(2);
    await client.stop();
  });

  it("cancels a reconnect waiting on fresh consent when stop wins the race", async () => {
    const reconnectConsent = deferred<string | null>();
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const errors: Error[] = [];
    let consentCalls = 0;
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: () => {
        consentCalls += 1;
        return consentCalls === 1
          ? Promise.resolve("initial-nonce")
          : reconnectConsent.promise;
      },
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onError: (error) => errors.push(error),
    });

    await client.start();
    const first = ws.last();
    first.emitOpen();
    first.emitClose(1006, "reconnect");
    await flush();
    expect(consentCalls).toBe(2);

    await client.stop();
    reconnectConsent.resolve("late-reconnect-nonce");
    await flush();

    expect(mint.calls).toHaveLength(1);
    expect(ws.sockets).toHaveLength(1);
    expect(client.state.phase).toBe("idle");
    expect(errors).toEqual([]);
  });

  it("gives up after maxReconnects and surfaces an error", async () => {
    const mint = makeMintFetch([{}, {}, {}]);
    const ws = makeWsFactory();
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "n",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onError: (e) => errors.push(e),
      maxReconnects: 1,
      now: () => 1,
    });
    await client.start();
    await flush();
    ws.last().emitOpen();
    ws.last().emitClose(1006); // reconnect #1
    await flush();
    ws.last().emitOpen();
    ws.last().emitClose(1006); // exhausted
    await flush();
    expect(errors.some((e) => /voice session lost/.test(e.message))).toBe(true);
  });

  it("survives a malformed / unparseable server frame without killing the session", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const { client, marks } = baseDeps(mint, ws);
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
    await flush();
    // Garbage text frame + unknown type + a non-string/non-binary frame.
    sock.emitRaw("this is not json");
    sock.emitControl({ t: "totally_unknown", foo: 1 });
    sock.emitRaw(12345 as unknown);
    // Session still alive: a normal event afterward still processes.
    sock.emitControl({ t: "stt_final", text: "still here", traceId: "T1" });
    expect(client.state.finalTranscript).toBe("still here");
    // Malformed frames recorded as not_reached, never synthesized.
    expect(marks.some((m) => m.name.startsWith("not_reached("))).toBe(true);
    await client.stop();
  });

  it("a fatal (non-retryable) server error tears down and re-mints", async () => {
    const mint = makeMintFetch([{ token: "A" }, { token: "B" }]);
    const ws = makeWsFactory();
    const { client } = baseDeps(mint, ws);
    await client.start();
    await flush();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
    await flush();
    first.emitControl({ t: "error", code: "invalid_token", retryable: false });
    await flush();
    // Re-minted a fresh session.
    expect(mint.calls.length).toBe(2);
    await client.stop();
  });

  it("serializes fatal-error recovery with the socket close callback", async () => {
    const mint = makeMintFetch([{ token: "A" }, { token: "B" }]);
    const ws = makeWsFactory();
    const { client } = baseDeps(mint, ws);
    await client.start();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "error", code: "invalid_token", retryable: false });
    // Browsers normally deliver close after the fatal frame. It must not start
    // a second concurrent re-mint or consume another retry slot.
    first.emitClose(1006, "fatal");
    await flush();

    expect(mint.calls).toHaveLength(2);
    expect(ws.sockets).toHaveLength(2);
    await client.stop();
  });

  it("discards playback setup that resolves after stop without resurrecting state", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const moduleLoad = deferred<void>();
    const addModule = vi.fn(() => moduleLoad.promise);
    class DeferredPlaybackContext extends FakePlaybackAudioContext {
      readonly audioWorklet = {
        addModule,
      };
    }
    const playbackContext = new DeferredPlaybackContext(16_000);
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "never-reached",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      createPlaybackAudioContext: () => playbackContext,
      onError: (error) => errors.push(error),
    });

    const starting = client.start();
    await vi.waitFor(() => expect(addModule).toHaveBeenCalledTimes(1));
    await client.stop();
    // Stop owns the provisional context even while the browser promise hangs.
    expect(playbackContext.closed).toBe(true);
    moduleLoad.resolve();
    await starting;

    expect(playbackContext.closed).toBe(true);
    expect(mint.calls).toHaveLength(0);
    expect(ws.sockets).toHaveLength(0);
    expect(client.state.phase).toBe("idle");
    expect(errors).toEqual([]);
  });

  it("ignores a deferred mint response that arrives after stop", async () => {
    const mintResponse = deferred<Response>();
    const mintCalls: Array<Record<string, unknown>> = [];
    const ws = makeWsFactory();
    const playbackContext = new FakePlaybackAudioContext(16_000);
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "nonce-before-stop",
      fetch: async (_url, init) => {
        mintCalls.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return mintResponse.promise;
      },
      webSocketFactory: ws.factory,
      createPlaybackAudioContext: () => playbackContext,
      onError: (error) => errors.push(error),
    });

    const starting = client.start();
    await flush();
    expect(mintCalls).toHaveLength(1);
    await client.stop();
    mintResponse.resolve(
      new Response(
        JSON.stringify({
          sessionId: "late",
          wsUrl: "wss://cloud/ws?sessionId=late",
          token: "late-token",
          expiresAt: Date.now() + 60_000,
          uplink: { codecs: ["pcm16"] },
          downlink: { codecs: ["pcm16"] },
          iceServers: null,
        }),
      ),
    );
    await starting;

    expect(playbackContext.closed).toBe(true);
    expect(ws.sockets).toHaveLength(0);
    expect(client.state.phase).toBe("idle");
    expect(errors).toEqual([]);
  });

  it("stops media acquired after stop while getUserMedia was pending", async () => {
    const media = deferred<MediaStream>();
    const stopTrack = vi.fn();
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const micContext = new FakeMicAudioContext(16_000);
    const createMicAudioContext = vi.fn(() => micContext);
    const playbackContext = new FakePlaybackAudioContext(16_000);
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "nonce-1",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: () => media.promise,
      createMicAudioContext,
      createPlaybackAudioContext: () => playbackContext,
      onError: (error) => errors.push(error),
    });

    await client.start();
    const socket = ws.last();
    socket.emitOpen();
    socket.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
    await Promise.resolve();
    await client.stop();
    media.resolve({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream);
    await flush();

    expect(stopTrack).toHaveBeenCalledTimes(1);
    // Cancellation wins before AudioContext construction; there is no graph to
    // close after the late media promise settles.
    expect(createMicAudioContext).not.toHaveBeenCalled();
    expect(micContext.closed).toBe(false);
    expect(playbackContext.closed).toBe(true);
    expect(client.state.phase).toBe("idle");
    expect(errors).toEqual([]);
  });

  it("reacquires a changed microphone on the live socket without reminting", async () => {
    const tracks = [0, 1].map(() =>
      Object.assign(new EventTarget(), {
        kind: "audio",
        stop: vi.fn(),
        getSettings: () => ({ sampleRate: 16_000, channelCount: 1 }),
      }),
    ) as unknown as MediaStreamTrack[];
    let mediaIndex = 0;
    const getUserMedia = vi.fn(async () => {
      const track = tracks[Math.min(mediaIndex, tracks.length - 1)];
      mediaIndex += 1;
      return {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      } as unknown as MediaStream;
    });
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const marks: VoiceTraceMark[] = [];
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "device-change",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia,
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onTraceMark: (mark) => marks.push(mark),
      onError: (error) => errors.push(error),
    });

    await client.start();
    const socket = ws.last();
    socket.emitOpen();
    socket.emitControl({ t: "ready", sessionId: "s", traceId: "T-device" });
    await flush();
    expect(client.state.phase).toBe("listening");
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    tracks[0]?.dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(marks.map((mark) => mark.name)).toEqual(
        expect.arrayContaining(["mic_device_lost", "mic_device_recovered"]),
      ),
    );

    expect(mint.calls).toHaveLength(1);
    expect(ws.sockets).toHaveLength(1);
    expect(client.state.phase).toBe("listening");
    expect(errors).toEqual([]);
    await client.stop();
  });

  it("reconnect cancels stalled AudioWorklet setup before starting a new mic", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeVoiceAudioWorkletNode);
    const moduleLoad = deferred<void>();
    const addModule = vi.fn(() => moduleLoad.promise);
    const firstMicContext = new FakeMicWorkletAudioContext(16_000);
    Object.defineProperty(firstMicContext, "audioWorklet", {
      value: { addModule },
    });
    const secondMicContext = new FakeMicAudioContext(16_000);
    const micContexts = [firstMicContext, secondMicContext];
    const trackStops = [vi.fn(), vi.fn()];
    let mediaCount = 0;
    let contextCount = 0;
    const mint = makeMintFetch([{ token: "A" }, { token: "B" }]);
    const ws = makeWsFactory();
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => `nonce-${mint.calls.length + 1}`,
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: async () => {
        const stop = trackStops[mediaCount];
        mediaCount += 1;
        return {
          getTracks: () => [{ stop }],
        } as unknown as MediaStream;
      },
      createMicAudioContext: () => {
        const context = micContexts[contextCount];
        contextCount += 1;
        return context;
      },
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onError: (error) => errors.push(error),
    });

    await client.start();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await vi.waitFor(() => expect(addModule).toHaveBeenCalledTimes(1));
    expect(mediaCount).toBe(1);

    first.emitClose(1006, "reconnect");
    await vi.waitFor(() => {
      expect(trackStops[0]).toHaveBeenCalledTimes(1);
      expect(firstMicContext.closed).toBe(true);
      expect(ws.sockets).toHaveLength(2);
    });

    const second = ws.last();
    second.emitOpen();
    second.emitControl({ t: "ready", sessionId: "s2", traceId: "T2" });
    await vi.waitFor(() => {
      expect(mediaCount).toBe(2);
      expect(client.state.phase).toBe("listening");
    });
    expect(trackStops[1]).not.toHaveBeenCalled();
    expect(errors).toEqual([]);

    // The abandoned browser promise may resolve later without reviving capture.
    moduleLoad.resolve();
    await client.stop();
    expect(trackStops[1]).toHaveBeenCalledTimes(1);
    expect(secondMicContext.closed).toBe(true);
  });

  it("an old stop cannot close or idle a replacement playback lifecycle", async () => {
    const micClose = deferred<void>();
    const playbackClose = deferred<void>();
    class DeferredMicCloseContext extends FakeMicAudioContext {
      override async close(): Promise<void> {
        await micClose.promise;
        await super.close();
      }
    }
    class DeferredPlaybackCloseContext extends FakePlaybackAudioContext {
      override async close(): Promise<void> {
        await playbackClose.promise;
        await super.close();
      }
    }
    const firstMic = new DeferredMicCloseContext(16_000);
    const firstPlayback = new DeferredPlaybackCloseContext(16_000);
    const secondPlayback = new FakePlaybackAudioContext(16_000);
    const playbackContexts = [firstPlayback, secondPlayback];
    let playbackCount = 0;
    const mint = makeMintFetch([{ token: "A" }, { token: "B" }]);
    const ws = makeWsFactory();
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => `nonce-${mint.calls.length + 1}`,
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => firstMic,
      createPlaybackAudioContext: () => {
        const context = playbackContexts[playbackCount];
        playbackCount += 1;
        return context;
      },
    });

    await client.start();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await vi.waitFor(() => expect(client.state.phase).toBe("listening"));

    // Transport loss makes the connection reusable while old mic teardown is
    // still pending. Starting again during stop exercises lifecycle ownership.
    first.emitClose(1006, "old transport");
    const stopping = client.stop();
    const restarting = client.start();
    await vi.waitFor(() => expect(playbackCount).toBe(2));

    playbackClose.resolve();
    await stopping;
    await restarting;
    expect(secondPlayback.closed).toBe(false);
    expect(client.state.phase).toBe("connecting");
    expect(ws.sockets).toHaveLength(2);

    micClose.resolve();
    await flush();
    expect(secondPlayback.closed).toBe(false);
    expect(client.state.phase).toBe("connecting");
    await client.stop();
    expect(secondPlayback.closed).toBe(true);
  });

  it("a retryable server error does NOT tear down the session", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const { client } = baseDeps(mint, ws);
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
    await flush();
    sock.emitControl({ t: "error", code: "audio_too_large", retryable: true });
    sock.emitControl({ t: "stt_final", text: "ok", traceId: "T1" });
    expect(client.state.finalTranscript).toBe("ok");
    expect(mint.calls.length).toBe(1);
    await client.stop();
  });

  it("makes a discarded Ink partial recoverable instead of staying transcribing", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const { client, marks } = baseDeps(mint, ws);
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T-lost" });
    await flush();
    sock.emitControl({
      t: "stt_partial",
      text: "unfinished words",
      traceId: "T-lost",
    });
    expect(client.state.phase).toBe("transcribing");

    sock.emitControl({
      t: "error",
      code: "stt_reconnecting",
      retryable: true,
    });

    expect(client.state.phase).toBe("listening");
    expect(client.state.interimTranscript).toBe("");
    expect(marks.map((mark) => mark.name)).toContain(
      "stt_turn_lost(reconnecting)",
    );
    expect(mint.calls.length).toBe(1);
    await client.stop();
  });

  it("stop() sends a clean bye then closes with code 1000", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const { client } = baseDeps(mint, ws);
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
    await flush();
    await client.stop();
    expect(sock.sentControls().some((c) => c.t === "bye")).toBe(true);
    expect(sock.closed?.code).toBe(1000);
  });

  it("maps a 404 mint to a feature-disabled error (batch fallback signal)", async () => {
    const err = new VoiceSessionMintError(404);
    expect(err.isFeatureDisabled).toBe(true);
    expect(new VoiceSessionMintError(500).isFeatureDisabled).toBe(false);
  });

  it("surfaces a mint 404 through onError so the caller can fall back to batch", async () => {
    const mint = makeMintFetch([{ status: 404 }]);
    const ws = makeWsFactory();
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => "n",
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onError: (e) => errors.push(e),
      now: () => 1,
    });
    await client.start();
    await flush();
    expect(
      errors.some(
        (e) =>
          e instanceof VoiceSessionMintError &&
          (e as VoiceSessionMintError).status === 404,
      ),
    ).toBe(true);
    // No socket ever opened.
    expect(ws.sockets.length).toBe(0);
  });
});

/** Build a downlink audio frame that decodes to audible (non-zero) samples. */
function floatSpeaking(samples: number): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, 16384, true);
  return out;
}

describe("transport-loss recovery (stop-class hardening)", () => {
  function recoveryClient(
    mint: ReturnType<typeof makeMintFetch>,
    ws: ReturnType<typeof makeWsFactory>,
    overrides: Partial<Parameters<typeof createVoiceSessionClient>[0]> = {},
  ) {
    const marks: VoiceTraceMark[] = [];
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      getConsentNonce: async () => `nonce-${mint.calls.length + 1}`,
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: fakeGetUserMedia(),
      createMicAudioContext: () => new FakeMicAudioContext(16_000),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(16_000),
      onTraceMark: (m) => marks.push(m),
      onError: (e) => errors.push(e),
      preLiveMaxAttempts: 1,
      preLiveRetryDelayMs: 0,
      reconnectBackoffMs: 1,
      // Rotation is opt-in per test; keep it inert unless a test arms it.
      rotationLeadMs: 0,
      ...overrides,
    });
    return { client, marks, errors };
  }

  async function settleTimers(ms = 25): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    await flush();
  }

  it("a transport drop MID-UTTERANCE re-mints and returns to listening", async () => {
    const mint = makeMintFetch([{ token: "A" }, { token: "B" }]);
    const ws = makeWsFactory();
    const { client, errors } = recoveryClient(mint, ws);
    await client.start();
    await flush();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();
    first.emitControl({ t: "speaking_start", traceId: "T1" });
    expect(client.state.phase).toBe("speaking");

    // The wifi-switch class: the socket dies while the agent is speaking.
    first.emitClose(1006, "network change");
    await settleTimers();
    expect(mint.calls).toHaveLength(2);
    const second = ws.last();
    expect(second).not.toBe(first);
    second.emitOpen();
    second.emitControl({ t: "ready", sessionId: "s2", traceId: "T2" });
    await flush();
    expect(client.state.phase).toBe("listening");
    expect(errors).toEqual([]);
    await client.stop();
  });

  it("a transient re-mint failure consumes the NEXT budgeted attempt instead of dying", async () => {
    const mint = makeMintFetch([{}, { status: 500 }, { status: 500 }, {}]);
    const ws = makeWsFactory();
    const { client, errors } = recoveryClient(mint, ws, { maxReconnects: 3 });
    await client.start();
    await flush();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();

    first.emitClose(1006, "network change");
    // Attempts 2 and 3 wait the (tiny) growing backoff before re-minting.
    // A fixed sleep races timer starvation on loaded CI runners, so wait on
    // the condition itself instead of a wall-clock guess.
    await vi.waitFor(() => expect(mint.calls).toHaveLength(4), {
      timeout: 5_000,
    });
    await vi.waitFor(() => expect(ws.sockets).toHaveLength(2), {
      timeout: 5_000,
    });
    expect(errors).toEqual([]);
    await client.stop();
  });

  it("recovery give-up is transport-shaped, never a mint/consent latch", async () => {
    const mint = makeMintFetch([{}, { status: 500 }]);
    const ws = makeWsFactory();
    const { client, errors } = recoveryClient(mint, ws, { maxReconnects: 1 });
    await client.start();
    await flush();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();

    first.emitClose(1006, "outage");
    await settleTimers(40);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/voice session lost/);
    // The underlying fault is preserved as the cause, not surfaced as the
    // primary error (a raw mint error would latch realtime off in the hook).
    expect(errors[0].cause).toBeInstanceOf(VoiceSessionMintError);
    expect(client.state.phase).toBe("idle");
    await client.stop();
  });

  it("a session healthy past the reset window refills the reconnect budget", async () => {
    const mint = makeMintFetch([{}, {}, {}]);
    const ws = makeWsFactory();
    let clock = 0;
    const { client, errors } = recoveryClient(mint, ws, {
      maxReconnects: 1,
      reconnectBudgetResetMs: 1_000,
      now: () => clock,
    });
    await client.start();
    await flush();
    ws.last().emitOpen();
    ws.last().emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();

    clock = 5_000; // healthy for 5s >= 1s reset window
    ws.last().emitClose(1006, "drop 1");
    await settleTimers();
    ws.last().emitOpen();
    ws.last().emitControl({ t: "ready", sessionId: "s2", traceId: "T2" });
    await flush();

    clock = 10_000; // healthy again — the budget must have refilled
    ws.last().emitClose(1006, "drop 2");
    await settleTimers();
    expect(mint.calls).toHaveLength(3);
    expect(ws.sockets).toHaveLength(3);
    expect(errors).toEqual([]);
    await client.stop();
  });

  it("a connect-die loop does NOT refill the budget and stays bounded", async () => {
    const mint = makeMintFetch([{}, {}, {}]);
    const ws = makeWsFactory();
    let clock = 0;
    const { client, errors } = recoveryClient(mint, ws, {
      maxReconnects: 1,
      reconnectBudgetResetMs: 1_000,
      now: () => clock,
    });
    await client.start();
    await flush();
    ws.last().emitOpen();
    ws.last().emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();

    clock = 100; // died within the window — no refill
    ws.last().emitClose(1006, "drop 1");
    await settleTimers();
    ws.last().emitOpen();
    ws.last().emitControl({ t: "ready", sessionId: "s2", traceId: "T2" });
    await flush();

    clock = 200; // still inside the window
    ws.last().emitClose(1006, "drop 2");
    await settleTimers();
    expect(errors.some((e) => /voice session lost/.test(e.message))).toBe(true);
    expect(client.state.phase).toBe("idle");
    expect(mint.calls).toHaveLength(2);
  });

  it("quota_exhausted is terminal: no re-mint, a typed stop instead", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const { client, errors } = recoveryClient(mint, ws);
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();

    sock.emitControl({ t: "error", code: "quota_exhausted", retryable: false });
    await settleTimers();
    expect(mint.calls).toHaveLength(1);
    expect(ws.sockets).toHaveLength(1);
    expect(errors.some((e) => /quota_exhausted/.test(e.message))).toBe(true);
    expect(client.state.phase).toBe("idle");
  });

  it("rotates the session before token expiry at a listening boundary without consuming budget", async () => {
    const epochMs = Date.now();
    const mint = makeMintFetch([
      { token: "A", expiresAtMs: epochMs + 120 },
      { token: "B", expiresAtMs: epochMs + 60_000 },
      { token: "C", expiresAtMs: epochMs + 60_000 },
    ]);
    const ws = makeWsFactory();
    const { client, marks, errors } = recoveryClient(mint, ws, {
      maxReconnects: 1,
      rotationLeadMs: 90,
      rotationRecheckMs: 10,
      reconnectBudgetResetMs: 1e9,
      epochNow: () => epochMs,
    });
    await client.start();
    await flush();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();

    // Rotation due ~30ms after mint; the session is idle (listening).
    await settleTimers(70);
    expect(marks.some((m) => m.name === "token_rotation")).toBe(true);
    // Clean bye + normal close on the OLD socket — the server sees a
    // completed session, not an error.
    expect(first.sentControls().some((c) => c.t === "bye")).toBe(true);
    expect(first.closed?.code).toBe(1000);
    expect(mint.calls).toHaveLength(2);
    const second = ws.last();
    expect(second).not.toBe(first);
    second.emitOpen();
    expect(second.sentControls()[0]).toMatchObject({ t: "hello", token: "B" });
    second.emitControl({ t: "ready", sessionId: "s2", traceId: "T2" });
    await flush();
    expect(client.state.phase).toBe("listening");
    expect(errors).toEqual([]);

    // The rotation consumed NO budget: a real drop right after still recovers
    // within maxReconnects: 1.
    second.emitClose(1006, "drop after rotation");
    await settleTimers();
    expect(mint.calls).toHaveLength(3);
    expect(errors).toEqual([]);
    await client.stop();
  });

  it("defers a due rotation while a turn is in flight, then rotates at listening", async () => {
    const epochMs = Date.now();
    const mint = makeMintFetch([
      { token: "A", expiresAtMs: epochMs + 2_000 },
      { token: "B", expiresAtMs: epochMs + 60_000 },
    ]);
    const ws = makeWsFactory();
    const { client, marks, errors } = recoveryClient(mint, ws, {
      rotationLeadMs: 1_980,
      rotationRecheckMs: 20,
      epochNow: () => epochMs,
    });
    await client.start();
    await flush();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();
    first.emitControl({ t: "speaking_start", traceId: "T1" });
    expect(client.state.phase).toBe("speaking");

    // Rotation comes due while SPEAKING: it must defer, not cut the audio.
    await settleTimers(80);
    expect(ws.sockets).toHaveLength(1);
    expect(marks.some((m) => m.name === "token_rotation_deferred")).toBe(true);
    expect(marks.some((m) => m.name === "token_rotation")).toBe(false);

    // Turn completes → the deferred rotation fires at the idle boundary.
    first.emitControl({ t: "speaking_end", traceId: "T1" });
    expect(client.state.phase).toBe("listening");
    await settleTimers(80);
    expect(marks.some((m) => m.name === "token_rotation")).toBe(true);
    expect(mint.calls).toHaveLength(2);
    expect(errors).toEqual([]);
    await client.stop();
  });

  it("a completed utterance racing a server close recovers instead of double-tearing", async () => {
    const mint = makeMintFetch([{ token: "A" }, { token: "B" }]);
    const ws = makeWsFactory();
    const { client, errors } = recoveryClient(mint, ws);
    await client.start();
    await flush();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();
    first.emitControl({ t: "speaking_start", traceId: "T1" });
    first.emitControl({ t: "speaking_end", traceId: "T1" });
    // The server severs right on the turn boundary (the 120s expiry class).
    first.emitClose(1000, "expired");
    await settleTimers();
    expect(mint.calls).toHaveLength(2);
    expect(ws.sockets).toHaveLength(2);
    expect(errors).toEqual([]);
    await client.stop();
  });

  it("a completed utterance racing client stop() stays a clean stop — no re-mint", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const { client, errors } = recoveryClient(mint, ws);
    await client.start();
    await flush();
    const first = ws.last();
    first.emitOpen();
    first.emitControl({ t: "ready", sessionId: "s1", traceId: "T1" });
    await flush();
    first.emitControl({ t: "speaking_start", traceId: "T1" });
    first.emitControl({ t: "speaking_end", traceId: "T1" });
    const stopping = client.stop();
    first.emitClose(1000, "client bye");
    await stopping;
    await settleTimers();
    expect(mint.calls).toHaveLength(1);
    expect(ws.sockets).toHaveLength(1);
    expect(client.state.phase).toBe("idle");
    expect(errors).toEqual([]);
  });
});

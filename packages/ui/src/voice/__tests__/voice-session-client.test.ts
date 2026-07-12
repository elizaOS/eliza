import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVoiceSessionClient,
  VoiceSessionMintError,
  type VoiceTraceMark,
} from "../voice-session-client";
import {
  FakeMicAudioContext,
  FakePlaybackAudioContext,
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
      return new Response(JSON.stringify({ error: "nope" }), { status });
    }
    const payload = o.malformed
      ? { sessionId: "", wsUrl: "", token: "" }
      : {
          sessionId: `sess-${n}`,
          wsUrl: `wss://cloud/api/v1/voice/session/ws?sessionId=sess-${n}`,
          token: o.token ?? `tok-${n}`,
          expiresAt: Date.now() + 60_000,
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
    consentNonce: "nonce-1",
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

function playbackScriptNodeOf(ctx: FakePlaybackAudioContext) {
  const node = ctx.scriptNode;
  if (!node) throw new Error("no playback script node created");
  return node;
}

describe("voice-session client (real framing/state/barge-in/reconnect)", () => {
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
      consentNonce: "native-ws",
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
      consentNonce: "invalid-native-ws",
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
      consentNonce: "n",
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
    sock.emitControl({ t: "stt_final", text: "hello", traceId: "T1" });
    expect(client.state.finalTranscript).toBe("hello");
    sock.emitControl({ t: "llm_first_text", traceId: "T1" });
    expect(client.state.phase).toBe("thinking");
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
    expect(markNames).toContain("llm_first_text");
    expect(markNames).toContain("speaking_start");
    expect(markNames).toContain("downlink_audio");
    expect(markNames).toContain("speaking_end");
    // Every server-derived mark carries the turn traceId (not synthesized).
    const sttMark = marks.find((m) => m.name === "stt_final");
    expect(sttMark?.traceId).toBe("T1");
    await client.stop();
  });

  it("barge-in flushes local playback BEFORE the server interrupted ack, then reconciles", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const pbCtx = new FakePlaybackAudioContext(16_000);
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      consentNonce: "n",
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
    second.emitOpen();
    const secondHello = second.sentControls()[0];
    expect(secondHello.t).toBe("hello");
    // Fresh token, NOT the revoked/expired old one.
    expect(secondHello.token).toBe("tok-B");
    expect(secondHello.token).not.toBe("tok-A");
    expect(marks.some((m) => m.name.startsWith("reconnect_remint"))).toBe(true);
    await client.stop();
  });

  it("does NOT reconnect on a clean close (code 1000)", async () => {
    const mint = makeMintFetch();
    const ws = makeWsFactory();
    const { client } = baseDeps(mint, ws);
    await client.start();
    await flush();
    const sock = ws.last();
    sock.emitOpen();
    sock.emitClose(1000, "normal");
    await flush();
    expect(mint.calls.length).toBe(1);
    await client.stop();
  });

  it("gives up after maxReconnects and surfaces an error", async () => {
    const mint = makeMintFetch([{}, {}, {}]);
    const ws = makeWsFactory();
    const errors: Error[] = [];
    const client = createVoiceSessionClient({
      agentId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
      consentNonce: "n",
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
      consentNonce: "n",
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

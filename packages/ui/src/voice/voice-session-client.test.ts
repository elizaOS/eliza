/** Verifies the realtime voice-session client (mint → WSS hello framing → machine folds → recovery/rotation contracts) against injected transport/audio fakes. */
import { describe, expect, it, vi } from "vitest";
import {
  createVoiceSessionClient,
  type VoiceSessionClientOptions,
  VoiceSessionConsentError,
  VoiceSessionMintError,
  type VoiceWebSocketLike,
} from "./voice-session-client";
import type {
  MicAudioContextLike,
  ScriptProcessorNodeLike,
} from "./voice-session-mic-capture";
import type { PlaybackAudioContextLike } from "./voice-session-playback";
import {
  VOICE_SESSION_PROTOCOL_VERSION,
  VOICE_SESSION_SAMPLE_RATE,
  type VoiceSessionMintResponse,
} from "./voice-session-protocol";

class FakeVoiceSocket {
  binaryType = "arraybuffer";
  readonly sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  readonly closedWith: { code?: number; reason?: string }[] = [];
  private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

  constructor(readonly url: string) {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith.push({ code, reason });
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emitOpen(): void {
    for (const l of [...(this.listeners.get("open") ?? [])]) l();
  }

  emitMessage(data: unknown): void {
    for (const l of [...(this.listeners.get("message") ?? [])]) l({ data });
  }

  emitClose(code = 1006, reason = ""): void {
    for (const l of [...(this.listeners.get("close") ?? [])])
      l({ code, reason });
  }

  textFrames(): Record<string, unknown>[] {
    return this.sent
      .filter((item): item is string => typeof item === "string")
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function audioNode<T>(): T {
  const node = {
    connect: () => node,
    disconnect: () => undefined,
  };
  return node as unknown as T;
}

function scriptNode<T>(): T {
  const node = {
    onaudioprocess: null,
    connect: () => node,
    disconnect: () => undefined,
  };
  return node as unknown as T;
}

function makeStreamTrack() {
  const track = { stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, stopTrack: track.stop };
}

function makeMicContext(sampleRate = 16000) {
  const created: ScriptProcessorNodeLike[] = [];
  const contexts: { closed: boolean }[] = [];
  return {
    created,
    contexts,
    factory: (): MicAudioContextLike => {
      const record = { closed: false };
      contexts.push(record);
      const ctx: MicAudioContextLike = {
        sampleRate,
        state: "running",
        destination: audioNode(),
        resume: () => Promise.resolve(),
        suspend: () => Promise.resolve(),
        close: () => {
          record.closed = true;
          return Promise.resolve();
        },
        createMediaStreamSource: () => audioNode(),
        createScriptProcessor: () => {
          const script = scriptNode<ScriptProcessorNodeLike>();
          created.push(script);
          return script;
        },
      };
      return ctx;
    },
  };
}

function makePlaybackContext(running = true) {
  const state: AudioContextState = running ? "running" : "suspended";
  const record = { closed: false };
  const ctx: PlaybackAudioContextLike = {
    sampleRate: 16000,
    get state() {
      return state;
    },
    destination: audioNode(),
    // Simulates a browser that never grants autoplay from programmatic resume.
    resume: () => Promise.resolve(),
    close: () => {
      record.closed = true;
      return Promise.resolve();
    },
    createScriptProcessor: () => scriptNode(),
  };
  return { ctx, record };
}

function mintResponse(
  overrides: Partial<Record<string, unknown>> = {},
): VoiceSessionMintResponse {
  return {
    sessionId: "sess-1",
    wsUrl: "wss://voice.test/stream",
    token: "tok-1",
    expiresAt: 1_700_000_120_000,
    uplink: { codecs: ["pcm16"] },
    downlink: { codecs: ["pcm16"] },
    ...(overrides as Partial<VoiceSessionMintResponse>),
  };
}

interface HarnessOverrides {
  options?: Partial<VoiceSessionClientOptions>;
  mintStatus?: number;
  mintBody?: Record<string, unknown>;
  /** Overrides the minted `expiresAt` (epoch ms) served by the default fetch. */
  mintExpiresAt?: number;
  failMintWith?: (attempt: number) => Error | Response | undefined;
}

function harness(overrides: HarnessOverrides = {}) {
  const sockets: FakeVoiceSocket[] = [];
  const marks: string[] = [];
  const errors: Error[] = [];
  const phases: string[] = [];
  const unlockChanges: boolean[] = [];
  const mintFetches: { url: string; body: Record<string, unknown> }[] = [];
  const mintedResponses: VoiceSessionMintResponse[] = [];
  const mic = makeMicContext();
  const playback = makePlaybackContext(true);
  const { stream, stopTrack } = makeStreamTrack();
  let nonceCounter = 0;
  let fetchAttempts = 0;

  const base: VoiceSessionClientOptions = {
    agentId: "agent-1",
    conversationId: "conv-1",
    getConsentNonce: async () => `nonce-${++nonceCounter}`,
    fetch: async (url, init) => {
      fetchAttempts += 1;
      if (overrides.failMintWith) {
        const failure = overrides.failMintWith(fetchAttempts);
        if (failure !== undefined) {
          if (failure instanceof Response) return failure;
          throw failure;
        }
      }
      if (overrides.mintStatus !== undefined) {
        return new Response(JSON.stringify(overrides.mintBody ?? {}), {
          status: overrides.mintStatus,
        });
      }
      mintFetches.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify(
          overrides.mintExpiresAt === undefined
            ? mintResponse()
            : mintResponse({ expiresAt: overrides.mintExpiresAt }),
        ),
        { status: 200 },
      );
    },
    webSocketFactory: (url) => {
      const socket = new FakeVoiceSocket(url);
      sockets.push(socket);
      return socket as unknown as VoiceWebSocketLike;
    },
    getUserMedia: async () => stream,
    createMicAudioContext: mic.factory,
    createPlaybackAudioContext: () => playback.ctx,
    reconnectBackoffMs: 0,
    rotationLeadMs: 0,
    now: (() => {
      let tick = 0;
      return () => ++tick;
    })(),
    onState: (state) => phases.push(state.phase),
    onTraceMark: (mark) => marks.push(mark.name),
    onError: (error) => errors.push(error),
    onMinted: (minted) => mintedResponses.push(minted),
    onPlaybackUnlockChange: (required) => unlockChanges.push(required),
    ...overrides.options,
  };

  const client = createVoiceSessionClient(base);
  return {
    client,
    sockets,
    marks,
    errors,
    phases,
    unlockChanges,
    mintFetches,
    mintedResponses,
    mic,
    playback,
    stopTrack,
  };
}

async function waitUntil(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 2000, interval: 10 });
}

describe("VoiceSessionMintError classification", () => {
  it("defaults its message from the status and keeps a custom one", () => {
    const defaulted = new VoiceSessionMintError(503);
    expect(defaulted.name).toBe("VoiceSessionMintError");
    expect(defaulted.message).toContain("503");
    expect(new VoiceSessionMintError(404, "flag off").message).toBe("flag off");
  });

  it("marks transport/5xx/agent_not_found transient and nothing else", () => {
    expect(new VoiceSessionMintError(0).isTransient).toBe(true);
    expect(new VoiceSessionMintError(500).isTransient).toBe(true);
    expect(
      new VoiceSessionMintError(404, undefined, "agent_not_found").isTransient,
    ).toBe(true);
    expect(new VoiceSessionMintError(404).isTransient).toBe(false);
    expect(new VoiceSessionMintError(400).isTransient).toBe(false);
  });

  it("distinguishes a feature-off 404 from an unknown-agent 404", () => {
    expect(new VoiceSessionMintError(404).isFeatureDisabled).toBe(true);
    expect(
      new VoiceSessionMintError(404, undefined, "agent_not_found")
        .isFeatureDisabled,
    ).toBe(false);
    expect(new VoiceSessionMintError(500).isFeatureDisabled).toBe(false);
  });
});

describe("consent gating", () => {
  it("refuses to mint without a usable consent nonce", async () => {
    const h = harness({
      options: { getConsentNonce: async () => null, preLiveMaxAttempts: 1 },
    });
    await h.client.start();
    expect(h.errors[0]).toBeInstanceOf(VoiceSessionConsentError);
    expect(h.mintFetches).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
    expect(h.phases.at(-1)).toBe("idle");
  });

  it("wraps a throwing consent provider and preserves the cause", async () => {
    const h = harness({
      options: {
        getConsentNonce: async () => {
          throw new Error("consent endpoint down");
        },
        preLiveMaxAttempts: 1,
      },
    });
    await h.client.start();
    const error = h.errors[0] as VoiceSessionConsentError;
    expect(error).toBeInstanceOf(VoiceSessionConsentError);
    expect((error.cause as Error).message).toBe("consent endpoint down");
    expect(h.phases.at(-1)).toBe("idle");
  });
});

describe("pre-live mint retries", () => {
  it("retries transient transport faults then surfaces the typed mint error", async () => {
    let attempts = 0;
    const h = harness({
      failMintWith: () => {
        attempts += 1;
        return new Error("socket hang up");
      },
      options: { preLiveMaxAttempts: 2, preLiveRetryDelayMs: 0 },
    });
    await h.client.start();
    expect(attempts).toBe(2);
    const error = h.errors[0] as VoiceSessionMintError;
    expect(error).toBeInstanceOf(VoiceSessionMintError);
    expect(error.status).toBe(0);
    expect(h.sockets).toHaveLength(0);
    expect(h.phases.at(-1)).toBe("idle");
  });

  it("does not retry a permanent 403", async () => {
    let attempts = 0;
    const h = harness({
      failMintWith: () => {
        attempts += 1;
        return new Response(JSON.stringify({ code: "forbidden" }), {
          status: 403,
        });
      },
      options: { preLiveMaxAttempts: 3 },
    });
    await h.client.start();
    expect(attempts).toBe(1);
    expect((h.errors[0] as VoiceSessionMintError).status).toBe(403);
  });

  it("rejects a malformed mint body without opening a socket", async () => {
    const h = harness({
      mintStatus: 200,
      mintBody: { sessionId: "", wsUrl: "" },
      options: { preLiveMaxAttempts: 1 },
    });
    await h.client.start();
    const error = h.errors[0] as VoiceSessionMintError;
    expect(error.status).toBe(-1);
    expect(error.message).toBe("malformed mint response");
    expect(h.sockets).toHaveLength(0);
  });
});

describe("connection and hello framing", () => {
  it("mints over POST with the consent nonce and opens the advertised url", async () => {
    const h = harness();
    await h.client.start();
    expect(h.mintFetches).toHaveLength(1);
    expect(h.mintFetches[0].url).toBe("/api/v1/voice/session");
    expect(h.mintFetches[0].body).toEqual({
      agentId: "agent-1",
      conversationId: "conv-1",
      transport: "websocket",
      consentNonce: "nonce-1",
    });
    expect(h.mintedResponses.map((m) => m.sessionId)).toEqual(["sess-1"]);
    expect(h.sockets[0].url).toBe("wss://voice.test/stream");
  });

  it("sends the hello frame first with the negotiated codec set", async () => {
    const h = harness();
    await h.client.start();
    h.sockets[0].emitOpen();
    const frames = h.sockets[0].textFrames();
    expect(frames[0]).toEqual({
      t: "hello",
      token: "tok-1",
      protocol: VOICE_SESSION_PROTOCOL_VERSION,
      uplinkCodec: "pcm16",
      downlinkCodec: "pcm16",
      sampleRate: VOICE_SESSION_SAMPLE_RATE,
    });
    expect(h.marks).toContain("hello_sent");
  });

  it("falls back to the first offered codec when the preference misses", async () => {
    const h = harness({
      options: {
        fetch: async () =>
          new Response(
            JSON.stringify(
              mintResponse({
                uplink: { codecs: ["opus"] },
              }),
            ),
            { status: 200 },
          ),
      },
    });
    await h.client.start();
    h.sockets[0].emitOpen();
    const hello = h.sockets[0].textFrames()[0];
    expect(hello.uplinkCodec).toBe("opus");
    expect(hello.downlinkCodec).toBe("pcm16");
  });

  it("fails fast when no compatible codec is offered", async () => {
    const h = harness({
      options: {
        fetch: async () =>
          new Response(
            JSON.stringify(mintResponse({ downlink: { codecs: [] } })),
            { status: 200 },
          ),
      },
    });
    await h.client.start();
    expect((h.errors[0] as VoiceSessionMintError).message).toBe(
      "no compatible codec offered",
    );
    expect(h.sockets).toHaveLength(0);
  });
});

describe("server events drive the session machine", () => {
  async function startListening() {
    const h = harness();
    await h.client.start();
    const socket = h.sockets[0];
    socket.emitOpen();
    socket.emitMessage(
      JSON.stringify({ t: "ready", sessionId: "sess-9", traceId: "T0" }),
    );
    await waitUntil(() => expect(h.phases.at(-1)).toBe("listening"));
    return h;
  }

  it("starts mic capture on ready and reaches listening", async () => {
    const h = await startListening();
    expect(h.mic.created).toHaveLength(1);
    expect(h.client.state.sessionId).toBe("sess-9");
    expect(h.client.state.traceId).toBe("T0");
    expect(h.marks).toContain("ready");
    expect(h.stopTrack).not.toHaveBeenCalled();
  });

  it("relays framed mic audio to the socket as int16 pcm buffers", async () => {
    const h = await startListening();
    const socket = h.sockets[0];
    const sendsBefore = socket.sent.length;
    const script = h.mic.created[0] as {
      onaudioprocess: ((event: unknown) => void) | null;
    };
    const loud = new Float32Array(1600).fill(0.25);
    script.onaudioprocess?.({
      inputBuffer: { getChannelData: () => loud },
    });
    const uplinked = socket.sent[sendsBefore];
    expect(uplinked).toBeInstanceOf(ArrayBuffer);
    expect((uplinked as ArrayBuffer).byteLength).toBe(3200);
    expect(new Uint8Array(uplinked as ArrayBuffer).some((b) => b !== 0)).toBe(
      true,
    );
  });

  it("substitutes silence for uplink while muted but keeps cadence", async () => {
    const h = await startListening();
    const socket = h.sockets[0];
    h.client.setMicrophoneMuted(true);
    expect(h.client.microphoneMuted).toBe(true);
    const sendsBefore = socket.sent.length;
    const script = h.mic.created[0] as {
      onaudioprocess: ((event: unknown) => void) | null;
    };
    script.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => new Float32Array(1600).fill(0.25),
      },
    });
    const uplinked = socket.sent[sendsBefore] as ArrayBuffer;
    expect(uplinked.byteLength).toBe(3200);
    expect(new Uint8Array(uplinked).every((b) => b === 0)).toBe(true);
    expect(h.marks).toContain("mic_muted");
  });

  it("runs a full turn: partial → final → thinking → speaking → loop to listening", async () => {
    const h = await startListening();
    const socket = h.sockets[0];
    socket.emitMessage(
      JSON.stringify({ t: "stt_partial", text: "hel", traceId: "T1" }),
    );
    expect(h.client.state.phase).toBe("transcribing");
    expect(h.client.state.interimTranscript).toBe("hel");
    socket.emitMessage(
      JSON.stringify({ t: "stt_final", text: "hello", traceId: "T1" }),
    );
    expect(h.client.state.phase).toBe("thinking");
    expect(h.client.state.finalTranscript).toBe("hello");
    expect(h.client.state.interimTranscript).toBe("");
    socket.emitMessage(JSON.stringify({ t: "llm_first_text", traceId: "T1" }));
    socket.emitMessage(JSON.stringify({ t: "speaking_start", traceId: "T1" }));
    expect(h.client.state.phase).toBe("speaking");
    socket.emitMessage(JSON.stringify({ t: "speaking_end", traceId: "T1" }));
    await waitUntil(() => expect(h.client.state.phase).toBe("listening"));
    expect(h.phases).toContain("complete");
  });

  it("loops an empty stt_final straight back to listening (#16662)", async () => {
    const h = await startListening();
    h.sockets[0].emitMessage(
      JSON.stringify({ t: "stt_final", text: "   ", traceId: "T2" }),
    );
    await waitUntil(() => expect(h.client.state.phase).toBe("listening"));
    expect(h.phases).toContain("complete");
    expect(h.client.state.finalTranscript).toBe("");
  });

  it("routes binary frames into the playback sink", async () => {
    const h = await startListening();
    const payload = new Uint8Array([1, 2, 3, 4]).buffer;
    h.sockets[0].emitMessage(payload);
    expect(h.marks).toContain("downlink_audio");
    expect(h.errors).toHaveLength(0);
  });

  it("survives malformed and unparseable control frames", async () => {
    const h = await startListening();
    const socket = h.sockets[0];
    socket.emitMessage("{not json");
    socket.emitMessage({ totally: "binary?" });
    expect(h.marks).toContain("not_reached(unparseable_control)");
    expect(h.marks).toContain("not_reached(malformed_frame)");
    expect(socket.closedWith).toHaveLength(0);
    expect(h.phases.at(-1)).toBe("listening");
  });

  it("records a retryable server error without recovering", async () => {
    const h = await startListening();
    h.sockets[0].emitMessage(
      JSON.stringify({
        t: "error",
        code: "overloaded",
        retryable: true,
        traceId: "T3",
      }),
    );
    expect(h.client.state.lastError).toEqual({
      code: "overloaded",
      retryable: true,
    });
    expect(h.mintFetches).toHaveLength(1);
    expect(h.errors).toHaveLength(0);
  });

  it("stops cleanly on quota_exhausted or revoked server errors", async () => {
    for (const code of ["quota_exhausted", "revoked"]) {
      const h = await startListening();
      const socket = h.sockets[0];
      socket.emitMessage(
        JSON.stringify({ t: "error", code, retryable: false, traceId: "T4" }),
      );
      await waitUntil(() => expect(h.phases.at(-1)).toBe("idle"));
      expect(h.errors.some((e) => e.message.includes(code))).toBe(true);
      expect(socket.textFrames().at(-1)?.t).toBe("bye");
      expect(socket.closedWith.at(-1)?.code).toBe(1000);
      expect(h.mintFetches).toHaveLength(1);
      expect(h.stopTrack).toHaveBeenCalled();
    }
  });

  it("re-mints after a fatal non-terminal server error", async () => {
    const h = await startListening();
    h.sockets[0].emitMessage(
      JSON.stringify({
        t: "error",
        code: "internal",
        retryable: false,
        traceId: "T5",
      }),
    );
    await waitUntil(() => expect(h.mintFetches).toHaveLength(2));
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].emitOpen();
    expect(h.sockets[1].textFrames()[0]?.t).toBe("hello");
  });

  it("re-mints with fresh consent after an unexpected peer close", async () => {
    const h = await startListening();
    const dead = h.sockets[0];
    dead.emitClose(1006, "abnormal");
    await waitUntil(() => expect(h.mintFetches).toHaveLength(2));
    expect(dead.closedWith.at(-1)).toEqual({ code: 1012, reason: "re-mint" });
    expect(h.mintFetches[1].body.consentNonce).toBe("nonce-2");
    h.sockets[1].emitOpen();
    expect(h.sockets[1].textFrames()[0]?.t).toBe("hello");
  });

  it("exhausts a bounded reconnect budget and surfaces the loss", async () => {
    const h = harness({
      options: { maxReconnects: 1, reconnectBudgetResetMs: 30_000 },
    });
    await h.client.start();
    const first = h.sockets[0];
    first.emitOpen();
    first.emitMessage(
      JSON.stringify({ t: "ready", sessionId: "s1", traceId: "T0" }),
    );
    first.emitClose(1006);
    await waitUntil(() => expect(h.sockets).toHaveLength(2));
    const second = h.sockets[1];
    second.emitOpen();
    second.emitClose(1006);
    await waitUntil(() => expect(h.phases.at(-1)).toBe("idle"));
    expect(h.marks).toContain("not_reached(reconnect_exhausted:ws_close)");
    expect(
      h.errors.some((e) => e.message.startsWith("voice session lost")),
    ).toBe(true);
    expect(h.mintFetches).toHaveLength(2);
  });

  it("refills the reconnect budget after a long healthy session", async () => {
    let clock = 0;
    const h = harness({
      options: {
        maxReconnects: 1,
        reconnectBudgetResetMs: 30_000,
        now: () => clock,
      },
    });
    await h.client.start();
    const first = h.sockets[0];
    first.emitOpen();
    first.emitMessage(
      JSON.stringify({ t: "ready", sessionId: "s1", traceId: "T0" }),
    );
    await waitUntil(() => expect(h.phases.at(-1)).toBe("listening"));
    clock += 31_000;
    first.emitClose(1006);
    await waitUntil(() => expect(h.sockets).toHaveLength(2));
    expect(h.errors).toHaveLength(0);
    h.sockets[1].emitOpen();
    expect(h.sockets[1].textFrames()[0]?.t).toBe("hello");
  });

  it("waits out the growing backoff between reconnect attempts", async () => {
    const h = harness({
      // Exhaust one whole re-mint cycle (calls 2-3) so recovery advances to
      // its second loop iteration, where the reconnect backoff lives.
      failMintWith: (n) =>
        n >= 2 && n <= 3 ? new VoiceSessionMintError(0, "blip") : undefined,
      options: {
        reconnectBackoffMs: 10,
        preLiveMaxAttempts: 2,
        preLiveRetryDelayMs: 0,
      },
    });
    await h.client.start();
    const first = h.sockets[0];
    first.emitOpen();
    first.emitMessage(
      JSON.stringify({ t: "ready", sessionId: "s1", traceId: "T0" }),
    );
    first.emitClose(1006);
    await waitUntil(() => expect(h.sockets).toHaveLength(2));
    expect(h.marks).toContain("reconnect_backoff(2)");
    expect(h.mintFetches).toHaveLength(2);
  });
});

describe("barge-in and microphone mute", () => {
  it("flushes local playback and notifies the server immediately", async () => {
    const playback = makePlaybackContext(false);
    const h = harness({
      options: { createPlaybackAudioContext: () => playback.ctx },
    });
    await h.client.start();
    const socket = h.sockets[0];
    socket.emitOpen();
    socket.emitMessage(new Uint8Array([8, 8, 8, 8]).buffer);
    expect(h.client.needsPlaybackUnlock).toBe(true);
    expect(h.unlockChanges.at(-1)).toBe(true);
    h.client.bargeIn();
    expect(h.client.needsPlaybackUnlock).toBe(false);
    expect(h.unlockChanges.at(-1)).toBe(false);
    expect(socket.textFrames()).toContainEqual({ t: "barge_in" });
    expect(h.marks).toContain("barge_in_sent");
  });

  it("does not fabricate a server phase with a local barge-in", async () => {
    const h = harness();
    await h.client.start();
    h.sockets[0].emitOpen();
    expect(h.client.state.phase).toBe("connecting");
    h.client.bargeIn();
    expect(h.client.state.phase).toBe("connecting");
  });

  it("ignores mute toggles after disposal and dedupes marks", async () => {
    const h = harness();
    await h.client.start();
    h.sockets[0].emitOpen();
    h.client.setMicrophoneMuted(true);
    const marksAfterMute = h.marks.filter((m) => m === "mic_muted").length;
    h.client.setMicrophoneMuted(true);
    expect(h.marks.filter((m) => m === "mic_muted").length).toBe(
      marksAfterMute,
    );
    await h.client.stop();
    h.client.setMicrophoneMuted(true);
    expect(h.client.microphoneMuted).toBe(false);
  });
});

describe("proactive token rotation", () => {
  const EPOCH = 1_700_000_000_000;

  function rotatingHarness() {
    return harness({
      mintExpiresAt: EPOCH + 5_000,
      options: {
        epochNow: () => EPOCH,
        rotationLeadMs: 10_000,
        rotationRecheckMs: 5,
      },
    });
  }

  it("performs a clean bye + re-mint at a listening boundary", async () => {
    const h = rotatingHarness();
    await h.client.start();
    const first = h.sockets[0];
    first.emitOpen();
    first.emitMessage(
      JSON.stringify({ t: "ready", sessionId: "s1", traceId: "T0" }),
    );
    await waitUntil(() => expect(h.sockets).toHaveLength(2));
    expect(first.textFrames().at(-1)?.t).toBe("bye");
    expect(first.closedWith.at(-1)).toEqual({
      code: 1000,
      reason: "token rotation",
    });
    expect(h.marks).toContain("token_rotation");
    h.sockets[1].emitOpen();
    expect(h.sockets[1].textFrames()[0]?.t).toBe("hello");
    await h.client.stop();
  });

  it("defers rotation mid-turn instead of cutting audible speech", async () => {
    const h = rotatingHarness();
    await h.client.start();
    const socket = h.sockets[0];
    socket.emitOpen();
    await waitUntil(() => expect(h.marks).toContain("token_rotation_deferred"));
    expect(h.mintFetches).toHaveLength(1);
    expect(socket.closedWith).toHaveLength(0);
    await h.client.stop();
  });
});

describe("teardown", () => {
  it("sends bye, closes cleanly, releases the mic, and resets to idle", async () => {
    const h = harness();
    await h.client.start();
    const socket = h.sockets[0];
    socket.emitOpen();
    socket.emitMessage(
      JSON.stringify({ t: "ready", sessionId: "s1", traceId: "T0" }),
    );
    await waitUntil(() => expect(h.phases.at(-1)).toBe("listening"));
    await h.client.stop();
    expect(socket.textFrames().at(-1)).toEqual({ t: "bye" });
    expect(socket.closedWith.at(-1)).toEqual({
      code: 1000,
      reason: "client bye",
    });
    expect(h.stopTrack).toHaveBeenCalled();
    expect(h.mic.contexts.every((c) => c.closed)).toBe(true);
    expect(h.playback.record.closed).toBe(true);
    expect(h.client.state.phase).toBe("idle");
    expect(h.unlockChanges.at(-1)).toBe(false);
  });

  it("closes a never-opened socket on stop without sending bye", async () => {
    const h = harness();
    await h.client.start();
    const socket = h.sockets[0];
    await h.client.stop();
    expect(socket.textFrames()).toHaveLength(0);
    expect(socket.closedWith).toHaveLength(1);
    expect(h.phases.at(-1)).toBe("idle");
  });
});

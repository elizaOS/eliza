import { afterEach, expect, test, vi } from "vitest";
import {
  createVoiceSessionClient,
  type VoiceSessionClient,
  VoiceSessionRefusedError,
  type VoiceWebSocketLike,
} from "./voice-session-client";
import * as micCapture from "./voice-session-mic-capture";
import {
  type MicAudioContextLike,
  VoiceMicReleaseError,
} from "./voice-session-mic-capture";
import type {
  PlaybackAudioContextLike,
  PlaybackScriptNodeLike,
} from "./voice-session-playback";
import type {
  ServerControlFrame,
  VoiceSessionMintResponse,
} from "./voice-session-protocol";

const dashboardTransport = vi.hoisted(() => vi.fn());
vi.mock("./voice-session-fetch", () => ({
  fetchVoiceSession: dashboardTransport,
}));

let client: VoiceSessionClient | undefined;
afterEach(async () => {
  await client?.stop();
  client = undefined;
  vi.useRealTimers();
  dashboardTransport.mockReset();
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

test("the existing app entry retains its lazy dashboard transport", async () => {
  dashboardTransport.mockResolvedValue(
    Response.json({ code: "feature_disabled" }, { status: 404 }),
  );
  const errors: Error[] = [];
  const node = {
    connect() {
      return this;
    },
    disconnect() {},
  };
  client = createVoiceSessionClient({
    agentId: "local-agent",
    conversationId: "local-conversation",
    getConsentNonce: async () => "owned-consent",
    createPlaybackAudioContext: () => ({
      sampleRate: 16000,
      state: "running",
      destination: node,
      createScriptProcessor: () => ({ ...node, onaudioprocess: null }),
      async resume() {},
      async close() {},
    }),
    onError: (error) => errors.push(error),
  });
  await client.start();
  expect(dashboardTransport).toHaveBeenCalledOnce();
  expect(dashboardTransport.mock.calls[0][0]).toBe("/api/v1/voice/session");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ status: 404, code: "feature_disabled" });
  expect(client.state.phase).toBe("idle");
});

function harness(
  playbackCompletion = false,
  getUiContext?: () => { uiViewPath?: string },
  preparation = false,
  turnTerminal: unknown = "missing",
  requireTurnTerminal = false,
) {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  let now = 0,
    mints = 0,
    consents = 0,
    captures = 0,
    activeCaptures = 0,
    maxCaptures = 0,
    holdReady = false,
    holdMint = false,
    stopOnMint = false,
    invalidMint = false,
    sourceDisconnectFault: Error | undefined,
    releaseMint: (() => void) | undefined;
  let stateObserver: ((state: VoiceSessionClient["state"]) => void) | undefined;
  const processors: Array<{
      onaudioprocess:
        | null
        | ((event: {
            inputBuffer: { getChannelData: () => Float32Array };
          }) => void);
    }> = [],
    tracks: Array<{ enabled: boolean; stop(): void }> = [];
  const sockets: Socket[] = [],
    bodies: Record<string, unknown>[] = [],
    events: ServerControlFrame[] = [],
    mintedTickets: VoiceSessionMintResponse[] = [],
    errors: Error[] = [],
    marks: string[] = [];
  class Socket implements VoiceWebSocketLike {
    readyState = 0;
    binaryType = "arraybuffer";
    listeners = new Map<string, ((event: unknown) => void)[]>();
    sent: unknown[] = [];
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }
    addEventListener(type: string, listener: unknown) {
      if (typeof listener !== "function")
        throw Error("Invalid fixture listener");
      this.listeners.set(type, [
        ...(this.listeners.get(type) ?? []),
        listener as (event: unknown) => void,
      ]);
    }
    emit(type: string, event: unknown) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    frame(value: unknown) {
      this.emit("message", { data: JSON.stringify(value) });
    }
    send(data: string | ArrayBuffer | ArrayBufferView) {
      if (typeof data === "string") {
        const frame = JSON.parse(data);
        this.sent.push(frame);
        if (frame.t === "hello" && !holdReady)
          queueMicrotask(() =>
            this.frame({
              t: "ready",
              ...(turnTerminal === "missing" ? {} : { turnTerminal }),
              sessionId: `session-${mints}`,
              traceId: `ready-${mints}`,
              playbackCompletion,
              uiContext: !!getUiContext,
            }),
          );
      } else this.sent.push(data);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", {});
    }
  }
  const node = () => ({
    connect() {
      return this;
    },
    disconnect() {},
  });
  const mic: () => MicAudioContextLike = () => ({
    sampleRate: 16000,
    state: "running",
    destination: node(),
    createMediaStreamSource: () => ({
      ...node(),
      disconnect() {
        if (sourceDisconnectFault) throw sourceDisconnectFault;
      },
    }),
    createScriptProcessor: () => {
      const processor = { ...node(), onaudioprocess: null };
      processors.push(processor);
      return processor;
    },
    async resume() {},
    async close() {},
  });
  const playbackProcessors: PlaybackScriptNodeLike[] = [];
  const playback: () => PlaybackAudioContextLike = () => ({
    sampleRate: 16000,
    state: "running",
    destination: node(),
    createScriptProcessor: () => {
      const processor: PlaybackScriptNodeLike = {
        ...node(),
        onaudioprocess: null,
      };
      playbackProcessors.push(processor);
      return processor;
    },
    async resume() {},
    async close() {},
  });
  client = createVoiceSessionClient({
    requireTurnTerminal,
    agentId: "local-agent",
    conversationId: "local-conversation",
    getConsentNonce: async () => {
      consents++;
      return `new-consent-${consents}`;
    },
    fetch: async (_url, init) => {
      mints++;
      bodies.push(JSON.parse(String(init?.body)));
      if (holdMint)
        await new Promise<void>((resolve) => {
          releaseMint = resolve;
        });
      return Response.json({
        ...(preparation
          ? {
              rotationPreparation: "retire-before-open-v1",
              stopIntentVersion: 1,
              stopIntentGeneration: `session-${mints}`,
            }
          : {}),
        sessionId: `session-${mints}`,
        token: invalidMint && mints > 1 ? "" : `one-use-${mints}`,
        wsUrl: `ws://localhost/voice-${mints}`,
        ...(turnTerminal === "missing" ? {} : { turnTerminal }),
        expiresAt: 1800000000000 + now + 60000,
        uplink: { codecs: ["pcm16"] },
        downlink: { codecs: ["pcm16"] },
      });
    },
    webSocketFactory: () => new Socket(),
    getUiContext,
    getUserMedia: async () => {
      captures++;
      activeCaptures++;
      maxCaptures = Math.max(maxCaptures, activeCaptures);
      let stopped = false;
      const track = {
        enabled: true,
        get readyState() {
          return stopped ? "ended" : "live";
        },
        stop() {
          if (!stopped) {
            stopped = true;
            activeCaptures--;
          }
        },
      };
      tracks.push(track);
      return {
        getTracks: () => [track],
        getAudioTracks: () => [track],
      } as unknown as MediaStream;
    },
    createMicAudioContext: mic,
    createPlaybackAudioContext: playback,
    now: () => now,
    epochNow: () => 1800000000000 + now,
    preLiveMaxReconnects: 0,
    preLiveMaxAttempts: 1,
    onMinted: (minted) => {
      mintedTickets.push(minted);
      if (stopOnMint && mints > 1) void client?.stop();
    },
    onState: (state) => stateObserver?.(state),
    onTraceMark: (mark) => marks.push(mark.name),
    onServerEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
  });
  return {
    client,
    sockets,
    tracks,
    pumpPlayback() {
      for (const processor of playbackProcessors)
        processor.onaudioprocess?.({
          outputBuffer: {
            numberOfChannels: 1,
            getChannelData: () => new Float32Array(4096),
          },
        });
    },
    pumpAudio() {
      processors[0]?.onaudioprocess?.({
        inputBuffer: {
          getChannelData: () => new Float32Array(4096).fill(0.25),
        },
      });
    },
    bodies,
    events,
    mintedTickets,
    dropLastMintCapability() {
      delete mintedTickets.at(-1)!.turnTerminal;
    },
    observeState(observer: (state: VoiceSessionClient["state"]) => void) {
      stateObserver = observer;
    },
    errors,
    marks,
    get mints() {
      return mints;
    },
    get consents() {
      return consents;
    },
    get captures() {
      return captures;
    },
    get activeCaptures() {
      return activeCaptures;
    },
    get maxCaptures() {
      return maxCaptures;
    },
    async advance(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
        now += Math.min(1000, ms - elapsed);
        await vi.advanceTimersByTimeAsync(Math.min(1000, ms - elapsed));
        await flush();
      }
    },
    async settle() {
      await flush();
    },
    invalidNextMint() {
      invalidMint = true;
    },
    failSourceDisconnect() {
      sourceDisconnectFault = new Error("source disconnect refused");
    },
    stopOnNextMint() {
      stopOnMint = true;
    },
    holdReady() {
      holdReady = true;
    },
    releaseReady() {
      holdReady = false;
      sockets.at(-1)?.frame({
        t: "ready",
        ...(turnTerminal === "missing" ? {} : { turnTerminal }),
        sessionId: `session-${mints}`,
        traceId: `ready-${mints}`,
      });
    },
    holdMint() {
      holdMint = true;
    },
    releaseMint() {
      holdMint = false;
      releaseMint?.();
    },
  };
}
test("three Cloud budget idle rotations use fresh consent and one capture, with no transcript or paid TTS replay", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  expect(h.client.state.phase).toBe("listening");
  h.client.setMicrophoneMuted(true);
  await h.advance(150000);
  expect(h.mints).toBe(4);
  expect(h.consents).toBe(4);
  expect(h.captures).toBe(1);
  expect(h.maxCaptures).toBe(1);
  expect(h.activeCaptures).toBe(1);
  expect(h.client.microphoneMuted).toBe(true);
  expect(h.errors).toHaveLength(0);
  expect(h.marks.filter((mark) => mark === "token_rotation")).toHaveLength(3);
  expect(
    h.bodies.every(
      (body) =>
        Object.keys(body).sort().join(",") ===
        "agentId,consentNonce,conversationId,transport",
    ),
  ).toBe(true);
  expect(new Set(h.bodies.map((body) => body.consentNonce)).size).toBe(4);
  expect(
    h.sockets
      .slice(0, -1)
      .every((socket) =>
        socket.sent.some((frame) => (frame as { t?: string }).t === "bye"),
      ),
  ).toBe(true);
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
});
test("rotation defers a live finalized turn until listening, then rotates without resubmitting that user turn", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const old = h.sockets[0];
  old.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  old.frame({ t: "speaking_start", traceId: "turn-1" });
  await h.advance(55000);
  expect(h.mints).toBe(1);
  expect(h.marks).toContain("token_rotation_deferred");
  old.frame({ t: "speaking_end", traceId: "turn-1" });
  old.frame({ t: "usage", sttMs: 1000, ttsChars: 12, traceId: "turn-1" });
  await h.advance(1000);
  expect(h.mints).toBe(2);
  expect(
    h.events.filter((event) => (event as { t: string }).t === "stt_final"),
  ).toHaveLength(1);
  expect(h.bodies.some((body) => "text" in body)).toBe(false);
  expect(h.maxCaptures).toBe(1);
});
test("a busy hard-expiry interruption retires old audio and reconnects without replaying an already finalized turn", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const old = h.sockets[0];
  old.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  old.frame({ t: "speaking_start", traceId: "turn-1" });
  await h.advance(60000);
  expect(h.mints).toBe(1);
  old.close();
  await h.settle();
  expect(h.mints).toBe(2);
  expect(h.maxCaptures).toBe(1);
  expect(
    h.events.filter((event) => (event as { t: string }).t === "stt_final"),
  ).toHaveLength(1);
  expect(h.bodies.some((body) => "text" in body)).toBe(false);
  expect(h.marks).toContain("token_rotation_deferred");
  expect(h.errors).toHaveLength(0);
  // The provider's unfinished response was interrupted, not falsely completed or replayed.
  expect(
    h.events.some((event) => (event as { t: string }).t === "reply_complete"),
  ).toBe(false);
});
test("Stop during a budget remint releases capture and fences its late response", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.holdMint();
  await h.advance(50000);
  expect(h.mints).toBe(2);
  expect(h.captures).toBe(1);
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
  h.releaseMint();
  await h.settle();
  await h.advance(70000);
  expect(h.sockets).toHaveLength(1);
  expect(h.activeCaptures).toBe(0);
  expect(h.mints).toBe(2);
  expect(h.errors).toHaveLength(0);
});

test("three ready sessions keep one capture and retarget its actual PCM only after renewed ready", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.pumpAudio();
  const firstAudio = h.sockets[0].sent.filter(
    (x) => x instanceof ArrayBuffer,
  ).length;
  expect(firstAudio).toBeGreaterThan(0);
  h.holdMint();
  await h.advance(50000);
  expect(h.mints).toBe(2);
  expect(h.captures).toBe(1);
  expect(h.activeCaptures).toBe(1);
  expect(h.tracks[0].enabled).toBe(false);
  h.pumpAudio();
  expect(h.sockets[0].sent.filter((x) => x instanceof ArrayBuffer).length).toBe(
    firstAudio,
  );
  h.holdReady();
  h.releaseMint();
  await h.settle();
  h.pumpAudio();
  expect(h.sockets[1].sent.filter((x) => x instanceof ArrayBuffer).length).toBe(
    0,
  );
  expect(h.tracks[0].enabled).toBe(false);
  h.releaseReady();
  await h.settle();
  expect(h.client.state.phase).toBe("listening");
  expect(h.tracks[0].enabled).toBe(true);
  h.pumpAudio();
  expect(
    h.sockets[1].sent.filter((x) => x instanceof ArrayBuffer).length,
  ).toBeGreaterThan(0);
  expect(h.sockets[0].sent.filter((x) => x instanceof ArrayBuffer).length).toBe(
    firstAudio,
  );
  await h.advance(50000);
  expect(h.mints).toBe(3);
  expect(
    h.events.filter((x) => (x as { t: string }).t === "ready"),
  ).toHaveLength(3);
  expect(h.captures).toBe(1);
  expect(h.maxCaptures).toBe(1);
  h.pumpAudio();
  expect(
    h.sockets[2].sent.filter((x) => x instanceof ArrayBuffer).length,
  ).toBeGreaterThan(0);
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
});
test("unexpected peer close still retires its capture before bounded recovery", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.sockets[0].close();
  await h.settle();
  expect(h.mints).toBe(2);
  expect(h.captures).toBe(2);
  expect(h.maxCaptures).toBe(1);
  expect(h.activeCaptures).toBe(1);
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
});

test("a stalled clean renewal releases retained capture at old expiry, then late ready reacquires without overlap", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.holdMint();
  await h.advance(50000);
  expect(h.activeCaptures).toBe(1);
  expect(h.tracks[0].enabled).toBe(false);
  await h.advance(10000);
  expect(h.activeCaptures).toBe(0);
  h.releaseMint();
  await h.settle();
  expect(h.client.state.phase).toBe("listening");
  expect(h.captures).toBe(2);
  expect(h.maxCaptures).toBe(1);
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
});

test("expiry racing late ready awaits delayed device release and fences old capture callbacks", async () => {
  const real = micCapture.startVoiceMicCapture,
    ports: Array<Parameters<typeof real>[0]> = [];
  let releaseStop: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  let delayFirst = true;
  const spy = vi
    .spyOn(micCapture, "startVoiceMicCapture")
    .mockImplementation(async (options) => {
      ports.push(options);
      const capture = await real(options);
      if (delayFirst) {
        delayFirst = false;
        const stop = capture.stop;
        capture.stop = async () => {
          await gate;
          await stop();
        };
      }
      return capture;
    });
  try {
    const h = harness();
    await h.client.start();
    await h.settle();
    h.holdMint();
    await h.advance(60000);
    expect(h.activeCaptures).toBe(1);
    h.releaseMint();
    await h.settle();
    expect(h.mints).toBe(2);
    expect(h.captures).toBe(1);
    expect(h.activeCaptures).toBe(1);
    releaseStop!();
    await h.settle();
    expect(h.captures).toBe(2);
    expect(h.maxCaptures).toBe(1);
    expect(h.activeCaptures).toBe(1);
    expect(h.client.state.phase).toBe("listening");
    const count = h.sockets[1].sent.length;
    ports[0].onFrame(new Uint8Array(320));
    ports[0].onError?.(
      new micCapture.VoiceMicCaptureError(
        "stale retired callback",
        "start_failed",
      ),
    );
    expect(h.sockets[1].sent).toHaveLength(count);
    expect(h.errors).toHaveLength(0);
    ports[1].onFrame(new Uint8Array(320));
    expect(h.sockets[1].sent.length).toBeGreaterThan(count);
    await h.client.stop();
    expect(h.activeCaptures).toBe(0);
  } finally {
    releaseStop?.();
    spy.mockRestore();
  }
});

test("an accepted renewal keeps its muted capture across old expiry until actual late ready", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.pumpAudio();
  const originalFrames = h.sockets[0].sent.filter(
    (x) => x instanceof ArrayBuffer,
  ).length;
  h.holdReady();
  await h.advance(50000);
  expect(h.mints).toBe(2);
  expect(h.captures).toBe(1);
  expect(h.tracks[0].enabled).toBe(false);
  await h.advance(12000);
  expect(h.activeCaptures).toBe(1);
  expect(h.captures).toBe(1);
  h.pumpAudio();
  expect(
    h.sockets[1].sent.filter((x) => x instanceof ArrayBuffer),
  ).toHaveLength(0);
  expect(
    h.sockets[0].sent.filter((x) => x instanceof ArrayBuffer),
  ).toHaveLength(originalFrames);
  h.releaseReady();
  await h.settle();
  expect(h.client.state.phase).toBe("listening");
  expect(h.tracks[0].enabled).toBe(true);
  h.pumpAudio();
  expect(
    h.sockets[1].sent.filter((x) => x instanceof ArrayBuffer).length,
  ).toBeGreaterThan(0);
  await h.advance(38000);
  expect(h.mints).toBe(3);
  expect(
    h.events.filter((x) => (x as { t: string }).t === "ready"),
  ).toHaveLength(3);
  expect(h.captures).toBe(1);
  expect(h.maxCaptures).toBe(1);
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
});
test("an accepted renewal that never becomes ready releases capture at its own expiry", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.holdReady();
  await h.advance(50000);
  await h.advance(59000);
  expect(h.activeCaptures).toBe(1);
  expect(h.tracks[0].enabled).toBe(false);
  h.pumpAudio();
  expect(
    h.sockets[1].sent.filter((x) => x instanceof ArrayBuffer),
  ).toHaveLength(0);
  await h.advance(1000);
  expect(h.activeCaptures).toBe(0);
  expect(h.captures).toBe(1);
  expect(h.mints).toBe(2);
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
});
test("owner retirement in accepted-mint callback cannot extend capture or open the renewed socket", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.stopOnNextMint();
  await h.advance(50000);
  await h.settle();
  expect(h.mints).toBe(2);
  expect(h.sockets).toHaveLength(1);
  expect(h.activeCaptures).toBe(0);
  expect(h.client.state.phase).toBe("idle");
  await h.advance(70000);
  expect(h.activeCaptures).toBe(0);
  expect(h.captures).toBe(1);
  expect(h.mints).toBe(2);
});

test("invalid renewal cannot replace the retained capture lease", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.invalidNextMint();
  await h.advance(50000);
  expect(h.mints).toBe(2);
  expect(h.sockets).toHaveLength(1);
  expect(h.captures).toBe(1);
  expect(h.activeCaptures).toBe(0);
  await h.advance(70000);
  expect(h.activeCaptures).toBe(0);
  expect(h.mints).toBe(2);
  await h.client.stop();
});

test("playback drain sends its exact completion before microphone audio resumes", async () => {
  for (const supported of [false, true]) {
    const h = harness(supported);
    await h.client.start();
    await h.settle();
    const socket = h.sockets[0];
    socket.frame({ t: "stt_final", text: "hello", traceId: "turn-1" });
    socket.frame({ t: "speaking_start", traceId: "turn-1" });
    expect(h.tracks[0].enabled).toBe(false);
    socket.frame({ t: "speaking_end", traceId: "turn-1" });
    await h.settle();
    expect(h.client.state.phase).toBe("listening");
    expect(h.tracks[0].enabled).toBe(true);
    const completion = socket.sent.findIndex(
      (frame) => (frame as { t?: string }).t === "playback_complete",
    );
    if (supported) {
      expect(socket.sent[completion]).toEqual({
        t: "playback_complete",
        traceId: "turn-1",
      });
      h.pumpAudio();
      expect(
        socket.sent.findIndex((frame) => frame instanceof ArrayBuffer),
      ).toBeGreaterThan(completion);
    } else expect(completion).toBe(-1);
    await h.client.stop();
  }
});

test("insufficient credits stop capture without minting another session", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.sockets[0].frame({
    t: "error",
    code: "insufficient_credits",
    retryable: false,
  });
  await h.settle();
  await h.advance(120000);
  expect(h.mints).toBe(1);
  expect(h.activeCaptures).toBe(0);
  expect(
    h.errors.some(
      (error) =>
        error.message ===
        "Voice needs more Eliza Cloud credits. Add credits, then try again.",
    ),
  ).toBe(true);
});

test("a retired renderer context stops capture instead of silently discarding uplink", async () => {
  const h = harness(false, () => {
    throw new Error("private-context-detail");
  });
  await h.client.start();
  await h.settle();
  h.pumpAudio();
  await h.settle();
  expect(h.errors.map((error) => error.message)).toEqual([
    "Voice context changed. Start voice again.",
  ]);
  expect(h.activeCaptures).toBe(0);
  expect(h.mints).toBe(1);
  expect(
    h.sockets[0].sent.filter((frame) => frame instanceof ArrayBuffer),
  ).toHaveLength(0);
  await h.advance(120000);
  expect(h.mints).toBe(1);
});

test("prefetch keeps current socket and microphone live until the next ticket arrives", async () => {
  const h = harness(false, undefined, true);
  await h.client.start();
  await h.settle();
  const old = h.sockets[0];
  h.holdMint();
  await h.advance(50000);
  expect(h.mints).toBe(2);
  expect(h.sockets).toHaveLength(1);
  expect(h.client.state.phase).toBe("listening");
  expect(h.activeCaptures).toBe(1);
  expect(old.sent.some((f) => (f as { t?: string }).t === "bye")).toBe(false);
  expect(h.bodies[1].predecessorSessionId).toBe("session-1");
  await h.advance(4000);
  expect(h.mints).toBe(2);
  h.releaseMint();
  await h.settle();
  expect(h.sockets).toHaveLength(2);
  expect(old.readyState).toBe(3);
  expect(h.mints).toBe(2);
});
test("Stop during prefetch never adopts the late ticket or reopens capture", async () => {
  const h = harness(false, undefined, true);
  await h.client.start();
  await h.settle();
  h.holdMint();
  await h.advance(50000);
  await h.client.stop();
  h.releaseMint();
  await h.settle();
  expect(h.sockets).toHaveLength(1);
  expect(h.activeCaptures).toBe(0);
  expect(h.client.state.phase).toBe("idle");
});
test("invalid prefetched ticket does not close current paid session or repeat mint", async () => {
  const h = harness(false, undefined, true);
  await h.client.start();
  await h.settle();
  h.invalidNextMint();
  await h.advance(50000);
  await h.settle();
  expect(h.sockets).toHaveLength(1);
  expect(h.sockets[0].readyState).toBe(1);
  await h.advance(5000);
  expect(h.mints).toBe(2);
  expect(h.activeCaptures).toBe(1);
});

test("prefetch waits for matching canonical settlement after playback is listening", async () => {
  const h = harness(false, undefined, true);
  await h.client.start();
  await h.settle();
  const old = h.sockets[0];
  old.frame({ t: "stt_final", text: "read my notes", traceId: "live-turn" });
  old.frame({ t: "speaking_start", traceId: "live-turn" });
  old.frame({ t: "speaking_end", traceId: "live-turn" });
  await h.advance(56000);
  expect(h.client.state.phase).toBe("listening");
  expect(h.sockets).toHaveLength(1);
  expect(h.mints).toBe(2);
  old.frame({ t: "usage", sttMs: 1, ttsChars: 1, traceId: "wrong-turn" });
  await h.advance(1000);
  expect(h.sockets).toHaveLength(1);
  old.frame({ t: "reply_complete", traceId: "live-turn" });
  await h.advance(1000);
  expect(h.sockets).toHaveLength(1);
  old.frame({ t: "usage", sttMs: 1, ttsChars: 1, traceId: "live-turn" });
  await h.advance(1000);
  expect(h.sockets).toHaveLength(2);
});
test("hard loss marks unsettled turn unknown without replaying it", async () => {
  const h = harness(false, undefined, true);
  await h.client.start();
  await h.settle();
  const old = h.sockets[0];
  old.frame({ t: "stt_final", text: "read my notes", traceId: "unfinished" });
  await h.advance(50000);
  old.close();
  await h.settle();
  expect(h.marks).toContain("not_reached(turn_terminal_unknown:ws_close)");
  expect(h.bodies.every((b) => !("text" in b))).toBe(true);
});

test("normal Stop carries explicit current generation", async () => {
  const h = harness(false, undefined, true);
  await h.client.start();
  await h.settle();
  await h.client.stop();
  expect(h.sockets[0].sent.find((v) => (v as any).t === "bye")).toMatchObject({
    intent: { version: 1, kind: "user_stop", generation: "session-1" },
  });
});
test("budget rotation names only its exact prepared successor", async () => {
  const h = harness(false, undefined, true);
  await h.client.start();
  await h.settle();
  await h.advance(50000);
  expect(h.sockets[0].sent.find((v) => (v as any).t === "bye")).toMatchObject({
    intent: {
      version: 1,
      kind: "budget_rotation",
      generation: "session-1",
      successorSessionId: "session-2",
    },
  });
});
test("legacy host Stop stays bare and makes no typed cancellation claim", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  await h.client.stop();
  expect(h.sockets[0].sent.find((v) => (v as any).t === "bye")).toEqual({
    t: "bye",
  });
});

test("pre-live retirement refusal has no capture, then a later explicit start works", async () => {
  const h = harness();
  h.holdReady();
  await h.client.start();
  await h.settle();
  h.sockets[0].frame({
    t: "error",
    code: "voice_retirement_unconfirmed",
    retryable: false,
  });
  await h.settle();
  expect(h.errors[0]).toBeInstanceOf(VoiceSessionRefusedError);
  expect(h.captures).toBe(0);
  expect(h.mints).toBe(1);
  await (h.errors[0] as VoiceSessionRefusedError).captureReleased;
  h.releaseReady();
  await h.client.start();
  await h.settle();
  expect(h.mints).toBe(2);
  expect(h.activeCaptures).toBe(1);
});
test("a live retirement refusal recovers with the existing bounded reconnect path", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  expect(h.activeCaptures).toBe(1);
  h.holdReady();
  h.sockets[0].close();
  await h.settle();
  await h.advance(1000);
  const refused = h.sockets.at(-1)!;
  refused.frame({
    t: "error",
    code: "voice_retirement_unconfirmed",
    retryable: false,
  });
  await h.settle();
  h.releaseReady();
  await h.advance(5000);
  await h.settle();
  expect(h.mints).toBeGreaterThan(2);
  expect(h.activeCaptures).toBe(1);
  expect(h.maxCaptures).toBe(1);
  expect(h.errors).toHaveLength(0);
  refused.frame({
    t: "error",
    code: "voice_retirement_unconfirmed",
    retryable: false,
  });
  await h.settle();
  expect(h.activeCaptures).toBe(1); // A stale socket cannot stop the recovered capture.
});

test("a legacy mint lacking capability never opens WS/capture or retries", async () => {
  const h = harness(false, undefined, false, "missing", true);
  await h.client.start();
  await h.settle();
  await h.advance(120000);
  expect(h.mints).toBe(1);
  expect(h.consents).toBe(1);
  expect(h.sockets).toHaveLength(0);
  expect(h.captures).toBe(0);
  expect(h.mintedTickets.map((ticket) => ticket.sessionId)).toEqual([
    "session-1",
  ]);
  expect(h.errors).toHaveLength(1);
});

test.each(["failed", "ignored"] as const)(
  "matching %s settlement neither re-mints nor drains A playback; stale events cannot retire B",
  async (outcome) => {
    const h = harness(true, undefined, false, true, true);
    await h.client.start();
    await h.settle();
    const socket = h.sockets[0];
    socket.frame({ t: "stt_final", text: "first request", traceId: "A" });
    socket.frame({ t: "speaking_start", traceId: "A" });
    socket.emit("message", { data: new Int16Array(320).fill(1000).buffer });
    socket.frame({ t: "stt_final", text: "second request", traceId: "B" });
    socket.frame({ t: "turn_terminal", traceId: "unknown", outcome });
    expect(h.events.filter((e) => e.t === "turn_terminal")).toHaveLength(0);
    socket.frame({
      t: "turn_terminal",
      traceId: "B",
      outcome,
      ...(outcome === "failed" ? { code: "handler_error" } : {}),
    });
    socket.frame({ t: "turn_terminal", traceId: "B", outcome });
    expect(h.events.filter((e) => e.t === "turn_terminal")).toHaveLength(1);
    expect(h.client.state.phase).toBe("speaking");
    expect(h.tracks[0].enabled).toBe(false);
    expect(h.mints).toBe(1);
    expect(h.activeCaptures).toBe(1);
    expect(h.errors).toHaveLength(0);
    socket.frame({ t: "speaking_end", traceId: "A" });
    await h.settle();
    expect(h.tracks[0].enabled).toBe(false);
    h.pumpPlayback();
    await h.advance(1);
    await h.settle();
    expect(h.client.state.phase).toBe("listening");
    expect(h.tracks[0].enabled).toBe(true);
    socket.frame({ t: "stt_final", text: "replayed B", traceId: "B" });
    expect(
      h.events.filter((e) => e.t === "stt_final" && e.traceId === "B"),
    ).toHaveLength(1);
    expect(h.mints).toBe(1);
  },
);

test.each([false, "true", 1])(
  "malformed mint capability %j is refused once before WS/capture",
  async (capability) => {
    const h = harness(false, undefined, false, capability, true);
    await h.client.start();
    await h.settle();
    expect(h.mints).toBe(1);
    expect(h.sockets).toHaveLength(0);
    expect(h.captures).toBe(0);
  },
);

test("ready without negotiated capability is refused before capture without re-mint", async () => {
  const h = harness(false, undefined, false, true, true);
  h.holdReady();
  await h.client.start();
  await h.settle();
  h.sockets[0].frame({
    t: "ready",
    sessionId: "session-1",
    traceId: "ready-1",
  });
  await h.settle();
  await h.advance(120000);
  expect(h.mints).toBe(1);
  expect(h.captures).toBe(0);
  expect(h.errors).toHaveLength(1);
});

test("legacy callers keep their existing mint/hello and do not require the new capability", async () => {
  const h = harness(false, undefined, false, "missing", false);
  await h.client.start();
  await h.settle();
  expect(h.captures).toBe(1);
  expect(h.errors).toHaveLength(0);
  expect(h.bodies[0]).not.toHaveProperty("turnTerminal");
  expect(
    h.sockets[0].sent.find(
      (frame) =>
        !(frame instanceof ArrayBuffer) &&
        (frame as { t?: string }).t === "hello",
    ),
  ).not.toHaveProperty("turnTerminal");
});

test("an already prepared legacy offer is checked again before WS without a fresh mint loop", async () => {
  const h = harness(false, undefined, true, true, true);
  await h.client.start();
  await h.settle();
  const old = h.sockets[0];
  old.frame({ t: "stt_final", text: "pending", traceId: "A" });
  await h.advance(50000);
  expect(h.mints).toBe(2);
  expect(h.sockets).toHaveLength(1);
  h.dropLastMintCapability();
  old.frame({ t: "usage", sttMs: 1, ttsChars: 0, traceId: "A" });
  await h.advance(1000);
  await h.settle();
  expect(h.sockets).toHaveLength(1);
  expect(h.mints).toBe(2);
  expect(h.activeCaptures).toBe(0);
  expect(h.mintedTickets).toHaveLength(2);
});

test("terminal consumption is atomic before reentrant state observers", async () => {
  const h = harness(false, undefined, false, true, true);
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "request", traceId: "A" });
  let repeated = false;
  h.observeState((state) => {
    if (state.phase === "complete" && !repeated) {
      repeated = true;
      socket.frame({
        t: "turn_terminal",
        traceId: "A",
        outcome: "failed",
        code: "handler_error",
      });
    }
  });
  socket.frame({
    t: "turn_terminal",
    traceId: "A",
    outcome: "failed",
    code: "handler_error",
  });
  expect(h.events.filter((e) => e.t === "turn_terminal")).toHaveLength(1);
  expect(h.mints).toBe(1);
});

test("a new socket cannot inherit terminal negotiation before its own matching ready", async () => {
  const h = harness(false, undefined, false, true, true);
  await h.client.start();
  await h.settle();
  h.holdReady();
  h.sockets[0].close();
  await h.advance(1000);
  await h.settle();
  const next = h.sockets.at(-1)!;
  expect(h.sockets).toHaveLength(2);
  next.frame({ t: "stt_final", text: "pre-ready", traceId: "B" });
  next.frame({ t: "turn_terminal", traceId: "B", outcome: "failed" });
  expect(h.events.filter((e) => e.t === "turn_terminal")).toHaveLength(0);
  h.releaseReady();
  await h.settle();
  next.frame({ t: "stt_final", text: "valid", traceId: "C" });
  next.frame({ t: "turn_terminal", traceId: "C", outcome: "ignored" });
  expect(h.events.filter((e) => e.t === "turn_terminal")).toHaveLength(1);
  expect(h.mints).toBe(2);
});

test("server-originated interruption clears owned playback mute before listening", async () => {
  const h = harness(false, undefined, false, true, true);
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "request", traceId: "A" });
  socket.frame({ t: "speaking_start", traceId: "A" });
  socket.emit("message", { data: new Int16Array(320).fill(1000).buffer });
  expect(h.tracks[0].enabled).toBe(false);
  socket.frame({ t: "interrupted", reason: "explicit", traceId: "A" });
  await h.settle();
  expect(h.tracks[0].enabled).toBe(true);
  expect(h.client.state.phase).toBe("listening");
  expect(h.mints).toBe(1);
});

test("unknown and already settled interrupts cannot flush A queued PCM or retire C", async () => {
  const h = harness(true, undefined, false, true, true);
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "A", traceId: "A" });
  socket.frame({ t: "speaking_start", traceId: "A" });
  socket.emit("message", { data: new Int16Array(320).fill(1000).buffer });
  socket.frame({ t: "stt_final", text: "B", traceId: "B" });
  socket.frame({ t: "turn_terminal", traceId: "B", outcome: "failed" });
  for (const traceId of ["unknown", "B"])
    socket.frame({ t: "interrupted", traceId, reason: "explicit" });
  expect(h.events.filter((e) => e.t === "interrupted")).toHaveLength(0);
  expect(h.tracks[0].enabled).toBe(false);
  expect(h.client.state.playbackTraceId).toBe("A");
  socket.frame({ t: "stt_final", text: "C", traceId: "C" });
  socket.frame({ t: "interrupted", traceId: "B", reason: "explicit" });
  expect(h.client.state.traceId).toBe("C");
  expect(h.client.state.playbackTraceId).toBe("A");
  expect(h.tracks[0].enabled).toBe(false);
  expect(h.mints).toBe(1);
});

test("known B global interruption before B audio cancels pending work and flushes A exactly once", async () => {
  const h = harness(true, undefined, false, true, true);
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "A", traceId: "A" });
  socket.frame({ t: "speaking_start", traceId: "A" });
  socket.emit("message", { data: new Int16Array(320).fill(1000).buffer });
  socket.frame({ t: "stt_final", text: "B", traceId: "B" });
  socket.frame({ t: "interrupted", traceId: "B", reason: "explicit" });
  socket.frame({ t: "interrupted", traceId: "B", reason: "explicit" });
  expect(h.events.filter((e) => e.t === "interrupted")).toHaveLength(1);
  expect(h.client.state.playbackTraceId).toBeNull();
  expect(h.tracks[0].enabled).toBe(true);
  expect(h.mints).toBe(1);
  socket.frame({ t: "turn_terminal", traceId: "A", outcome: "failed" });
  expect(h.events.filter((e) => e.t === "turn_terminal")).toHaveLength(0);
});

test("actual playback ownership survives usage for the matching interruption, and local ACK survives optimistic flush", async () => {
  for (const local of [false, true]) {
    const h = harness(true, undefined, false, true, true);
    await h.client.start();
    await h.settle();
    const socket = h.sockets[0];
    socket.frame({ t: "stt_final", text: "A", traceId: "A" });
    socket.frame({ t: "speaking_start", traceId: "A" });
    socket.emit("message", { data: new Int16Array(320).fill(1000).buffer });
    if (local) h.client.bargeIn();
    socket.frame({ t: "usage", traceId: "A", sttMs: 1, ttsChars: 1 });
    socket.frame({ t: "interrupted", traceId: "A", reason: "explicit" });
    expect(h.events.filter((e) => e.t === "interrupted")).toHaveLength(1);
    expect(h.tracks[0].enabled).toBe(true);
    expect(h.mints).toBe(1);
    await h.client.stop();
  }
});

test("late local-barge ACK cannot retire a later admitted turn or its PCM", async () => {
  const h = harness(true, undefined, false, true, true);
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "A", traceId: "A" });
  socket.frame({ t: "speaking_start", traceId: "A" });
  socket.emit("message", { data: new Int16Array(320).fill(1000).buffer });
  h.client.bargeIn();
  socket.frame({ t: "stt_final", text: "C", traceId: "C" });
  socket.frame({ t: "speaking_start", traceId: "C" });
  socket.emit("message", { data: new Int16Array(320).fill(1000).buffer });
  socket.frame({ t: "interrupted", traceId: "A", reason: "explicit" });
  expect(h.events.filter((e) => e.t === "interrupted")).toHaveLength(0);
  expect(h.client.state.traceId).toBe("C");
  expect(h.client.state.playbackTraceId).toBe("C");
  expect(h.tracks[0].enabled).toBe(false);
  expect(h.mints).toBe(1);
});

function refuseTrackStop(track: { stop(): void }) {
  const stop = track.stop;
  track.stop = () => {
    throw new Error("track stop refused");
  };
  return () => {
    track.stop = stop;
  };
}

test("Stop ends a live track past a throwing disconnect, and resolving proves it", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  expect(h.activeCaptures).toBe(1);
  h.failSourceDisconnect();
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
  expect(h.errors).toEqual([]);
});

test("a track that refuses keeps Stop rejected until that capture's own retry confirms", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const allow = refuseTrackStop(h.tracks[0]);
  await expect(h.client.stop()).rejects.toBeInstanceOf(VoiceMicReleaseError);
  expect(h.activeCaptures).toBe(1);
  await expect(h.client.stop()).rejects.toMatchObject({
    code: "release_unconfirmed",
  });
  expect(h.activeCaptures).toBe(1);
  allow();
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
  await h.client.stop();
});

test("no capture opens over a release that is still refused", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const allow = refuseTrackStop(h.tracks[0]);
  await expect(h.client.stop()).rejects.toBeInstanceOf(VoiceMicReleaseError);
  await h.client.start();
  await h.settle();
  expect(h.captures).toBe(1);
  expect(h.errors.at(-1)).toBeInstanceOf(VoiceMicReleaseError);
  allow();
  await h.client.stop();
  await h.client.start();
  await h.settle();
  expect(h.captures).toBe(2);
  expect(h.maxCaptures).toBe(1);
  expect(h.activeCaptures).toBe(1);
});

test("recovery after a peer close opens no second capture over a refused release", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const allow = refuseTrackStop(h.tracks[0]);
  h.sockets[0].close();
  await h.settle();
  expect(h.captures).toBe(1);
  expect(h.errors.at(-1)).toBeInstanceOf(VoiceMicReleaseError);
  allow();
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
});

test("a stop the client ran itself leaves a refused release for the owner's Stop to find", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    const h = harness();
    await h.client.start();
    await h.settle();
    const allow = refuseTrackStop(h.tracks[0]);
    h.sockets[0].frame({
      t: "error",
      code: "insufficient_credits",
      retryable: false,
    });
    await h.settle();
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
    await expect(h.client.stop()).rejects.toBeInstanceOf(VoiceMicReleaseError);
    allow();
    await h.client.stop();
    expect(h.activeCaptures).toBe(0);
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});

test("a new capture asks a refused release again first, and opens once it confirms", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const allow = refuseTrackStop(h.tracks[0]);
  await expect(h.client.stop()).rejects.toBeInstanceOf(VoiceMicReleaseError);
  allow();
  await h.client.start();
  await h.settle();
  expect(h.captures).toBe(2);
  expect(h.maxCaptures).toBe(1);
  expect(h.activeCaptures).toBe(1);
  await h.client.stop();
});

test("a capture superseded before it attached keeps its refused release for Stop", async () => {
  const h = harness();
  const refusal = new VoiceMicReleaseError(async () => {});
  const stop = vi.fn(async () => {});
  stop.mockRejectedValueOnce(refusal);
  const spy = vi.spyOn(micCapture, "startVoiceMicCapture");
  try {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    spy.mockImplementation(async () => {
      await opened;
      return {
        active: false,
        stop,
        setMuted() {},
        backend: "scriptprocessor",
      } as unknown as micCapture.VoiceMicCapture;
    });
    const retry = vi.spyOn(refusal, "retryRelease");
    await h.client.start();
    await h.settle();
    const stopped = h.client.stop();
    open();
    await expect(stopped).rejects.toBe(refusal);
    expect(stop).toHaveBeenCalledOnce();
    await h.client.stop();
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
  }
});

test("a release refused while a capture failed to start is held for Stop", async () => {
  const h = harness();
  let refused = true;
  const retryRelease = vi.fn(async () => {
    if (refused) throw new VoiceMicReleaseError(retryRelease);
  });
  const spy = vi
    .spyOn(micCapture, "startVoiceMicCapture")
    .mockRejectedValue(new VoiceMicReleaseError(retryRelease));
  try {
    await h.client.start();
    await h.settle();
    await expect(h.client.stop()).rejects.toBeInstanceOf(VoiceMicReleaseError);
    expect(retryRelease).toHaveBeenCalledOnce();
    refused = false;
    await h.client.stop();
    expect(retryRelease).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
  }
});

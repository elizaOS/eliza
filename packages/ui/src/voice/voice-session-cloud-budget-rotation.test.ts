import { afterEach, expect, test, vi } from "vitest";
import {
  createVoiceSessionClient,
  type VoiceSessionClient,
  type VoiceWebSocketLike,
} from "./voice-session-client";
import type { MicAudioContextLike } from "./voice-session-mic-capture";
import * as micCapture from "./voice-session-mic-capture";
import type { PlaybackAudioContextLike } from "./voice-session-playback";
import type { ServerControlFrame } from "./voice-session-protocol";
import {
  applyClientAction,
  applyServerEvent,
  INITIAL_VOICE_SESSION_STATE,
  inputHeld,
  loopToListening,
  type VoiceSessionMachineState,
} from "./voice-session-state";

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
  maxReconnects?: number,
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
    releaseMint: (() => void) | undefined;
  const processors: Array<{
      onaudioprocess:
        | null
        | ((event: {
            inputBuffer: { getChannelData: () => Float32Array };
          }) => void);
    }> = [],
    tracks: Array<{ enabled: boolean; writes: boolean[]; stop(): void }> = [];
  const sockets: Socket[] = [],
    bodies: Record<string, unknown>[] = [],
    events: unknown[] = [],
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
    createMediaStreamSource: () => node(),
    createScriptProcessor: () => {
      const processor = { ...node(), onaudioprocess: null };
      processors.push(processor);
      return processor;
    },
    async resume() {},
    async close() {},
  });
  const playback: () => PlaybackAudioContextLike = () => ({
    sampleRate: 16000,
    state: "running",
    destination: node(),
    createScriptProcessor: () => ({ ...node(), onaudioprocess: null }),
    async resume() {},
    async close() {},
  });
  client = createVoiceSessionClient({
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
        sessionId: `session-${mints}`,
        token: invalidMint && mints > 1 ? "" : `one-use-${mints}`,
        wsUrl: `ws://localhost/voice-${mints}`,
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
      let stopped = false,
        enabled = true;
      const track = {
        // Every driver write, so a brief re-enable between two states is visible.
        writes: [] as boolean[],
        get enabled() {
          return enabled;
        },
        set enabled(value: boolean) {
          enabled = value;
          track.writes.push(value);
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
    maxReconnects,
    preLiveMaxReconnects: 0,
    preLiveMaxAttempts: 1,
    onMinted: () => {
      if (stopOnMint && mints > 1) void client?.stop();
    },
    onTraceMark: (mark) => marks.push(mark.name),
    onServerEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
  });
  return {
    client,
    sockets,
    tracks,
    pumpAudio() {
      processors[0]?.onaudioprocess?.({
        inputBuffer: {
          getChannelData: () => new Float32Array(4096).fill(0.25),
        },
      });
    },
    bodies,
    events,
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
const HELD_LOSS = (reason: string) =>
  `voice session lost mid-turn: ${reason}. Its outcome is unknown; start voice again.`;
const audio = (socket: { sent: unknown[] }) =>
  socket.sent.filter(
    (frame): frame is ArrayBuffer => frame instanceof ArrayBuffer,
  );
const silent = (frame: ArrayBuffer) =>
  new Uint8Array(frame).every((byte) => byte === 0);

test("a busy hard-expiry inside the hold ends voice with an honest error instead of re-minting, and never replays the finalized turn", async () => {
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
  // No paid re-mint and no replacement microphone track.
  expect(h.mints).toBe(1);
  expect(h.consents).toBe(1);
  expect(h.sockets).toHaveLength(1);
  expect(h.captures).toBe(1);
  expect(h.activeCaptures).toBe(0);
  expect(h.client.state.phase).toBe("idle");
  expect(h.errors.map((error) => error.message)).toEqual([
    HELD_LOSS("ws_close"),
  ]);
  expect(h.marks).toContain("token_rotation_deferred");
  expect(h.marks).toContain("not_reached(held_turn_lost:ws_close)");
  // The unfinished response is neither completed nor replayed, and late audio
  // from the retired socket is never played.
  const marks = h.marks.length;
  old.emit("message", { data: new ArrayBuffer(640) });
  expect(h.marks.slice(marks)).not.toContain("downlink_audio");
  expect(
    h.events.filter((event) => (event as { t: string }).t === "stt_final"),
  ).toHaveLength(1);
  expect(h.bodies.some((body) => "text" in body)).toBe(false);
  expect(
    h.events.some((event) => (event as { t: string }).t === "reply_complete"),
  ).toBe(false);
  await h.advance(120000);
  expect(h.mints).toBe(1);
  expect(h.captures).toBe(1);
  // Only an explicit start opens the next session and capture.
  await h.client.start();
  await h.settle();
  expect(h.mints).toBe(2);
  expect(h.captures).toBe(2);
  expect(h.maxCaptures).toBe(1);
  expect(h.client.state.phase).toBe("listening");
  expect(h.errors).toHaveLength(1);
});
test("a transport loss after local drain but before the turn's usage ends voice instead of re-minting", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  socket.frame({ t: "speaking_start", traceId: "turn-1" });
  socket.frame({ t: "speaking_end", traceId: "turn-1" });
  await h.settle();
  expect(h.client.state.phase).toBe("listening");
  expect(h.tracks[0].enabled).toBe(false);
  socket.close();
  await h.settle();
  await h.advance(60000);
  expect(h.mints).toBe(1);
  expect(h.captures).toBe(1);
  expect(h.activeCaptures).toBe(0);
  expect(h.tracks[0].writes).toEqual([false]);
  expect(h.client.state.phase).toBe("idle");
  expect(h.errors.map((error) => error.message)).toEqual([
    HELD_LOSS("ws_close"),
  ]);
});
test("a fatal server error inside the hold never re-enables the track and ends voice without a re-mint", async () => {
  for (const window of ["thinking", "drained"] as const) {
    const h = harness();
    await h.client.start();
    await h.settle();
    const socket = h.sockets[0];
    socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
    if (window === "drained") {
      socket.frame({ t: "speaking_start", traceId: "turn-1" });
      socket.frame({ t: "speaking_end", traceId: "turn-1" });
      await h.settle();
    }
    expect(h.tracks[0].enabled).toBe(false);
    socket.frame({ t: "error", code: "provider_error", retryable: false });
    await h.settle();
    await h.advance(60000);
    // Disabled once at the hold, then stopped: never enabled in between.
    expect(h.tracks[0].writes).toEqual([false]);
    expect(h.activeCaptures).toBe(0);
    expect(h.captures).toBe(1);
    expect(h.mints).toBe(1);
    expect(h.client.state.phase).toBe("idle");
    expect(h.errors.map((error) => error.message)).toEqual([
      HELD_LOSS("server_error"),
    ]);
  }
});
test("Cloud streaming without automatic reconnects ends a held turn's loss the same way", async () => {
  const h = harness(false, undefined, 0);
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  socket.close();
  await h.settle();
  expect(h.mints).toBe(1);
  expect(h.captures).toBe(1);
  expect(h.activeCaptures).toBe(0);
  expect(h.client.state.phase).toBe("idle");
  expect(h.errors.map((error) => error.message)).toEqual([
    HELD_LOSS("ws_close"),
  ]);
});
test("the same losses outside the hold keep today's recovery with one replacement capture", async () => {
  for (const loss of ["close", "fatal"] as const) {
    const h = harness();
    await h.client.start();
    await h.settle();
    const socket = h.sockets[0];
    socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
    socket.frame({ t: "speaking_start", traceId: "turn-1" });
    socket.frame({ t: "speaking_end", traceId: "turn-1" });
    socket.frame({ t: "usage", sttMs: 0, ttsChars: 5, traceId: "turn-1" });
    await h.settle();
    expect(h.tracks[0].enabled).toBe(true);
    if (loss === "close") socket.close();
    else socket.frame({ t: "error", code: "provider_error", retryable: false });
    await h.settle();
    expect(h.mints).toBe(2);
    expect(h.captures).toBe(2);
    expect(h.maxCaptures).toBe(1);
    expect(h.errors).toHaveLength(0);
    expect(h.client.state.phase).toBe("listening");
    // Frames from the retired session cannot hold the new capture.
    socket.frame({ t: "stt_final", text: "late", traceId: "turn-1" });
    expect(h.client.state.phase).toBe("listening");
    expect(h.tracks[1].enabled).toBe(true);
    await h.client.stop();
  }
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

test("playback drain sends its exact completion, and microphone audio resumes only at the turn's usage", async () => {
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
    // The server still holds the caller turn until its usage receipt.
    expect(h.tracks[0].enabled).toBe(false);
    h.pumpAudio();
    expect(audio(socket).length).toBeGreaterThan(0);
    expect(audio(socket).every(silent)).toBe(true);
    const completion = socket.sent.findIndex(
      (frame) => (frame as { t?: string }).t === "playback_complete",
    );
    if (supported) {
      expect(socket.sent[completion]).toEqual({
        t: "playback_complete",
        traceId: "turn-1",
      });
    } else expect(completion).toBe(-1);
    socket.frame({ t: "usage", sttMs: 0, ttsChars: 5, traceId: "turn-1" });
    expect(h.tracks[0].enabled).toBe(true);
    const resumed = socket.sent.length;
    h.pumpAudio();
    expect(audio({ sent: socket.sent.slice(resumed) }).some(silent)).toBe(
      false,
    );
    expect(resumed).toBeGreaterThan(completion);
    await h.client.stop();
  }
});

test("a submitted turn holds the microphone from stt_final until speech starts", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  h.pumpAudio();
  expect(audio(socket).some(silent)).toBe(false);
  const listening = socket.sent.length;
  socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  expect(h.client.state.phase).toBe("thinking");
  expect(h.tracks[0].enabled).toBe(false);
  h.pumpAudio();
  const held = audio({ sent: socket.sent.slice(listening) });
  expect(held.length).toBeGreaterThan(0);
  expect(held.every(silent)).toBe(true);
  expect(h.client.microphoneHeld).toBe(true);
  expect(h.client.microphoneMuted).toBe(false);
  socket.frame({ t: "progress", text: "One moment", traceId: "turn-1" });
  socket.frame({ t: "speaking_start", traceId: "turn-1" });
  expect(h.tracks[0].writes).toEqual([false]);
});

test("held uplink substitutes silence even for capture frames the driver did not mute", async () => {
  const real = micCapture.startVoiceMicCapture,
    ports: Array<Parameters<typeof real>[0]> = [];
  const spy = vi
    .spyOn(micCapture, "startVoiceMicCapture")
    .mockImplementation(async (options) => {
      ports.push(options);
      return real(options);
    });
  try {
    const h = harness();
    await h.client.start();
    await h.settle();
    const socket = h.sockets[0];
    socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
    socket.frame({ t: "speaking_start", traceId: "turn-1" });
    socket.frame({ t: "speaking_end", traceId: "turn-1" });
    await h.settle();
    for (const phase of ["listening", "thinking"] as const) {
      if (phase === "thinking")
        socket.frame({ t: "stt_final", text: "and mail", traceId: "turn-2" });
      expect(h.client.state.phase).toBe(phase);
      const count = socket.sent.length;
      ports[0].onFrame(new Uint8Array(320).fill(7));
      const sent = audio({ sent: socket.sent.slice(count) });
      expect(sent).toHaveLength(1);
      expect(sent.every(silent)).toBe(true);
    }
    socket.frame({ t: "usage", sttMs: 0, ttsChars: 0, traceId: "turn-2" });
    const count = socket.sent.length;
    ports[0].onFrame(new Uint8Array(320).fill(7));
    expect(audio({ sent: socket.sent.slice(count) }).some(silent)).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

test("only the held turn's own usage or interruption, or an explicit barge-in, releases the hold", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: " ", traceId: "empty" });
  expect(h.client.state.phase).toBe("listening");
  expect(h.tracks[0].enabled).toBe(true);
  socket.frame({ t: "stt_final", text: "remember this", traceId: "silent" });
  expect(h.tracks[0].enabled).toBe(false);
  socket.frame({ t: "usage", sttMs: 0, ttsChars: 0, traceId: "silent" });
  expect(h.client.state.phase).toBe("listening");
  expect(h.tracks[0].enabled).toBe(true);
  socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-2" });
  socket.frame({ t: "usage", sttMs: 0, ttsChars: 0, traceId: "silent" });
  socket.frame({ t: "interrupted", reason: "explicit", traceId: "silent" });
  socket.frame({ t: "error", code: "stt_reconnecting", retryable: true });
  expect(h.client.state.phase).toBe("listening");
  expect(h.tracks[0].enabled).toBe(false);
  expect(h.client.microphoneHeld).toBe(true);
  socket.frame({ t: "interrupted", reason: "explicit", traceId: "turn-2" });
  expect(h.tracks[0].enabled).toBe(true);
  socket.frame({ t: "stt_final", text: "and calendar", traceId: "turn-3" });
  socket.frame({ t: "speaking_start", traceId: "turn-3" });
  socket.frame({ t: "speaking_end", traceId: "turn-3" });
  await h.settle();
  expect(h.client.state.phase).toBe("listening");
  expect(h.tracks[0].enabled).toBe(false);
  h.client.bargeIn();
  expect(h.tracks[0].enabled).toBe(true);
  expect(socket.sent).toContainEqual({ t: "barge_in" });
  expect(h.mints).toBe(1);
  expect(h.errors).toHaveLength(0);
});

test("manual mute stays independent of the hold in both directions", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  h.client.setMicrophoneMuted(true);
  socket.frame({ t: "usage", sttMs: 0, ttsChars: 0, traceId: "turn-1" });
  expect(h.tracks[0].enabled).toBe(false);
  expect(h.client.microphoneMuted).toBe(true);
  socket.frame({ t: "stt_final", text: "and mail", traceId: "turn-2" });
  h.client.setMicrophoneMuted(false);
  expect(h.tracks[0].enabled).toBe(false);
  expect(h.client.microphoneMuted).toBe(false);
  expect(h.client.microphoneHeld).toBe(true);
  socket.frame({ t: "usage", sttMs: 0, ttsChars: 0, traceId: "turn-2" });
  expect(h.tracks[0].enabled).toBe(true);
  expect(h.client.microphoneHeld).toBe(false);
  expect(h.tracks[0].writes).toEqual([false, true]);
  h.client.setMicrophoneMuted(true);
  expect(h.client.microphoneMuted).toBe(true);
  expect(h.client.microphoneHeld).toBe(false);
});

test("Stop during the hold stops the track without re-enabling it, and late turn frames are inert", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  expect(h.tracks[0].enabled).toBe(false);
  await h.client.stop();
  expect(h.activeCaptures).toBe(0);
  socket.frame({ t: "speaking_end", traceId: "turn-1" });
  socket.frame({ t: "usage", sttMs: 0, ttsChars: 0, traceId: "turn-1" });
  expect(h.client.state.phase).toBe("idle");
  expect(h.client.microphoneHeld).toBe(false);
  expect(h.tracks[0].writes).toEqual([false]);
  expect(h.mints).toBe(1);
  expect(h.captures).toBe(1);
});

test("a rotation due while the drained turn awaits its usage waits for that usage", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  socket.frame({ t: "speaking_start", traceId: "turn-1" });
  socket.frame({ t: "speaking_end", traceId: "turn-1" });
  await h.settle();
  expect(h.client.state.phase).toBe("listening");
  await h.advance(55000);
  expect(h.mints).toBe(1);
  expect(socket.sent).not.toContainEqual({ t: "bye" });
  expect(h.marks).toContain("token_rotation_deferred");
  socket.frame({ t: "usage", sttMs: 0, ttsChars: 5, traceId: "turn-1" });
  await h.advance(1000);
  expect(h.mints).toBe(2);
  expect(socket.sent).toContainEqual({ t: "bye" });
  expect(h.captures).toBe(1);
  expect(h.errors).toHaveLength(0);
});

test("after the held turn's usage the next utterance uplinks real PCM and its final holds again", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const socket = h.sockets[0];
  socket.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  socket.frame({ t: "speaking_start", traceId: "turn-1" });
  socket.frame({ t: "speaking_end", traceId: "turn-1" });
  socket.frame({ t: "usage", sttMs: 0, ttsChars: 5, traceId: "turn-1" });
  await h.settle();
  let count = socket.sent.length;
  socket.frame({ t: "stt_partial", text: "and", traceId: "turn-2" });
  expect(h.client.state.phase).toBe("transcribing");
  expect(h.tracks[0].enabled).toBe(true);
  h.pumpAudio();
  const spoken = audio({ sent: socket.sent.slice(count) });
  expect(spoken.length).toBeGreaterThan(0);
  expect(spoken.some(silent)).toBe(false);
  socket.frame({ t: "stt_final", text: "and mail", traceId: "turn-2" });
  expect(h.tracks[0].enabled).toBe(false);
  expect(h.client.microphoneHeld).toBe(true);
  count = socket.sent.length;
  h.pumpAudio();
  expect(audio({ sent: socket.sent.slice(count) }).every(silent)).toBe(true);
  socket.frame({ t: "usage", sttMs: 0, ttsChars: 0, traceId: "turn-2" });
  expect(h.tracks[0].enabled).toBe(true);
  expect(h.mints).toBe(1);
  expect(h.errors).toHaveLength(0);
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

/**
 * Reducer cases ported from Alpha's development-cartesia-conversation
 * projection. Like the client, generation end is not reduced on arrival; it is
 * folded in only when local playback drains. Returns `inputHeld` after each step.
 */
function heldAfter(
  steps: Array<ServerControlFrame | { drain: string }>,
  from: VoiceSessionMachineState = {
    ...INITIAL_VOICE_SESSION_STATE,
    phase: "listening",
  },
): boolean[] {
  let state = from;
  return steps.map((step) => {
    if ("drain" in step) {
      if (state.phase === "speaking" && state.traceId === step.drain)
        state = loopToListening(
          applyServerEvent(state, { t: "speaking_end", traceId: step.drain }),
        );
    } else if (step.t !== "speaking_end") state = applyServerEvent(state, step);
    return inputHeld(state);
  });
}

test("the hold starts only at an accepted nonempty final and lasts through generation end until drain", () => {
  expect(
    heldAfter([
      { t: "stt_partial", text: "partial", traceId: "turn" },
      { t: "stt_final", text: "check notes", traceId: "turn" },
      { t: "speaking_start", traceId: "turn" },
      { t: "speaking_end", traceId: "turn" },
      { t: "usage", traceId: "old" },
      { t: "usage", traceId: "turn" },
      { drain: "turn" },
    ]),
  ).toEqual([false, true, true, true, true, true, false]);
  expect(
    heldAfter([
      { t: "stt_final", text: " ", traceId: "empty" },
      { t: "stt_final", text: "check notes", traceId: "turn" },
    ]),
  ).toEqual([false, true]);
});

test("matching usage does not release playback that has not drained, and drain does not release before usage", () => {
  expect(
    heldAfter([
      { t: "stt_final", text: "check notes", traceId: "turn" },
      { t: "speaking_start", traceId: "turn" },
      { t: "usage", traceId: "turn" },
      { t: "speaking_end", traceId: "turn" },
      { drain: "turn" },
    ]),
  ).toEqual([true, true, true, true, false]);
  expect(
    heldAfter([
      { t: "stt_final", text: "check", traceId: "turn" },
      { t: "speaking_start", traceId: "turn" },
      { t: "speaking_end", traceId: "turn" },
      { drain: "turn" },
      { t: "usage", traceId: "turn" },
    ]),
  ).toEqual([true, true, true, true, false]);
});

test("old usage and old interruption cannot release a newer accepted turn", () => {
  expect(
    heldAfter([
      { t: "stt_final", text: "first", traceId: "first" },
      { t: "stt_final", text: "second", traceId: "second" },
      { t: "usage", traceId: "first" },
      { t: "interrupted", traceId: "first", reason: "explicit" },
      { t: "usage", traceId: "second" },
    ]),
  ).toEqual([true, true, true, true, false]);
});

test("a silent turn releases at its own usage or interruption; an error never releases a turn", () => {
  const request: ServerControlFrame = {
    t: "stt_final",
    text: "silent request",
    traceId: "turn",
  };
  expect(heldAfter([request, { t: "usage", traceId: "turn" }])).toEqual([
    true,
    false,
  ]);
  expect(
    heldAfter([
      request,
      { t: "interrupted", traceId: "turn", reason: "explicit" },
    ]),
  ).toEqual([true, false]);
  // Unlike Alpha's projection, a fatal error keeps the hold, also after the
  // reply drained: server error frames carry no turn, and the client ends in
  // a new session or a reset.
  expect(
    heldAfter([
      request,
      { t: "speaking_start", traceId: "turn" },
      { drain: "turn" },
      { t: "error", traceId: "turn", code: "unavailable", retryable: false },
      { t: "ready", sessionId: "next", traceId: "ready-2" },
    ]),
  ).toEqual([true, true, true, true, false]);
  const held = applyServerEvent(
    { ...INITIAL_VOICE_SESSION_STATE, phase: "listening" },
    request,
  );
  expect(inputHeld(applyClientAction(held, { type: "client/reset" }))).toBe(
    false,
  );
});

for (const code of ["stt_reconnecting", "transport_error"])
  test(`retryable unscoped ${code} keeps the hold until the matching usage`, () => {
    expect(
      heldAfter([
        { t: "stt_final", text: "active request", traceId: "active" },
        { t: "error", code, retryable: true },
        { t: "usage", traceId: "other" },
        { t: "usage", traceId: "active" },
      ]),
    ).toEqual([true, true, true, false]);
  });

test("an opening greeting and server fallback speech hold input until local drain", () => {
  expect(
    heldAfter([
      { t: "speaking_start", traceId: "greeting" },
      { t: "speaking_end", traceId: "greeting" },
      { t: "usage", traceId: "greeting" },
      { drain: "greeting" },
    ]),
  ).toEqual([true, true, true, false]);
  expect(
    heldAfter([
      { t: "stt_final", text: "request", traceId: "request" },
      { t: "usage", traceId: "request" },
      { t: "speaking_start", traceId: "fallback" },
      { t: "speaking_end", traceId: "fallback" },
      { drain: "fallback" },
    ]),
  ).toEqual([true, false, true, true, false]);
});

test("old greeting events and drain cannot release a newer accepted request", () => {
  expect(
    heldAfter([
      { t: "speaking_start", traceId: "greeting" },
      { t: "speaking_end", traceId: "greeting" },
      { drain: "greeting" },
      { t: "stt_final", text: "new request", traceId: "new" },
      { t: "speaking_start", traceId: "greeting" },
      { t: "speaking_end", traceId: "greeting" },
      { t: "usage", traceId: "greeting" },
      { drain: "greeting" },
      { t: "usage", traceId: "new" },
    ]),
  ).toEqual([true, true, false, true, true, true, true, true, false]);
});

test("a new server session or an explicit barge-in ends the caller turn; thinking waits for the server", () => {
  const thinking = applyServerEvent(
    { ...INITIAL_VOICE_SESSION_STATE, phase: "listening" },
    { t: "stt_final", text: "old request", traceId: "old" },
  );
  const speaking = applyServerEvent(thinking, {
    t: "speaking_start",
    traceId: "old",
  });
  const drained = loopToListening(
    applyServerEvent(speaking, { t: "speaking_end", traceId: "old" }),
  );
  expect(
    inputHeld(
      applyServerEvent(speaking, {
        t: "ready",
        sessionId: "next",
        traceId: "ready-2",
      }),
    ),
  ).toBe(false);
  const bargeIn = { type: "client/local_barge_in" } as const;
  expect(inputHeld(applyClientAction(drained, bargeIn))).toBe(false);
  expect(inputHeld(applyClientAction(speaking, bargeIn))).toBe(false);
  // Thinking is server-authoritative: it ends at the server's `interrupted`.
  expect(inputHeld(applyClientAction(thinking, bargeIn))).toBe(true);
});

import { afterEach, expect, test, vi } from "vitest";
import {
  createVoiceSessionClient,
  type VoiceSessionClient,
  type VoiceSessionClientOptions,
  type VoiceWebSocketLike,
} from "./voice-session-client";
import type { MicAudioContextLike } from "./voice-session-mic-capture";
import * as micCapture from "./voice-session-mic-capture";
import type { PlaybackAudioContextLike } from "./voice-session-playback";

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

// The clean bye + re-mint rotation remains the fallback whenever no prepared
// session can take over; these cases pin that path.
const BREAK_BEFORE_MAKE = { rotationPrepareLeadMs: 0 };
function harness(
  playbackCompletion = false,
  getUiContext?: () => { uiViewPath?: string },
  clientOptions: Partial<VoiceSessionClientOptions> = {},
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
    openSockets = 0,
    maxOpenSockets = 0,
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
    tracks: Array<{ enabled: boolean; stop(): void }> = [];
  const sockets: Socket[] = [],
    bodies: Record<string, unknown>[] = [],
    events: unknown[] = [],
    errors: Error[] = [],
    marks: string[] = [],
    phases: string[] = [],
    timeline: string[] = [];
  class Socket implements VoiceWebSocketLike {
    readyState = 0;
    binaryType = "arraybuffer";
    listeners = new Map<string, ((event: unknown) => void)[]>();
    sent: unknown[] = [];
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        maxOpenSockets = Math.max(maxOpenSockets, ++openSockets);
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
      timeline.push(`${sockets.indexOf(this)}<${(value as { t: string }).t}`);
      this.emit("message", { data: JSON.stringify(value) });
    }
    send(data: string | ArrayBuffer | ArrayBufferView) {
      if (typeof data === "string") {
        const frame = JSON.parse(data);
        this.sent.push(frame);
        timeline.push(`${sockets.indexOf(this)}>${frame.t}`);
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
      if (this.readyState === 1) openSockets--;
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
      let stopped = false;
      const track = {
        enabled: true,
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
    onMinted: () => {
      if (stopOnMint && mints > 1) void client?.stop();
    },
    onTraceMark: (mark) => marks.push(mark.name),
    onState: (state) => phases.push(state.phase),
    onServerEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
    ...clientOptions,
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
    phases,
    timeline,
    get maxOpenSockets() {
      return maxOpenSockets;
    },
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
  // Each rotation adds exactly one prepared session; none is re-minted.
  expect(h.marks.some((mark) => mark.startsWith("reconnect_remint"))).toBe(
    false,
  );
  expect(h.maxOpenSockets).toBe(2);
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
type FakeSocket = ReturnType<typeof harness>["sockets"][number];
const audioFrames = (socket: FakeSocket) =>
  socket.sent.filter((frame) => frame instanceof ArrayBuffer).length;
const saidBye = (socket: FakeSocket) =>
  socket.sent.some((frame) => (frame as { t?: string }).t === "bye");
const finals = (h: ReturnType<typeof harness>) =>
  h.events.filter((event) => (event as { t: string }).t === "stt_final");

test("rotation prepares the next session while the live one keeps hearing, then hands audio over with no gap", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const [live] = h.sockets;
  h.holdReady();
  await h.advance(40000);
  // The next session is minted and connecting; the live one is untouched.
  expect(h.marks).toContain("token_rotation_prepare");
  expect(h.mints).toBe(2);
  const next = h.sockets[1];
  const phasesBefore = h.phases.length;
  h.pumpAudio();
  expect(audioFrames(live)).toBeGreaterThan(0);
  expect(audioFrames(next)).toBe(0);
  expect(h.tracks[0].enabled).toBe(true);
  // The next session is ready while speech is still arriving: no switch yet.
  h.releaseReady();
  await h.settle();
  expect(saidBye(live)).toBe(false);
  const beforeSwitch = audioFrames(live);
  h.pumpAudio();
  expect(audioFrames(live)).toBeGreaterThan(beforeSwitch);
  // At the quiet listening boundary the ready session takes the microphone,
  // and only then does the old session get bye.
  await h.advance(1000);
  expect(h.timeline.indexOf("1<ready")).toBeGreaterThan(-1);
  expect(h.timeline.indexOf("1<ready")).toBeLessThan(
    h.timeline.indexOf("0>bye"),
  );
  const oldTotal = audioFrames(live);
  h.pumpAudio();
  expect(audioFrames(next)).toBeGreaterThan(0);
  expect(audioFrames(live)).toBe(oldTotal);
  expect(
    h.phases.slice(phasesBefore).every((phase) => phase === "listening"),
  ).toBe(true);
  // Transcription continues on the new session; the old one is fenced.
  live.frame({ t: "stt_final", text: "stale", traceId: "old" });
  next.frame({ t: "stt_final", text: "create a note", traceId: "turn-2" });
  expect(finals(h)).toHaveLength(1);
  expect(h.client.state.phase).toBe("thinking");
  expect(h.mints).toBe(2);
  expect(h.captures).toBe(1);
  expect(h.maxOpenSockets).toBe(2);
  expect(h.marks.filter((mark) => mark === "token_rotation")).toHaveLength(1);
  expect(h.marks.some((mark) => mark.startsWith("reconnect_remint"))).toBe(
    false,
  );
  expect(h.errors).toHaveLength(0);
});
test("continuous speech holds a prepared switch only until half the fallback lead remains", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  await h.advance(39000);
  let switchedAtMs: number | null = null;
  for (let at = 39000; at < 58000 && switchedAtMs === null; at += 500) {
    h.pumpAudio();
    await h.advance(500);
    if (saidBye(h.sockets[0])) switchedAtMs = at + 500;
  }
  expect(h.marks).toContain("token_rotation_standby_ready");
  expect(switchedAtMs).toBe(55000);
  expect(h.mints).toBe(2);
  expect(h.errors).toHaveLength(0);
});
test("a reply in progress keeps the live session until playback ends, then switches without replaying the turn", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const [live] = h.sockets;
  live.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  live.frame({ t: "speaking_start", traceId: "turn-1" });
  await h.advance(45000);
  expect(h.marks).toContain("token_rotation_standby_ready");
  expect(h.marks).toContain("token_rotation_deferred");
  expect(saidBye(live)).toBe(false);
  live.frame({ t: "speaking_end", traceId: "turn-1" });
  live.frame({ t: "usage", sttMs: 1000, ttsChars: 12, traceId: "turn-1" });
  await h.advance(1000);
  expect(saidBye(live)).toBe(true);
  expect(h.client.state.phase).toBe("listening");
  expect(h.mints).toBe(2);
  expect(finals(h)).toHaveLength(1);
  expect(h.bodies.some((body) => "text" in body)).toBe(false);
  expect(h.captures).toBe(1);
});
test("a turn still running at hard expiry hands over to the ready next session without another mint", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  const [live] = h.sockets;
  live.frame({ t: "stt_final", text: "open notes", traceId: "turn-1" });
  live.frame({ t: "speaking_start", traceId: "turn-1" });
  await h.advance(60000);
  // The next session became ready before the server severed the busy one.
  expect(h.marks).toContain("token_rotation_standby_ready");
  expect(h.mints).toBe(2);
  live.close();
  await h.settle();
  expect(h.mints).toBe(2);
  expect(h.sockets).toHaveLength(2);
  expect(h.client.state.phase).toBe("listening");
  expect(h.maxCaptures).toBe(1);
  expect(finals(h)).toHaveLength(1);
  expect(h.bodies.some((body) => "text" in body)).toBe(false);
  expect(h.errors).toHaveLength(0);
});
test("Stop while the next session is connecting ends both sessions and opens nothing more", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.holdReady();
  await h.advance(40000);
  expect(h.sockets).toHaveLength(2);
  await h.client.stop();
  expect(h.sockets.every((socket) => saidBye(socket))).toBe(true);
  expect(h.sockets.every((socket) => socket.readyState === 3)).toBe(true);
  expect(h.activeCaptures).toBe(0);
  h.releaseReady();
  await h.advance(70000);
  expect(h.mints).toBe(2);
  expect(h.sockets).toHaveLength(2);
  expect(h.errors).toHaveLength(0);
});
test("a refused next session falls back to the clean idle rotation with at most one overlap", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  h.holdReady();
  await h.advance(40000);
  h.sockets[1].frame({ t: "error", code: "unavailable", retryable: false });
  await h.settle();
  expect(saidBye(h.sockets[1])).toBe(true);
  expect(saidBye(h.sockets[0])).toBe(false);
  // A late ready from the refused session is ignored.
  h.releaseReady();
  await h.advance(10000);
  expect(h.mints).toBe(3);
  expect(saidBye(h.sockets[0])).toBe(true);
  expect(h.client.state.phase).toBe("listening");
  expect(h.maxOpenSockets).toBe(2);
  expect(h.errors).toHaveLength(0);
});
test("rotation defers a live finalized turn until listening, then rotates without resubmitting that user turn", async () => {
  const h = harness(false, undefined, BREAK_BEFORE_MAKE);
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
  const h = harness(false, undefined, BREAK_BEFORE_MAKE);
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
  const h = harness(false, undefined, BREAK_BEFORE_MAKE);
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
  const h = harness(false, undefined, BREAK_BEFORE_MAKE);
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
    const h = harness(false, undefined, BREAK_BEFORE_MAKE);
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
  const h = harness(false, undefined, BREAK_BEFORE_MAKE);
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
  const h = harness(false, undefined, BREAK_BEFORE_MAKE);
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
  const h = harness(false, undefined, BREAK_BEFORE_MAKE);
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

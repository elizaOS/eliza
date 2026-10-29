import { describe, expect, it, vi } from "vitest";
import { LIVE_ASR_PATH, LIVE_ASR_STATUS_PATH } from "./live-voice-session";
import {
  createNativeLiveVoice,
  type NativeLiveCapturePort,
  type NativeResidentBinding,
  nativeVoiceStageSink,
  openNativeResidentCapture,
  readNativeVoiceTiming,
  residentLiveTransport,
} from "./native-live-voice";

// Contract of the renderer transport against a fake native speech bridge and a stub resident
// agent. Not microphone, VAD, recognition or latency evidence.
type Listener = (event: Record<string, unknown>) => void;
function fakeBridge(
  options: {
    nativeTransport?: boolean;
    available?: boolean;
    serverClosed?: boolean;
    echoCancelled?: boolean;
    startDelay?: Promise<void>;
  } = {},
) {
  const listeners = new Map<string, Set<Listener>>();
  const starts: Array<Record<string, unknown>> = [];
  const stops: Array<Record<string, unknown>> = [];
  let removed = 0;
  const port: NativeLiveCapturePort = {
    liveCaptureStatus: async () => ({
      available: options.available ?? true,
      nativeTransport: options.nativeTransport ?? true,
    }),
    startLiveCapture: async (input) => {
      starts.push({ ...input });
      await options.startDelay;
      return {
        captureId: input.captureId,
        sampleRate: 16000,
        echoCancelled: options.echoCancelled ?? true,
        nativeAsr: input.nativeAsr === true,
      };
    },
    stopLiveCapture: async (input) => {
      stops.push({ ...input });
      return {
        captureId: input.captureId,
        durationMs: 10,
        serverClosed: options.serverClosed ?? true,
      };
    },
    addListener: async (event, callback) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      listeners.set(event, set);
      set.add(callback as Listener);
      return {
        remove: async () => {
          removed++;
          set.delete(callback as Listener);
        },
      };
    },
  };
  return {
    port,
    starts,
    stops,
    get removed() {
      return removed;
    },
    get listening() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
    emit(event: string, payload: Record<string, unknown>) {
      for (const listener of [...(listeners.get(event) ?? [])])
        listener(payload);
    },
    get captureId() {
      return starts.at(-1)?.captureId as string;
    },
  };
}
function residentAgent(ready = true) {
  let feed: ((envelope: unknown) => void) | undefined;
  const requests: Array<{ path: string; body: unknown }> = [];
  let binding: NativeResidentBinding | null = {
    sessionId: "session-1",
    ownerId: "owner-1",
    request: async (path, body) => {
      requests.push({ path, body: structuredClone(body) });
      if (path === LIVE_ASR_STATUS_PATH) return { ready };
      const vad = (body as { vad?: Array<{ type: string }> }).vad ?? [];
      return vad.some((edge) => edge.type === "speech-end")
        ? {
            ok: true,
            mode: "stream",
            framesReceived: 1,
            final: {
              turnId: `t${requests.length}`,
              text: "posted",
              mode: "stream",
            },
          }
        : { ok: true, mode: "stream", framesReceived: 1 };
    },
    subscribe: (listener) => {
      feed = listener;
      return () => {
        feed = undefined;
      };
    },
  };
  return {
    requests,
    resident: () => binding,
    set(next: NativeResidentBinding | null) {
      binding = next;
    },
    partial(sessionId: string, turnId: string, text: string, seq: number) {
      feed?.({
        type: "agent_event",
        stream: "voice-transcript",
        payload: {
          type: "voice-transcript",
          sessionId,
          turnId,
          phase: "partial",
          text,
          seq,
        },
      });
    },
    speechStart(sessionId: string, turnId: string) {
      feed?.({
        type: "agent_event",
        stream: "voice-transcript",
        payload: {
          type: "voice-transcript",
          sessionId,
          turnId,
          phase: "speech-start",
        },
      });
    },
    get subscribed() {
      return feed !== undefined;
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function handlers() {
  const segments: Array<string | null> = [];
  const latencies: unknown[] = [];
  const interim: string[] = [];
  const lost: unknown[] = [];
  const edges: string[] = [];
  const levels: number[] = [];
  return {
    segments,
    latencies,
    interim,
    lost,
    edges,
    levels,
    open: (signal: AbortSignal, echoCancel = true) => ({
      signal,
      echoCancel,
      onSegment: (text: string | null, latency?: unknown) => {
        segments.push(text);
        latencies.push(latency);
      },
      onInterim: (text: string) => interim.push(text),
      onLost: (error: unknown) => lost.push(error),
      onSpeechStart: (at: number) => edges.push(`start:${at}`),
      onSpeechEnd: (at: number) => edges.push(`end:${at}`),
      onLevel: (peak: number) => levels.push(peak),
    }),
  };
}

describe("native resident capture", () => {
  it("routes natively for the owner, drops other capture ids and delivers each final once in order", async () => {
    const bridge = fakeBridge();
    const agent = residentAgent();
    const voice = createNativeLiveVoice({
      port: bridge.port,
      available: () => true,
      resident: agent.resident,
    });
    const out = handlers();
    const capture = await voice.open(out.open(new AbortController().signal));
    expect(bridge.starts[0]).toMatchObject({
      echoCancel: true,
      nativeAsr: true,
      ownerId: "owner-1",
    });
    expect(bridge.captureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(capture.echoCancelled).toBe(true);
    const id = bridge.captureId;
    // A stale capture's events never reach this one.
    bridge.emit("liveCaptureFrames", {
      captureId: "stale",
      peak: 0.9,
      vad: [{ type: "speech-start", timestampMs: 1 }],
    });
    bridge.emit("liveCaptureTranscript", {
      captureId: "stale",
      final: { turnId: "x", text: "other", mode: "stream" },
    });
    expect(out.edges).toEqual([]);
    expect(out.levels).toEqual([]);
    // PCM fields from an older bridge are ignored; only level and VAD are read.
    bridge.emit("liveCaptureFrames", {
      captureId: id,
      peak: 2,
      frames: [{ pcm16: "AAAA" }],
      vad: [{ type: "speech-start", timestampMs: 10 }],
    });
    expect(capture.speaking()).toBe(true);
    bridge.emit("liveCaptureFrames", {
      captureId: id,
      vad: [{ type: "speech-end", timestampMs: 20 }],
    });
    expect(out.segments).toEqual([]);
    const final = {
      turnId: "turn-1",
      text: " hello ",
      mode: "stream",
      asrFinalFromSpeechEndMs: 30,
    };
    bridge.emit("liveCaptureTranscript", { captureId: id, final });
    bridge.emit("liveCaptureTranscript", { captureId: id, final });
    expect(out.levels).toEqual([1]);
    expect(out.edges).toEqual(["start:10", "end:20"]);
    expect(out.segments).toEqual(["hello"]);
    expect(out.latencies[0]).toEqual({
      mode: "stream",
      partials: 0,
      asrFinalFromSpeechEndMs: 30,
    });
    // An ASR failure closes its segment with no transcript.
    bridge.emit("liveCaptureFrames", {
      captureId: id,
      vad: [
        { type: "speech-start", timestampMs: 40 },
        { type: "speech-end", timestampMs: 50 },
      ],
    });
    bridge.emit("liveCaptureTranscript", {
      captureId: id,
      error: "ASR_FAILED",
    });
    expect(out.segments).toEqual(["hello", null]);
    await capture.close(60);
    expect(bridge.stops).toEqual([
      { captureId: id, discard: false, cutoffMs: 60 },
    ]);
    expect(bridge.listening).toBe(0);
    expect(agent.subscribed).toBe(false);
    expect(out.lost).toEqual([]);
  });

  it("shows partials only for the open turn, in sequence, and clears them at the final", async () => {
    const bridge = fakeBridge();
    const agent = residentAgent();
    const voice = createNativeLiveVoice({
      port: bridge.port,
      available: () => true,
      resident: agent.resident,
    });
    const out = handlers();
    const capture = await voice.open(out.open(new AbortController().signal));
    const id = bridge.captureId;
    agent.partial("other-capture", "t1", "elsewhere", 1);
    agent.speechStart(id, "t1");
    agent.partial(id, "t1", "hel", 1);
    agent.partial(id, "t1", "stale", 1);
    agent.partial(id, "t2", "next turn", 1);
    agent.partial(id, "t1", "hello", 2);
    expect(out.interim).toEqual(["hel", "hello"]);
    bridge.emit("liveCaptureFrames", {
      captureId: id,
      vad: [
        { type: "speech-start", timestampMs: 1 },
        { type: "speech-end", timestampMs: 2 },
      ],
    });
    bridge.emit("liveCaptureTranscript", {
      captureId: id,
      final: { turnId: "t1", text: "hello there", mode: "stream" },
    });
    // Partials after the final of their turn are dropped.
    agent.partial(id, "t1", "late", 3);
    expect(out.interim).toEqual(["hel", "hello", ""]);
    expect(out.latencies[0]).toMatchObject({ partials: 2 });
    await capture.cancel();
  });

  it("reports a capture that ended with an error as lost and discards it", async () => {
    const bridge = fakeBridge();
    const agent = residentAgent();
    const voice = createNativeLiveVoice({
      port: bridge.port,
      available: () => true,
      resident: agent.resident,
    });
    const out = handlers();
    await voice.open(out.open(new AbortController().signal));
    const id = bridge.captureId;
    bridge.emit("liveCaptureEnded", { captureId: "stale", error: "x" });
    expect(out.lost).toEqual([]);
    bridge.emit("liveCaptureEnded", { captureId: id, error: "call-active" });
    expect(out.lost).toHaveLength(1);
    expect(out.lost[0]).toMatchObject({
      message: "The microphone stopped.",
      code: "capture",
      reason: "call-active",
    });
    await flush();
    expect(bridge.stops).toEqual([
      expect.objectContaining({ captureId: id, discard: true }),
    ]);
    // Nothing after loss reaches the host.
    bridge.emit("liveCaptureTranscript", {
      captureId: id,
      final: { turnId: "t9", text: "late", mode: "stream" },
    });
    expect(out.segments).toEqual([]);
    expect(out.lost).toHaveLength(1);
  });

  it("fences events once the owner's session changes", async () => {
    const bridge = fakeBridge();
    const agent = residentAgent();
    const voice = createNativeLiveVoice({
      port: bridge.port,
      available: () => true,
      resident: agent.resident,
    });
    const out = handlers();
    await voice.open(out.open(new AbortController().signal));
    const id = bridge.captureId;
    const previous = agent.resident();
    agent.set(previous ? { ...previous, ownerId: "owner-2" } : null);
    bridge.emit("liveCaptureFrames", {
      captureId: id,
      peak: 0.5,
      vad: [{ type: "speech-start", timestampMs: 1 }],
    });
    expect(out.levels).toEqual([]);
    expect(out.lost).toHaveLength(1);
    expect(out.lost[0]).toMatchObject({ status: 409 });
    await flush();
    expect(bridge.stops[0]).toMatchObject({ discard: true });
  });

  it("aborts during start with a discard and never publishes the capture", async () => {
    let release!: () => void;
    const bridge = fakeBridge({
      startDelay: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const agent = residentAgent();
    const voice = createNativeLiveVoice({
      port: bridge.port,
      available: () => true,
      resident: agent.resident,
    });
    const out = handlers();
    const controller = new AbortController();
    const opening = voice.open(out.open(controller.signal));
    await flush();
    controller.abort();
    release();
    await expect(opening).rejects.toThrow();
    expect(bridge.stops[0]).toMatchObject({ discard: true });
    expect(bridge.listening).toBe(0);
    expect(out.lost).toEqual([]);
  });

  it("an abort after start discards the open turn and its late final", async () => {
    const bridge = fakeBridge();
    const agent = residentAgent();
    const voice = createNativeLiveVoice({
      port: bridge.port,
      available: () => true,
      resident: agent.resident,
    });
    const out = handlers();
    const controller = new AbortController();
    await voice.open(out.open(controller.signal));
    const id = bridge.captureId;
    bridge.emit("liveCaptureFrames", {
      captureId: id,
      vad: [
        { type: "speech-start", timestampMs: 1 },
        { type: "speech-end", timestampMs: 2 },
      ],
    });
    controller.abort();
    bridge.emit("liveCaptureTranscript", {
      captureId: id,
      final: { turnId: "t1", text: "late", mode: "stream" },
    });
    await flush();
    expect(out.segments).toEqual([]);
    expect(bridge.stops).toEqual([
      expect.objectContaining({ captureId: id, discard: true }),
    ]);
  });

  it("close requires the agent to acknowledge the server-side close", async () => {
    const bridge = fakeBridge({ serverClosed: false });
    const out = handlers();
    const capture = await openNativeResidentCapture(bridge.port, {
      ...out.open(new AbortController().signal),
      ownerId: "owner-1",
      current: () => true,
    });
    await expect(capture.close()).rejects.toThrow(/not confirmed/);
  });

  it("close ends an open segment at the cutoff and fills unanswered segments with null", async () => {
    const bridge = fakeBridge();
    const out = handlers();
    const capture = await openNativeResidentCapture(bridge.port, {
      ...out.open(new AbortController().signal),
      ownerId: "owner-1",
      current: () => true,
    });
    const id = bridge.captureId;
    bridge.emit("liveCaptureFrames", {
      captureId: id,
      vad: [{ type: "speech-start", timestampMs: 5 }],
    });
    // An edge stamped after the cutoff is ignored once the cutoff applies.
    const closing = capture.close(10);
    bridge.emit("liveCaptureFrames", {
      captureId: id,
      vad: [{ type: "speech-start", timestampMs: 20 }],
    });
    await closing;
    expect(out.edges).toEqual(["start:5", "end:10"]);
    expect(out.segments).toEqual([null]);
  });

  it("refuses a bridge that did not route natively", async () => {
    const bridge = fakeBridge();
    bridge.port.startLiveCapture = async (input) => ({
      captureId: input.captureId,
      sampleRate: 16000,
      nativeAsr: false,
    });
    const out = handlers();
    await expect(
      openNativeResidentCapture(bridge.port, {
        ...out.open(new AbortController().signal),
        ownerId: "owner-1",
        current: () => true,
      }),
    ).rejects.toThrow(/binding changed/);
    expect(bridge.stops[0]).toMatchObject({ discard: true });
  });
});

describe("renderer transport and readiness", () => {
  it("posts frames through the owner's live route on a bridge without native routing", async () => {
    const bridge = fakeBridge({ nativeTransport: false, echoCancelled: false });
    const agent = residentAgent();
    const voice = createNativeLiveVoice({
      port: bridge.port,
      available: () => true,
      resident: agent.resident,
      endedTimeoutMs: 5,
    });
    const out = handlers();
    const capture = await voice.open(out.open(new AbortController().signal));
    expect(bridge.starts[0]).not.toHaveProperty("nativeAsr");
    expect(capture.echoCancelled).toBe(false);
    const id = bridge.captureId;
    const frame = {
      pcm16: "AAAA",
      sampleRate: 16000,
      channels: 1,
      samples: 2,
      timestamp: 1,
    };
    bridge.emit("liveCaptureFrames", {
      captureId: "stale",
      frames: [frame],
      vad: [],
    });
    bridge.emit("liveCaptureFrames", {
      captureId: id,
      frames: [frame, { pcm16: 5 }],
      vad: [{ type: "speech-start", timestampMs: 1 }],
    });
    bridge.emit("liveCaptureFrames", {
      captureId: id,
      frames: [{ ...frame, timestamp: 2 }],
      vad: [{ type: "speech-end", timestampMs: 3 }],
    });
    await flush();
    const posts = agent.requests.filter((r) => r.path === LIVE_ASR_PATH);
    expect(posts.length).toBeGreaterThan(0);
    const frames = posts.flatMap(
      (r) => (r.body as { frames?: unknown[] }).frames ?? [],
    );
    expect(frames).toHaveLength(2);
    expect(out.segments).toEqual(["posted"]);
    const closing = capture.close();
    bridge.emit("liveCaptureEnded", { captureId: id });
    await closing;
    expect(bridge.stops).toEqual([{ captureId: id }]);
    expect(bridge.listening).toBe(0);
  });

  it("refuses requests once the resident session changed", async () => {
    const agent = residentAgent();
    const transport = residentLiveTransport(agent.resident);
    if (!transport) throw Error("expected a transport");
    const previous = agent.resident();
    agent.set(previous ? { ...previous, sessionId: "session-2" } : null);
    await expect(
      transport.post({}, new AbortController().signal),
    ).rejects.toMatchObject({ status: 409 });
    expect(residentLiveTransport(() => null)).toBeNull();
  });

  it("is ready only with the bridge, a resident agent, VAD capture and a streaming loader", async () => {
    const signal = new AbortController().signal;
    const agent = residentAgent();
    const ready = (
      bridge: ReturnType<typeof fakeBridge>,
      available = true,
      resident = agent.resident,
    ) =>
      createNativeLiveVoice({
        port: bridge.port,
        available: () => available,
        resident,
      }).ready(signal);
    expect(await ready(fakeBridge())).toBe(true);
    expect(await ready(fakeBridge(), false)).toBe(false);
    expect(await ready(fakeBridge(), true, () => null)).toBe(false);
    expect(await ready(fakeBridge({ available: false }))).toBe(false);
    expect(
      await createNativeLiveVoice({
        port: fakeBridge().port,
        available: () => true,
        resident: residentAgent(false).resident,
      }).ready(signal),
    ).toBe(false);
  });

  it("refuses to open without the bridge or an owner", async () => {
    const out = handlers();
    const signal = new AbortController().signal;
    await expect(
      createNativeLiveVoice({
        port: fakeBridge().port,
        available: () => false,
        resident: residentAgent().resident,
      }).open(out.open(signal)),
    ).rejects.toThrow(/unavailable/);
    const agent = residentAgent();
    const previous = agent.resident();
    agent.set(previous ? { ...previous, ownerId: undefined } : null);
    await expect(
      createNativeLiveVoice({
        port: fakeBridge().port,
        available: () => true,
        resident: agent.resident,
      }).open(out.open(signal)),
    ).rejects.toThrow(/not connected/);
  });
});

describe("native voice-turn latency sink", () => {
  it("forwards stage names and the bound turn id only", async () => {
    const markVoiceTurn = vi.fn(async () => ({
      marked: true,
      voiceTurnId: "n1",
    }));
    const sink = nativeVoiceStageSink({
      markVoiceTurn,
      nativeVoiceTiming: async () => null,
    });
    expect(await sink("asr-final")).toBe("n1");
    expect(await sink("request", "n1")).toBe("n1");
    expect(markVoiceTurn.mock.calls).toEqual([
      [{ stage: "asr-final" }],
      [{ stage: "request", voiceTurnId: "n1" }],
    ]);
    const unbound = nativeVoiceStageSink({
      markVoiceTurn: async () => ({ marked: false }),
      nativeVoiceTiming: async () => null,
    });
    expect(await unbound("first-token")).toBeUndefined();
  });

  it("reads the timing export, or null on failure or timeout", async () => {
    const port = (timing: () => Promise<unknown>) => ({
      markVoiceTurn: async () => null,
      nativeVoiceTiming: timing,
    });
    expect(await readNativeVoiceTiming(port(async () => ({ v: 3 })))).toEqual({
      v: 3,
    });
    expect(
      await readNativeVoiceTiming(port(async () => Promise.reject(Error("x")))),
    ).toBeNull();
    expect(
      await readNativeVoiceTiming(
        port(() => new Promise(() => {})),
        5,
      ),
    ).toBeNull();
  });
});

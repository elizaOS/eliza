/**
 * PendantConnection drives an injected PendantTransport through the connect
 * sequence and the transport-agnostic audio pipeline. We inject a fake transport
 * (so no real BLE) and mock the decoder + ASR so the pipeline is deterministic.
 *
 * This proves the transport abstraction is clean: the SAME connection logic
 * works for Web Bluetooth and native BLE — only the injected transport differs.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { OMI_CODEC, type OmiCodecId } from "./omi-protocol";
import type {
  PendantAudioListener,
  PendantBatteryListener,
  PendantTransport,
} from "./pendant-transport";
import { PendantUserCancelledError } from "./pendant-transport";

const asrControl = vi.hoisted(() => ({
  mode: "immediate" as "immediate" | "deferred" | "reject",
  calls: 0,
  resolvers: [] as Array<
    (value: {
      text: string;
      words: { text: string; startMs: number; endMs: number }[];
    }) => void
  >,
}));

// The pipeline downstream of the transport is exercised elsewhere; here we only
// need it to not touch real wasm/network. Mock the decoder + ASR + capture.
vi.mock("./opus-frame-decoder", () => ({
  createPendantAudioDecoder: vi.fn(async () => ({
    ready: Promise.resolve(),
    // Each frame decodes to 200ms of PCM so word timing normalization has a
    // realistic segment duration to preserve.
    decodeFrame: (frame: Uint8Array) =>
      new Float32Array(3_200).fill(frame.length / 255),
    free: vi.fn(),
  })),
}));

vi.mock("../voice/local-asr-transcribe", () => ({
  transcribeLocalInferenceWav: vi.fn(async () => {
    asrControl.calls += 1;
    if (asrControl.mode === "reject") {
      throw new Error("ASR route unavailable");
    }
    if (asrControl.mode === "deferred") {
      return new Promise((resolve) => {
        asrControl.resolvers.push(resolve);
      });
    }
    return {
      text: "hello world",
      words: [
        { text: "hello", startMs: 0, endMs: 80 },
        { text: "world", startMs: 90, endMs: 120 },
      ],
    };
  }),
}));

// Keep the real capture module for VAD, but force it to segment on demand via a
// controllable detector. Simplest: mock the auto-stop detector + silence guard.
let forceStop = false;
let detectorCalls = 0;
let silentAudio = false;
vi.mock("../voice/local-asr-capture", () => ({
  createLocalAsrAutoStopDetector: () => () => {
    detectorCalls += 1;
    return {
      shouldBuffer: true,
      shouldStop: forceStop,
    };
  },
  encodeMonoPcm16Wav: () => new Uint8Array([1, 2, 3]),
  isSilentPcmAudio: () => silentAudio,
}));

// Force selection to a null transport by default so the injected factory is the
// only source (the connection uses createTransport override in these tests).
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

import { PendantConnection, type PendantState } from "./pendant-connection";
import type { PendantTranscriptSegmentDetail } from "./transcript-segment-event";

/** A fully controllable fake transport implementing the interface. */
class FakeTransport implements PendantTransport {
  readonly kind: PendantTransport["kind"];
  audioListener: PendantAudioListener | null = null;
  batteryListener: PendantBatteryListener | null = null;
  disconnectedHandler: (() => void) | null = null;
  disconnectCalls = 0;

  constructor(
    private readonly opts: {
      kind?: PendantTransport["kind"];
      deviceName?: string | null;
      codec?: OmiCodecId;
      battery?: number | null;
      requestThrows?: unknown;
      startAudioThrows?: unknown;
    } = {},
  ) {
    this.kind = opts.kind ?? "web-bluetooth";
  }

  async requestAndConnect(): Promise<{ deviceName: string | null }> {
    if (this.opts.requestThrows !== undefined) throw this.opts.requestThrows;
    return { deviceName: this.opts.deviceName ?? "omi pendant" };
  }
  async readCodec(): Promise<OmiCodecId> {
    return this.opts.codec ?? OMI_CODEC.OPUS_16K;
  }
  async startAudio(listener: PendantAudioListener): Promise<void> {
    if (this.opts.startAudioThrows !== undefined)
      throw this.opts.startAudioThrows;
    this.audioListener = listener;
  }
  async startBattery(listener: PendantBatteryListener): Promise<number | null> {
    this.batteryListener = listener;
    return this.opts.battery ?? null;
  }
  onDisconnected(handler: () => void): void {
    this.disconnectedHandler = handler;
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
}

function collectStates(): {
  onState: (s: PendantState) => void;
  states: PendantState[];
} {
  const states: PendantState[] = [];
  return { onState: (s) => states.push({ ...s }), states };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function emitStoppedUtterance(
  transport: FakeTransport,
  firstSequence: number,
): void {
  forceStop = false;
  transport.audioListener?.(new Uint8Array([firstSequence & 0xff, 0, 0, 42]));
  forceStop = true;
  transport.audioListener?.(
    new Uint8Array([(firstSequence + 1) & 0xff, 0, 0, 43]),
  );
}

afterEach(() => {
  forceStop = false;
  detectorCalls = 0;
  silentAudio = false;
  asrControl.mode = "immediate";
  asrControl.calls = 0;
  asrControl.resolvers = [];
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("PendantConnection connect orchestration", () => {
  it("connects through an injected transport and lands in listening", async () => {
    const transport = new FakeTransport({
      deviceName: "Friend-xy",
      battery: 64,
    });
    const { onState, states } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
    });

    await conn.connect();

    const final = conn.getState();
    expect(final.status).toBe("listening");
    expect(final.deviceName).toBe("Friend-xy");
    expect(final.batteryPercent).toBe(64);
    expect(final.codecId).toBe(OMI_CODEC.OPUS_16K);
    // The connect trace passed through the named steps.
    const steps = states.map((s) => s.connectStep);
    expect(steps).toContain("gatt-connect");
    expect(steps).toContain("codec-read");
    expect(steps).toContain("start-notifications");
    expect(steps).toContain("done");
  });

  it("uses selectPendantTransport by default (null → unsupported)", async () => {
    // No Web Bluetooth in jsdom + capacitor mocked to web → selection is null.
    const { onState } = collectStates();
    const conn = new PendantConnection({ onState });
    await conn.connect();
    expect(conn.getState().status).toBe("unsupported");
  });

  it("treats a cancelled chooser as idle, not error", async () => {
    const transport = new FakeTransport({
      requestThrows: new PendantUserCancelledError(),
    });
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
    });
    await conn.connect();
    expect(conn.getState().status).toBe("idle");
    expect(conn.getState().error).toBeNull();
  });

  it("surfaces a real connect failure as error and tears down", async () => {
    const transport = new FakeTransport({
      startAudioThrows: new Error("boom"),
    });
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
    });
    await conn.connect();
    expect(conn.getState().status).toBe("error");
    expect(conn.getState().error).toBe("Pendant connection failed: boom");
    expect(conn.getState().typedError?.code).toBe("connection");
    expect(transport.disconnectCalls).toBeGreaterThan(0);
  });

  it("classifies permission denial separately from generic connect errors", async () => {
    const transport = new FakeTransport({
      requestThrows: new DOMException("denied", "NotAllowedError"),
    });
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
    });
    await conn.connect();

    expect(conn.getState().status).toBe("error");
    expect(conn.getState().typedError?.code).toBe("permission-denied");
    expect(conn.getState().typedError?.category).toBe("permission");
    expect(conn.getState().error).toContain("Nearby Devices permission is off");
  });

  it("runs one canonical commit: resolved segment before VOICE_DM, exactly once", async () => {
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const transcripts: string[] = [];
    const segments: PendantTranscriptSegmentDetail[] = [];
    const eventOrder: string[] = [];
    const voiceListener = vi.fn(() => eventOrder.push("voice"));
    window.addEventListener("eliza:pendant:voice-transcript", voiceListener);
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      onTranscript: (t) => {
        eventOrder.push("callback");
        transcripts.push(t);
      },
      onSegment: (detail) => {
        eventOrder.push(detail.status);
        segments.push(detail);
      },
    });
    try {
      await conn.connect();
      expect(transport.audioListener).toBeTruthy();

      emitStoppedUtterance(transport, 0);
      await flushMicrotasks();

      expect(transcripts).toEqual(["hello world"]);
      expect(voiceListener).toHaveBeenCalledTimes(1);
      expect(conn.getState().lastTranscript).toBe("hello world");
      expect(segments.map((segment) => segment.status)).toEqual([
        "pending",
        "resolved",
      ]);
      expect(eventOrder).toEqual(["pending", "resolved", "voice", "callback"]);
      expect(segments[1]?.text).toBe("hello world");
      expect(segments[1]?.words).toEqual([
        { text: "hello", startMs: 0, endMs: 80 },
        { text: "world", startMs: 90, endMs: 120 },
      ]);
      expect(segments[1]?.durationMs).toBeGreaterThan(0);
    } finally {
      window.removeEventListener(
        "eliza:pendant:voice-transcript",
        voiceListener,
      );
    }
  });

  it("emits each pending segment before waiting behind prior ASR work", async () => {
    asrControl.mode = "deferred";
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const segments: PendantTranscriptSegmentDetail[] = [];
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      onSegment: (detail) => segments.push(detail),
    });
    await conn.connect();

    emitStoppedUtterance(transport, 0);
    await flushMicrotasks();
    expect(asrControl.calls).toBe(1);

    emitStoppedUtterance(transport, 2);

    expect(segments.map((segment) => segment.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(segments[0]?.id).not.toBe(segments[1]?.id);
    expect(asrControl.calls).toBe(1);

    asrControl.resolvers.shift()?.({
      text: "first",
      words: [{ text: "first", startMs: 0, endMs: 80 }],
    });
    await flushMicrotasks();
    expect(asrControl.calls).toBe(2);
    asrControl.resolvers.shift()?.({
      text: "second",
      words: [{ text: "second", startMs: 0, endMs: 80 }],
    });
    await flushMicrotasks();

    expect(segments.map((segment) => segment.status)).toEqual([
      "pending",
      "pending",
      "resolved",
      "resolved",
    ]);
    expect(segments[2]?.id).toBe(segments[0]?.id);
    expect(segments[3]?.id).toBe(segments[1]?.id);
  });

  it("transitions a near-silent utterance from pending to dropped", async () => {
    silentAudio = true;
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const segments: PendantTranscriptSegmentDetail[] = [];
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      onSegment: (detail) => segments.push(detail),
    });
    await conn.connect();

    emitStoppedUtterance(transport, 0);
    await flushMicrotasks();

    expect(asrControl.calls).toBe(0);
    expect(segments.map((segment) => segment.status)).toEqual([
      "pending",
      "discarded",
    ]);
    expect(segments[1]?.id).toBe(segments[0]?.id);
    expect(segments[1]?.discardReason).toBe("silence");
  });

  it("drops ASR failures with a visible warning, keeps listening, and clears it on success", async () => {
    asrControl.mode = "reject";
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const transcripts: string[] = [];
    const segments: PendantTranscriptSegmentDetail[] = [];
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      onTranscript: (text) => transcripts.push(text),
      onSegment: (detail) => segments.push(detail),
    });
    await conn.connect();

    emitStoppedUtterance(transport, 0);
    await flushMicrotasks();

    expect(transcripts).toEqual([]);
    expect(segments.map((segment) => segment.status)).toEqual([
      "pending",
      "failed",
    ]);
    expect(segments[1]?.id).toBe(segments[0]?.id);
    expect(segments[1]?.failureReason).toBe("asr-failed");
    expect(segments[1]?.warning).toBe("Could not transcribe this segment.");
    expect(conn.getState().status).toBe("listening");
    expect(conn.getState().paused).toBe(false);
    expect(conn.getState().typedError?.code).toBe("asr-failed");
    expect(conn.getState().error).toBe("Could not transcribe this segment.");

    asrControl.mode = "immediate";
    emitStoppedUtterance(transport, 2);
    await flushMicrotasks();

    expect(transcripts).toEqual(["hello world"]);
    expect(segments.map((segment) => segment.status)).toEqual([
      "pending",
      "failed",
      "pending",
      "resolved",
    ]);
    expect(conn.getState().status).toBe("listening");
    expect(conn.getState().error).toBeNull();
  });

  it("includes wall-clock timing in segment ids so new connections do not collide", async () => {
    const now = vi.spyOn(Date, "now");
    const firstTransport = new FakeTransport({});
    const secondTransport = new FakeTransport({});
    const firstSegments: PendantTranscriptSegmentDetail[] = [];
    const secondSegments: PendantTranscriptSegmentDetail[] = [];

    now.mockReturnValue(10_000);
    const first = new PendantConnection({
      onState: collectStates().onState,
      createTransport: () => firstTransport,
      onSegment: (detail) => firstSegments.push(detail),
    });
    await first.connect();
    emitStoppedUtterance(firstTransport, 0);
    await flushMicrotasks();

    now.mockReturnValue(20_000);
    const second = new PendantConnection({
      onState: collectStates().onState,
      createTransport: () => secondTransport,
      onSegment: (detail) => secondSegments.push(detail),
    });
    await second.connect();
    emitStoppedUtterance(secondTransport, 0);
    await flushMicrotasks();

    expect(firstSegments[0]?.id).toContain("10000");
    expect(secondSegments[0]?.id).toContain("20000");
    expect(firstSegments[0]?.id).not.toBe(secondSegments[0]?.id);
    now.mockRestore();
  });

  it("pauses before VAD while leaving BLE battery updates live", async () => {
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
    });
    await conn.connect();

    conn.pause();
    expect(conn.getState().status).toBe("paused");
    expect(conn.getState().paused).toBe(true);
    const callsBeforeAudio = detectorCalls;

    transport.audioListener?.(new Uint8Array([0, 0, 0, 42]));
    transport.batteryListener?.(77);

    expect(detectorCalls).toBe(callsBeforeAudio);
    expect(conn.getState().batteryPercent).toBe(77);

    conn.resume();
    expect(conn.getState().status).toBe("listening");
    expect(conn.getState().paused).toBe(false);
  });

  it("does not emit a frame buffered before or during pause into VAD after resume", async () => {
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
    });
    await conn.connect();

    transport.audioListener?.(new Uint8Array([0, 0, 0, 42]));
    conn.pause();
    transport.audioListener?.(new Uint8Array([1, 0, 0, 43]));
    const callsBeforeResume = detectorCalls;

    conn.resume();
    transport.audioListener?.(new Uint8Array([2, 0, 0, 44]));

    expect(detectorCalls).toBe(callsBeforeResume);
    expect(conn.getState().status).toBe("listening");
  });

  it("reconnects once after a native remote disconnect and preserves the session state", async () => {
    vi.useFakeTimers();
    const firstTransport = new FakeTransport({ kind: "native-ble" });
    const secondTransport = new FakeTransport({
      kind: "native-ble",
      deviceName: "omi return",
    });
    const { onState } = collectStates();
    const transports = [firstTransport, secondTransport];
    const conn = new PendantConnection({
      onState,
      createTransport: () => transports.shift() ?? null,
      reconnectDelayMs: 10,
    });
    await conn.connect();
    expect(conn.getState().status).toBe("listening");

    firstTransport.disconnectedHandler?.();
    expect(conn.getState().status).toBe("reconnecting");
    expect(conn.getState().typedError?.code).toBe("pendant-lost");

    await vi.advanceTimersByTimeAsync(10);

    expect(conn.getState().status).toBe("listening");
    expect(conn.getState().deviceName).toBe("omi return");
    expect(conn.getState().typedError).toBeNull();
  });

  it("exhausts bounded native reconnect attempts into typed pendant-lost state", async () => {
    vi.useFakeTimers();
    const firstTransport = new FakeTransport({ kind: "native-ble" });
    const { onState } = collectStates();
    let factoryCalls = 0;
    const conn = new PendantConnection({
      onState,
      createTransport: () => {
        factoryCalls += 1;
        return factoryCalls === 1
          ? firstTransport
          : new FakeTransport({
              kind: "native-ble",
              startAudioThrows: new Error("still gone"),
            });
      },
      reconnectDelayMs: 5,
      reconnectMaxAttempts: 2,
    });
    await conn.connect();
    firstTransport.disconnectedHandler?.();

    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(5);

    expect(conn.getState().status).toBe("error");
    expect(conn.getState().typedError?.code).toBe("reconnect-exhausted");
  });

  it("does not timer-reconnect web bluetooth after a remote disconnect", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport({ kind: "web-bluetooth" });
    const { onState } = collectStates();
    let factoryCalls = 0;
    const conn = new PendantConnection({
      onState,
      createTransport: () => {
        factoryCalls += 1;
        return transport;
      },
      reconnectDelayMs: 5,
    });
    await conn.connect();

    transport.disconnectedHandler?.();
    await vi.advanceTimersByTimeAsync(20);

    expect(factoryCalls).toBe(1);
    expect(conn.getState().status).toBe("error");
    expect(conn.getState().typedError?.code).toBe("pendant-lost");
    expect(conn.getState().typedError?.recoverable).toBe(true);
    expect(conn.getState().paused).toBe(false);
  });

  it("does not pause while native reconnect is pending", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport({ kind: "native-ble" });
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      reconnectDelayMs: 50,
    });
    await conn.connect();

    transport.disconnectedHandler?.();
    conn.pause();

    expect(conn.getState().status).toBe("reconnecting");
    expect(conn.getState().paused).toBe(false);
  });

  it("does not reconnect after an intentional disconnect", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      reconnectDelayMs: 5,
    });
    await conn.connect();

    await conn.disconnect();
    transport.disconnectedHandler?.();
    await vi.advanceTimersByTimeAsync(20);

    expect(conn.getState().status).toBe("idle");
    expect(conn.getState().typedError).toBeNull();
  });

  it("explicit disconnect tears the transport down and resets state", async () => {
    const transport = new FakeTransport({ battery: 50 });
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
    });
    await conn.connect();
    await conn.disconnect();
    expect(transport.disconnectCalls).toBeGreaterThan(0);
    expect(conn.getState().status).toBe("idle");
    expect(conn.getState().batteryPercent).toBeNull();
  });
});

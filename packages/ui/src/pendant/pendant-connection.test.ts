/**
 * PendantConnection drives an injected PendantTransport through the connect
 * sequence and the transport-agnostic audio pipeline. We inject a fake transport
 * (so no real BLE) and mock the decoder + ASR so the pipeline is deterministic.
 *
 * This proves the transport abstraction is clean: the SAME connection logic
 * works for Web Bluetooth and native BLE — only the injected transport differs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { OMI_CODEC, type OmiCodecId } from "./omi-protocol";
import type {
  PendantAudioListener,
  PendantBatteryListener,
  PendantTransport,
} from "./pendant-transport";
import { PendantUserCancelledError } from "./pendant-transport";

// The pipeline downstream of the transport is exercised elsewhere; here we only
// need it to not touch real wasm/network. Mock the decoder + ASR + capture.
vi.mock("./opus-frame-decoder", () => ({
  createPendantAudioDecoder: vi.fn(async () => ({
    ready: Promise.resolve(),
    // Each frame decodes to one PCM sample so we can observe delivery.
    decodeFrame: (frame: Uint8Array) => new Float32Array([frame.length / 255]),
    free: vi.fn(),
  })),
}));

vi.mock("../voice/local-asr-transcribe", () => ({
  transcribeLocalInferenceWav: vi.fn(async () => ({ text: "hello world" })),
}));

// Keep the real capture module for VAD, but force it to segment on demand via a
// controllable detector. Simplest: mock the auto-stop detector + silence guard.
let forceStop = false;
vi.mock("../voice/local-asr-capture", () => ({
  createLocalAsrAutoStopDetector: () => () => ({
    shouldBuffer: true,
    shouldStop: forceStop,
  }),
  encodeMonoPcm16Wav: () => new Uint8Array([1, 2, 3]),
  isSilentPcmAudio: () => false,
}));

// Force selection to a null transport by default so the injected factory is the
// only source (the connection uses createTransport override in these tests).
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

import { transcribeLocalInferenceWav } from "../voice/local-asr-transcribe";
import { PendantConnection, type PendantState } from "./pendant-connection";
import type {
  PendantLatencyMark,
  PendantLatencyMetric,
} from "./performance/pendant-latency";

/** A fully controllable fake transport implementing the interface. */
class FakeTransport implements PendantTransport {
  readonly kind = "web-bluetooth" as const;
  audioListener: PendantAudioListener | null = null;
  batteryListener: PendantBatteryListener | null = null;
  disconnectedHandler: (() => void) | null = null;
  disconnectCalls = 0;

  constructor(
    private readonly opts: {
      deviceName?: string | null;
      codec?: OmiCodecId;
      codecPromise?: Promise<OmiCodecId>;
      battery?: number | null;
      requestThrows?: unknown;
      startAudioThrows?: unknown;
      startAudioPromise?: Promise<void>;
      notifyOnDisconnect?: boolean;
    } = {},
  ) {}

  async requestAndConnect(): Promise<{ deviceName: string | null }> {
    if (this.opts.requestThrows !== undefined) throw this.opts.requestThrows;
    return { deviceName: this.opts.deviceName ?? "omi pendant" };
  }
  async readCodec(): Promise<OmiCodecId> {
    return this.opts.codecPromise ?? this.opts.codec ?? OMI_CODEC.OPUS_16K;
  }
  async startAudio(listener: PendantAudioListener): Promise<void> {
    if (this.opts.startAudioThrows !== undefined)
      throw this.opts.startAudioThrows;
    this.audioListener = listener;
    await this.opts.startAudioPromise;
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
    if (this.opts.notifyOnDisconnect) this.disconnectedHandler?.();
  }
}

function collectStates(): {
  onState: (s: PendantState) => void;
  states: PendantState[];
} {
  const states: PendantState[] = [];
  return { onState: (s) => states.push({ ...s }), states };
}

afterEach(() => {
  forceStop = false;
  vi.clearAllMocks();
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
    expect(conn.getState().error).toBe("boom");
    expect(transport.disconnectCalls).toBeGreaterThan(0);
  });

  it("runs the audio pipeline: notification → transcript dispatched", async () => {
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const transcripts: string[] = [];
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      onTranscript: (t) => transcripts.push(t),
    });
    await conn.connect();
    expect(transport.audioListener).toBeTruthy();

    // Feed a frame that buffers, then a frame that stops → finalize → ASR.
    forceStop = false;
    // 4-byte-headed notification: header (3) + 1 payload byte → one frame.
    transport.audioListener?.(new Uint8Array([0, 0, 0, 42]));
    forceStop = true;
    transport.audioListener?.(new Uint8Array([1, 0, 0, 43]));

    // Let the finalizing chain flush.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(transcripts).toEqual(["hello world"]);
    expect(conn.getState().lastTranscript).toBe("hello world");
  });

  it("emits privacy-safe latency marks for the audio pipeline", async () => {
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const marks: PendantLatencyMark[] = [];
    const metrics: PendantLatencyMetric[] = [];
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      latencySink: {
        mark: (mark) => marks.push(mark),
        metric: (metric) => metrics.push(metric),
      },
      latencyClock: (() => {
        let now = 0;
        return () => {
          now += 1;
          return now;
        };
      })(),
    });
    await conn.connect();

    forceStop = false;
    transport.audioListener?.(new Uint8Array([0, 0, 0, 42]));
    forceStop = true;
    transport.audioListener?.(new Uint8Array([1, 0, 0, 43]));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(marks.map((mark) => mark.name)).toEqual(
      expect.arrayContaining([
        "ble.notification",
        "reassembly.frame",
        "decode.start",
        "decode.end",
        "vad.speech",
        "vad.pending",
        "wav.encode.start",
        "wav.encode.end",
        "asr.request",
        "asr.resolve",
        "segment.dispatch",
      ]),
    );
    expect(JSON.stringify(marks)).not.toContain("hello world");
    expect(
      metrics.find((metric) => metric.name === "ble_to_reassembly_ms")?.valueMs,
    ).toBe(2);
  });

  it("a remote disconnect returns to idle, tears down, and can reconnect", async () => {
    const first = new FakeTransport({ notifyOnDisconnect: true });
    const second = new FakeTransport({});
    const transports = [first, second];
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transports.shift() ?? null,
    });
    await conn.connect();
    expect(conn.getState().status).toBe("listening");

    first.disconnectedHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conn.getState().status).toBe("idle");
    expect(first.disconnectCalls).toBeGreaterThan(0);

    await conn.connect();
    expect(conn.getState().status).toBe("listening");
    expect(second.audioListener).toBeTruthy();
  });

  it("settles idle and can reconnect when disconnected during bring-up", async () => {
    let resolveCodec: ((codec: OmiCodecId) => void) | undefined;
    const first = new FakeTransport({
      codecPromise: new Promise((resolve) => {
        resolveCodec = resolve;
      }),
    });
    const second = new FakeTransport({});
    const transports = [first, second];
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transports.shift() ?? null,
    });

    const connecting = conn.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conn.getState().status).toBe("connecting");
    await conn.disconnect();
    resolveCodec?.(OMI_CODEC.OPUS_16K);
    await connecting;

    expect(conn.getState().status).toBe("idle");
    await conn.connect();
    expect(conn.getState().status).toBe("listening");
  });

  it("treats an in-flight BLE rejection after disconnect as cancellation", async () => {
    let rejectCodec: ((error: Error) => void) | undefined;
    const first = new FakeTransport({
      codecPromise: new Promise((_resolve, reject) => {
        rejectCodec = reject;
      }),
    });
    const second = new FakeTransport({});
    const transports = [first, second];
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transports.shift() ?? null,
    });

    const connecting = conn.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await conn.disconnect();
    rejectCodec?.(new Error("link closed"));
    await connecting;

    expect(conn.getState().status).toBe("idle");
    await conn.connect();
    expect(conn.getState().status).toBe("listening");
  });

  it("allows a remote reconnect while the cancelled bring-up unwinds", async () => {
    let resolveCodec: ((codec: OmiCodecId) => void) | undefined;
    const first = new FakeTransport({
      codecPromise: new Promise((resolve) => {
        resolveCodec = resolve;
      }),
    });
    const second = new FakeTransport({});
    const transports = [first, second];
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transports.shift() ?? null,
    });

    const oldConnect = conn.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.disconnectedHandler?.();
    const reconnect = conn.connect();
    resolveCodec?.(OMI_CODEC.OPUS_16K);
    await Promise.all([oldConnect, reconnect]);

    expect(conn.getState().status).toBe("listening");
    expect(second.audioListener).toBeTruthy();
    expect(first.disconnectCalls).toBeGreaterThan(0);
  });

  it("isolates late notifications from a timed-out first attempt", async () => {
    const neverStarts = new Promise<void>(() => {
      // Settled by the step timeout, not this underlying transport promise.
    });
    const first = new FakeTransport({ startAudioPromise: neverStarts });
    const second = new FakeTransport({});
    const transports = [first, second];
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transports.shift() ?? null,
      stepTimeoutMs: 5,
    });

    await conn.connect();
    expect(conn.getState().status).toBe("listening");
    expect(second.audioListener).toBeTruthy();
    forceStop = false;
    first.audioListener?.(new Uint8Array([0, 0, 0, 42]));
    forceStop = true;
    first.audioListener?.(new Uint8Array([1, 0, 0, 43]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(conn.getState().lastTranscript).toBeNull();
  });

  it("drops stale notifications while cancelled audio setup unwinds", async () => {
    let resolveStartAudio: (() => void) | undefined;
    const transport = new FakeTransport({
      startAudioPromise: new Promise((resolve) => {
        resolveStartAudio = resolve;
      }),
    });
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
    });

    const connecting = conn.connect();
    while (!transport.audioListener) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await conn.disconnect();
    forceStop = false;
    transport.audioListener(new Uint8Array([0, 0, 0, 42]));
    forceStop = true;
    transport.audioListener(new Uint8Array([1, 0, 0, 43]));
    resolveStartAudio?.();
    await connecting;

    expect(conn.getState().status).toBe("idle");
    expect(conn.getState().lastTranscript).toBeNull();
  });

  it("aborts in-flight ASR and suppresses late transcripts on disconnect", async () => {
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const transcripts: string[] = [];
    let resolveAsr: ((result: { text: string; words: [] }) => void) | undefined;
    let abortObserved = false;
    vi.mocked(transcribeLocalInferenceWav).mockImplementationOnce(
      (_wav, options) =>
        new Promise((resolve) => {
          resolveAsr = resolve;
          options?.signal?.addEventListener("abort", () => {
            abortObserved = true;
          });
        }),
    );
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      onTranscript: (text) => transcripts.push(text),
    });
    await conn.connect();

    forceStop = false;
    transport.audioListener?.(new Uint8Array([0, 0, 0, 42]));
    forceStop = true;
    transport.audioListener?.(new Uint8Array([1, 0, 0, 43]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveAsr).toBeTypeOf("function");

    await conn.disconnect();
    expect(abortObserved).toBe(true);
    resolveAsr?.({ text: "too late", words: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transcripts).toEqual([]);
    expect(conn.getState().lastTranscript).toBeNull();
    expect(conn.getState().status).toBe("idle");
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

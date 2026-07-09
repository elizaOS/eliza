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

import {
  PendantConnection,
  type PendantState,
} from "./pendant-connection";

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
      battery?: number | null;
      requestThrows?: unknown;
      startAudioThrows?: unknown;
    } = {},
  ) {}

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

  it("a remote disconnect returns to idle and releases the decoder", async () => {
    const transport = new FakeTransport({});
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
    });
    await conn.connect();
    expect(conn.getState().status).toBe("listening");

    transport.disconnectedHandler?.();
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

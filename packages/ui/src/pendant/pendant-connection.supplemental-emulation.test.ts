/**
 * Supplemental emulation, not physical proof: PendantConnection is exercised
 * with deterministic injected transports and mocked decoder/ASR boundaries.
 * These tests do not prove LP3 Bluetooth, Web Bluetooth chooser behavior, or a
 * physical pendant; they only harden recovery paths around the real class.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { OMI_CODEC, type OmiCodecId } from "./omi-protocol";
import type {
  PendantAudioListener,
  PendantBatteryListener,
  PendantTransport,
} from "./pendant-transport";
import { PendantUserCancelledError } from "./pendant-transport";

const transcribeMock = vi.hoisted(() => vi.fn());
const freedDecoders = vi.hoisted(() => [] as ReturnType<typeof vi.fn>[]);

vi.mock("./opus-frame-decoder", () => ({
  createPendantAudioDecoder: vi.fn(async () => {
    const free = vi.fn();
    freedDecoders.push(free);
    return {
      ready: Promise.resolve(),
      decodeFrame: (frame: Uint8Array) =>
        new Float32Array([frame.length / 255]),
      free,
    };
  }),
}));

vi.mock("../voice/local-asr-transcribe", () => ({
  transcribeLocalInferenceWav: transcribeMock,
}));

let forceStop = false;
vi.mock("../voice/local-asr-capture", () => ({
  createLocalAsrAutoStopDetector: () => () => ({
    shouldBuffer: true,
    shouldStop: forceStop,
  }),
  encodeMonoPcm16Wav: () => new Uint8Array([1, 2, 3]),
  isSilentPcmAudio: () => false,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

import { PendantConnection, type PendantState } from "./pendant-connection";

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
  onState: (state: PendantState) => void;
  states: PendantState[];
} {
  const states: PendantState[] = [];
  return { onState: (state) => states.push({ ...state }), states };
}

async function flushFinalizers() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  forceStop = false;
  transcribeMock.mockReset();
  freedDecoders.length = 0;
});

describe("PendantConnection supplemental emulation", () => {
  it("SUPPLEMENTAL EMULATION, NOT PHYSICAL PROOF: permission/user-denied connect result returns to idle", async () => {
    const { onState } = collectStates();
    const transport = new FakeTransport({
      requestThrows: new PendantUserCancelledError(),
    });
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
    });

    await conn.connect();

    expect(conn.getState().status).toBe("idle");
    expect(conn.getState().error).toBeNull();
    expect(transport.disconnectCalls).toBeGreaterThan(0);
  });

  it("SUPPLEMENTAL EMULATION, NOT PHYSICAL PROOF: disconnect then reconnect uses a fresh transport", async () => {
    const first = new FakeTransport({ deviceName: "first pendant" });
    const second = new FakeTransport({ deviceName: "second pendant" });
    const transports = [first, second];
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transports.shift() ?? null,
    });

    await conn.connect();
    expect(conn.getState().deviceName).toBe("first pendant");
    await conn.disconnect();
    await conn.connect();

    expect(first.disconnectCalls).toBeGreaterThan(0);
    expect(conn.getState().status).toBe("listening");
    expect(conn.getState().deviceName).toBe("second pendant");
  });

  it("SUPPLEMENTAL EMULATION, NOT PHYSICAL PROOF: ASR failure returns to listening without transcript", async () => {
    transcribeMock.mockRejectedValueOnce(new Error("asr failed"));
    const transport = new FakeTransport();
    const { onState } = collectStates();
    const transcripts: string[] = [];
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
    await flushFinalizers();

    expect(transcripts).toEqual([]);
    expect(conn.getState().lastTranscript).toBeNull();
    expect(conn.getState().status).toBe("listening");
  });

  it("SUPPLEMENTAL EMULATION, NOT PHYSICAL PROOF: teardown/reconstruction simulates refresh recovery", async () => {
    const first = new FakeTransport({ deviceName: "before refresh" });
    const second = new FakeTransport({ deviceName: "after refresh" });
    const firstStates = collectStates();
    const firstConn = new PendantConnection({
      onState: firstStates.onState,
      createTransport: () => first,
    });
    await firstConn.connect();
    await firstConn.disconnect();

    const secondStates = collectStates();
    const secondConn = new PendantConnection({
      onState: secondStates.onState,
      createTransport: () => second,
    });
    await secondConn.connect();

    expect(first.disconnectCalls).toBeGreaterThan(0);
    expect(freedDecoders.length).toBeGreaterThanOrEqual(2);
    expect(secondConn.getState().status).toBe("listening");
    expect(secondConn.getState().deviceName).toBe("after refresh");
  });
});

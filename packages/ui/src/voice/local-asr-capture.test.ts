/**
 * Unit coverage for local-ASR capture helpers: WAV encoding, silence detection,
 * audio measurement (pure functions over PCM buffers, no mic), plus the
 * recorder-start failure path driven through a fake browser audio stack.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalAsrAutoStopDetector,
  DEFAULT_LOCAL_ASR_AUTO_STOP,
  decodeMonoPcm16Wav,
  encodeMonoPcm16Wav,
  isSilentPcmAudio,
  isSilentWav,
  measurePcmAudio,
  queryMicrophonePermission,
  startLocalAsrRecorder,
} from "./local-asr-capture";

type FakeAudioProcessEvent = {
  inputBuffer: {
    length: number;
    numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
  };
};

type FakeAudioProcessHandler = (event: FakeAudioProcessEvent) => void;

class FakeAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeScriptProcessor extends FakeAudioNode {
  onaudioprocess: FakeAudioProcessHandler | null = null;
}

class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 0;
  smoothingTimeConstant = 0;
}

class RecorderFakeAudioContext {
  readonly sampleRate: number;
  state: AudioContextState = "running";
  destination = {};
  processor = new FakeScriptProcessor();
  close = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn(() => new FakeAudioNode());
  createScriptProcessor = vi.fn(() => this.processor);
  createAnalyser = vi.fn(() => new FakeAnalyserNode());

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }
}

async function createFakeRecorder(
  sampleRate: number,
  options: Parameters<typeof startLocalAsrRecorder>[0] = {
    autoStop: {
      startGraceMs: 0,
      minSpeechMs: 0,
      silenceMs: 10_000,
      speechRmsThreshold: 0.5,
      speechPeakThreshold: 0.5,
    },
  },
) {
  const trackStop = vi.fn();
  const stream = {
    getTracks: () => [{ stop: trackStop }],
    getAudioTracks: () => [{ stop: trackStop }],
  } as unknown as MediaStream;
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

  let context: RecorderFakeAudioContext | null = null;
  class FakeAudioContext extends RecorderFakeAudioContext {
    constructor() {
      super(sampleRate);
      context = this;
    }
  }
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });

  const recorder = await startLocalAsrRecorder(options);
  const createdContext = context as RecorderFakeAudioContext | null;
  if (!createdContext) throw new Error("fake AudioContext was not created");
  return { recorder, context: createdContext, trackStop };
}

function emitMonoFrame(
  context: RecorderFakeAudioContext,
  samples: Float32Array,
): void {
  const handler = context.processor.onaudioprocess;
  if (!handler) throw new Error("recorder process handler was not installed");
  handler({
    inputBuffer: {
      length: samples.length,
      numberOfChannels: 1,
      getChannelData: () => samples,
    },
  });
}

function constantFrame(length: number, value: number): Float32Array {
  const frame = new Float32Array(length);
  frame.fill(value);
  return frame;
}

function expectSamplesClose(
  samples: Float32Array,
  start: number,
  length: number,
  value: number,
): void {
  for (let index = start; index < start + length; index += 1) {
    expect(samples[index]).toBeCloseTo(value, 3);
  }
}

describe("local ASR capture", () => {
  it("detects truly silent PCM before sending it to ASR", () => {
    const pcm = new Float32Array(16000);

    expect(measurePcmAudio(pcm)).toEqual({ rms: 0, peak: 0 });
    expect(isSilentPcmAudio(pcm)).toBe(true);
  });

  it("keeps low but real microphone signal eligible for ASR", () => {
    const pcm = new Float32Array(16000);
    pcm[1200] = 0.001;
    pcm[1201] = -0.001;

    expect(measurePcmAudio(pcm).peak).toBeCloseTo(0.001);
    expect(isSilentPcmAudio(pcm)).toBe(false);
  });

  it("encodes mono PCM16 WAV with the requested sample rate", () => {
    const wav = encodeMonoPcm16Wav(new Float32Array([0, 1, -1]), 16000);
    const view = new DataView(wav.buffer);

    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(6);
  });

  it("ignores startup audio and stops after speech followed by silence", () => {
    const detect = createLocalAsrAutoStopDetector(
      {
        startGraceMs: 100,
        minSpeechMs: 100,
        silenceMs: 200,
        speechPeakThreshold: 0.01,
      },
      0,
    );
    if (!detect) throw new Error("auto-stop detector was not created");

    const speech = new Float32Array([0.02, -0.02, 0.015]);
    const silence = new Float32Array([0, 0, 0]);

    expect(detect(speech, 50)).toEqual({
      shouldBuffer: false,
      shouldStop: false,
    });
    expect(detect(speech, 120)).toEqual({
      shouldBuffer: true,
      shouldStop: false,
    });
    expect(detect(speech, 260)).toEqual({
      shouldBuffer: true,
      shouldStop: false,
    });
    expect(detect(silence, 520)).toEqual({
      shouldBuffer: false,
      shouldStop: true,
    });
  });

  it("suppresses quiet echo while the TTS echo gate is active (#12256 layer 1)", () => {
    // Gate always on: the 4x multiplier lifts the RMS bar 0.003→0.012 and the
    // peak bar 0.012→0.048. The echo below (rms ~0.0077, peak 0.008) is above
    // the DEFAULT bar (would be heard) but below the raised gate → suppressed.
    const detect = createLocalAsrAutoStopDetector(
      { startGraceMs: 0, isTtsEchoGateActive: () => true },
      0,
    );
    if (!detect) throw new Error("auto-stop detector was not created");
    const quietEcho = new Float32Array([0.008, -0.008, 0.007]);
    expect(detect(quietEcho, 100)).toEqual({
      shouldBuffer: false,
      shouldStop: false,
    });
  });

  it("still hears a loud barge-in through the active echo gate", () => {
    const detect = createLocalAsrAutoStopDetector(
      { startGraceMs: 0, isTtsEchoGateActive: () => true },
      0,
    );
    if (!detect) throw new Error("auto-stop detector was not created");
    // A loud, close interjection (0.2 peak) clears even the raised 0.048 bar.
    const loudInterjection = new Float32Array([0.2, -0.22, 0.19]);
    expect(detect(loudInterjection, 100)).toEqual({
      shouldBuffer: true,
      shouldStop: false,
    });
  });

  it("returns to the normal bar once the gate is inactive", () => {
    const detect = createLocalAsrAutoStopDetector(
      { startGraceMs: 0, isTtsEchoGateActive: () => false },
      0,
    );
    if (!detect) throw new Error("auto-stop detector was not created");
    // Same quiet echo, gate off → now above the default 0.003 RMS bar.
    const quiet = new Float32Array([0.008, -0.008, 0.007]);
    expect(detect(quiet, 100)).toEqual({
      shouldBuffer: true,
      shouldStop: false,
    });
  });
});

describe("startLocalAsrRecorder auto-stop pre-roll", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prepends only the newest bounded 200ms of 16k PCM when speech starts", async () => {
    const { recorder, context } = await createFakeRecorder(16_000);

    emitMonoFrame(context, constantFrame(1000, 0.01));
    emitMonoFrame(context, constantFrame(1000, 0.02));
    emitMonoFrame(context, constantFrame(1000, 0.03));
    emitMonoFrame(context, constantFrame(1000, 0.04));
    emitMonoFrame(context, constantFrame(1000, 0.05));
    emitMonoFrame(context, new Float32Array([0.8, -0.8]));

    const pcm = decodeMonoPcm16Wav(await recorder.stop());

    expect(pcm.length).toBe(3202);
    expectSamplesClose(pcm, 0, 200, 0.02);
    expectSamplesClose(pcm, 200, 1000, 0.03);
    expectSamplesClose(pcm, 1200, 1000, 0.04);
    expectSamplesClose(pcm, 2200, 1000, 0.05);
    expect(pcm[3200]).toBeCloseTo(0.8, 3);
    expect(pcm[3201]).toBeCloseTo(-0.8, 3);
  });

  it("prepends only the newest bounded 200ms of 48k PCM in frame order", async () => {
    const { recorder, context } = await createFakeRecorder(48_000);

    emitMonoFrame(context, constantFrame(4096, 0.01));
    emitMonoFrame(context, constantFrame(4096, 0.02));
    emitMonoFrame(context, constantFrame(4096, 0.03));
    emitMonoFrame(context, new Float32Array([0.7]));

    const pcm = decodeMonoPcm16Wav(await recorder.stop());

    expect(pcm.length).toBe(9601);
    expectSamplesClose(pcm, 0, 1408, 0.01);
    expectSamplesClose(pcm, 1408, 4096, 0.02);
    expectSamplesClose(pcm, 5504, 4096, 0.03);
    expect(pcm[9600]).toBeCloseTo(0.7, 3);
  });

  it("prepends the pre-roll once, then buffers later speech normally", async () => {
    const { recorder, context } = await createFakeRecorder(16_000);

    emitMonoFrame(context, constantFrame(600, 0.02));
    emitMonoFrame(context, constantFrame(600, 0.03));
    emitMonoFrame(context, new Float32Array([0.75]));
    emitMonoFrame(context, new Float32Array([0.65]));

    const pcm = decodeMonoPcm16Wav(await recorder.stop());

    expect(pcm.length).toBe(1202);
    expectSamplesClose(pcm, 0, 600, 0.02);
    expectSamplesClose(pcm, 600, 600, 0.03);
    expect(pcm[1200]).toBeCloseTo(0.75, 3);
    expect(pcm[1201]).toBeCloseTo(0.65, 3);
  });

  it("does not promote no-speech pre-roll into a stopped capture", async () => {
    const { recorder, context } = await createFakeRecorder(16_000);

    emitMonoFrame(context, constantFrame(5000, 0.02));

    await expect(recorder.stop()).rejects.toThrow(
      "No microphone audio was captured for local ASR",
    );
  });

  it("clears pending pre-roll on cancel so later frames cannot leak into stop", async () => {
    const { recorder, context, trackStop } = await createFakeRecorder(16_000);

    emitMonoFrame(context, constantFrame(1000, 0.02));
    recorder.cancel();

    expect(context.processor.onaudioprocess).toBeNull();
    await expect(recorder.stop()).rejects.toThrow(
      "No microphone audio was captured for local ASR",
    );
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  it("clears buffered PCM on stop and ignores frames after teardown", async () => {
    const { recorder, context } = await createFakeRecorder(16_000);

    emitMonoFrame(context, constantFrame(100, 0.02));
    emitMonoFrame(context, new Float32Array([0.8]));

    const firstPcm = decodeMonoPcm16Wav(await recorder.stop());

    expect(firstPcm.length).toBe(101);
    expect(context.processor.onaudioprocess).toBeNull();
    await expect(recorder.stop()).rejects.toThrow(
      "No microphone audio was captured for local ASR",
    );
  });

  it("leaves non-auto-stop captures buffering every frame unchanged", async () => {
    const { recorder, context } = await createFakeRecorder(16_000, {});

    emitMonoFrame(context, constantFrame(2, 0.01));
    emitMonoFrame(context, new Float32Array([0.8]));

    const pcm = decodeMonoPcm16Wav(await recorder.stop());

    expect(pcm.length).toBe(3);
    expectSamplesClose(pcm, 0, 2, 0.01);
    expect(pcm[2]).toBeCloseTo(0.8, 3);
  });
});

describe("startLocalAsrRecorder resume failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects and releases the mic when the AudioContext cannot resume", async () => {
    // A suspended context that never resumes records pure silence; a swallowed
    // resume failure would make that look like a healthy (dead) session.
    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const contextClose = vi.fn().mockResolvedValue(undefined);
    class FakeAudioContext {
      state = "suspended";
      resume = vi.fn().mockRejectedValue(new Error("autoplay policy"));
      close = contextClose;
    }
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });

    await expect(startLocalAsrRecorder()).rejects.toThrow(
      "AudioContext could not resume for local ASR capture",
    );
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(contextClose).toHaveBeenCalledTimes(1);
  });

  it("rejects when resume() RESOLVES but state stays suspended (#voice-crickets iOS quirk)", async () => {
    // WebKit quirk: after the getUserMedia permission dialog interrupts the
    // gesture, `resume()` can resolve while `state` is still "suspended" — the
    // graph never actually runs, so PCM is all zeros and the WAV reads silent
    // (crickets). A single await isn't proof; the retry loop re-checks state and
    // must reject (surface error → not silent crickets) if it never flips.
    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const contextClose = vi.fn().mockResolvedValue(undefined);
    const resume = vi.fn().mockResolvedValue(undefined);
    class StuckSuspendedContext {
      state = "suspended"; // never flips to "running"
      resume = resume;
      close = contextClose;
    }
    vi.stubGlobal("window", { AudioContext: StuckSuspendedContext });

    await expect(startLocalAsrRecorder()).rejects.toThrow(
      "AudioContext could not resume for local ASR capture",
    );
    // Retried before giving up (more than one resume attempt).
    expect(resume.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Mic + context released on the failed start (no lingering capture indicator).
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(contextClose).toHaveBeenCalledTimes(1);
  });

  it("succeeds when a suspended context flips to running on a retry (#voice-crickets recovery)", async () => {
    // The dialog dismissed and the queued resume lands a beat later: the second
    // state read is "running", so capture proceeds instead of falsely rejecting.
    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    let resumeCalls = 0;
    const fakeNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      fftSize: 0,
      smoothingTimeConstant: 0,
    };
    class RecoveringContext {
      state = "suspended";
      sampleRate = 16000;
      resume = vi.fn().mockImplementation(async () => {
        resumeCalls += 1;
        // Flip to running only on the SECOND resume — the first resolves while
        // still suspended (the iOS quirk), the retry lands it.
        if (resumeCalls >= 2) this.state = "running";
      });
      close = vi.fn().mockResolvedValue(undefined);
      createMediaStreamSource = vi.fn().mockReturnValue(fakeNode);
      createScriptProcessor = vi.fn().mockReturnValue({
        ...fakeNode,
        onaudioprocess: null,
      });
      createAnalyser = vi.fn().mockReturnValue({ ...fakeNode });
      destination = {};
    }
    vi.stubGlobal("window", { AudioContext: RecoveringContext });

    const recorder = await startLocalAsrRecorder();
    expect(recorder).toBeTruthy();
    expect(resumeCalls).toBeGreaterThanOrEqual(2);
    // Mic NOT released — the capture is live.
    expect(trackStop).not.toHaveBeenCalled();
  });
});

describe("decodeMonoPcm16Wav / isSilentWav (#voice-V5 silence guard)", () => {
  it("round-trips PCM16 WAV encode → decode within quantization error", () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 0.999, -0.999]);
    const wav = encodeMonoPcm16Wav(pcm, 16000);
    const decoded = decodeMonoPcm16Wav(wav);

    expect(decoded.length).toBe(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      // 16-bit quantization: max error ~1/32768.
      expect(decoded[i]).toBeCloseTo(pcm[i] ?? 0, 3);
    }
  });

  it("reads a near-silent capture as silent (no cloud round-trip)", () => {
    // A few tiny frames below the 0.0005 peak floor: a captured-but-silent tap.
    const pcm = new Float32Array(1600);
    pcm[10] = 0.0002;
    pcm[11] = -0.0002;
    const wav = encodeMonoPcm16Wav(pcm, 16000);

    expect(isSilentPcmAudio(pcm)).toBe(true);
    expect(isSilentWav(wav)).toBe(true);
  });

  it("reads a WAV carrying real speech as non-silent (POST proceeds)", () => {
    const pcm = new Float32Array(1600);
    pcm[800] = 0.4;
    pcm[801] = -0.35;
    const wav = encodeMonoPcm16Wav(pcm, 16000);

    expect(isSilentWav(wav)).toBe(false);
  });

  it("treats an undecodable / non-WAV body as silent (safe default)", () => {
    // Not a RIFF header → empty PCM → silent (don't burn a round-trip on junk).
    const notWav = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(decodeMonoPcm16Wav(notWav)).toHaveLength(0);
    expect(isSilentWav(notWav)).toBe(true);
  });

  it("locates the data chunk even when other sub-chunks precede it", () => {
    // Hand-build RIFF/WAVE with a bogus 4-byte 'LIST' chunk before 'data'.
    const pcmBytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0]); // two int16 samples
    const listPayload = new Uint8Array([9, 9, 9, 9]);
    const total = 12 + (8 + listPayload.length) + (8 + pcmBytes.length);
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const ascii = (o: number, s: string) => {
      for (let i = 0; i < s.length; i += 1)
        view.setUint8(o + i, s.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, total - 8, true);
    ascii(8, "WAVE");
    let o = 12;
    ascii(o, "LIST");
    view.setUint32(o + 4, listPayload.length, true);
    u8.set(listPayload, o + 8);
    o += 8 + listPayload.length;
    ascii(o, "data");
    view.setUint32(o + 4, pcmBytes.length, true);
    u8.set(pcmBytes, o + 8);

    const decoded = decodeMonoPcm16Wav(u8);
    expect(decoded.length).toBe(2);
    // 0x4000 = 16384 → ~0.5, 0xC000 = -16384 → ~-0.5.
    expect(decoded[0]).toBeCloseTo(0.5, 2);
    expect(decoded[1]).toBeCloseTo(-0.5, 2);
  });
});

describe("DEFAULT_LOCAL_ASR_AUTO_STOP silence window (#voice-V6)", () => {
  it("defaults the trailing-silence window to the snappier 650ms", () => {
    expect(DEFAULT_LOCAL_ASR_AUTO_STOP.silenceMs).toBe(650);
  });
});

describe("queryMicrophonePermission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 'granted' when the Permissions API reports a live grant", async () => {
    const query = vi.fn().mockResolvedValue({ state: "granted" });
    vi.stubGlobal("navigator", { permissions: { query } });

    await expect(queryMicrophonePermission()).resolves.toBe("granted");
    expect(query).toHaveBeenCalledWith({ name: "microphone" });
  });

  it("surfaces a revoked grant as 'denied' so the re-enable affordance shows", async () => {
    const query = vi.fn().mockResolvedValue({ state: "denied" });
    vi.stubGlobal("navigator", { permissions: { query } });

    await expect(queryMicrophonePermission()).resolves.toBe("denied");
  });

  it("passes 'prompt' through so getUserMedia is allowed to re-prompt", async () => {
    const query = vi.fn().mockResolvedValue({ state: "prompt" });
    vi.stubGlobal("navigator", { permissions: { query } });

    await expect(queryMicrophonePermission()).resolves.toBe("prompt");
  });

  it("returns 'unknown' (never throws) when the descriptor is unsupported", async () => {
    // Safari/older iOS reject the `"microphone"` descriptor; the probe must
    // degrade to "unknown" so callers proceed normally instead of blocking.
    const query = vi.fn().mockRejectedValue(new TypeError("unsupported name"));
    vi.stubGlobal("navigator", { permissions: { query } });

    await expect(queryMicrophonePermission()).resolves.toBe("unknown");
  });

  it("returns 'unknown' when the Permissions API is entirely absent", async () => {
    vi.stubGlobal("navigator", {});

    await expect(queryMicrophonePermission()).resolves.toBe("unknown");
  });

  it("maps an unrecognized permission state to 'unknown'", async () => {
    const query = vi.fn().mockResolvedValue({ state: "weird-future-state" });
    vi.stubGlobal("navigator", { permissions: { query } });

    await expect(queryMicrophonePermission()).resolves.toBe("unknown");
  });
});

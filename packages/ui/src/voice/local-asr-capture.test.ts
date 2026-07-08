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

describe("startLocalAsrRecorder chunked-streaming segmenter (voice V2a)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Stand up a fake browser audio stack that lets us drive onaudioprocess with
  // synthetic frames and capture the emitted segments.
  function fakeAudioStack() {
    const trackStop = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    let onProcess: ((event: unknown) => void) | null = null;
    const processor = {
      set onaudioprocess(fn: ((event: unknown) => void) | null) {
        onProcess = fn;
      },
      get onaudioprocess() {
        return onProcess;
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    class FakeAudioContext {
      state = "running";
      sampleRate = 16000;
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
      createScriptProcessor = vi.fn(() => processor);
      createAnalyser = vi.fn(() => ({
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      destination = {};
    }
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      setTimeout: (fn: () => void) => setTimeout(fn, 0),
    });
    return {
      drive: (frame: Float32Array) => {
        onProcess?.({
          inputBuffer: {
            length: frame.length,
            numberOfChannels: 1,
            getChannelData: () => frame,
          },
        });
      },
    };
  }

  it("emits mid-capture segments on boundaries and a final on stop", async () => {
    const stack = fakeAudioStack();
    const segments: { seq: number; isFinal: boolean; bytes: number }[] = [];
    // A segmenter stub that cuts a boundary on every 3rd frame (deterministic).
    let n = 0;
    const recorder = await startLocalAsrRecorder({
      segmenter: {
        update: () => {
          n += 1;
          return { boundary: n % 3 === 0, speech: true };
        },
        config: { overlapMs: 0 },
      },
      onSegment: (s) =>
        segments.push({ seq: s.seq, isFinal: s.isFinal, bytes: s.wav.length }),
    });

    // 6 loud frames → boundaries after frame 3 and frame 6 → 2 mid segments.
    const loud = new Float32Array(320).fill(0.3);
    for (let i = 0; i < 6; i += 1) stack.drive(loud);
    expect(segments.filter((s) => !s.isFinal)).toHaveLength(2);
    expect(segments.map((s) => s.seq)).toEqual([0, 1]);

    await recorder.stop();
    // The stop() flush emits the terminal segment (seq 2, isFinal).
    const finals = segments.filter((s) => s.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.seq).toBe(2);
  });

  it("drops a silent mid-segment without consuming a seq", async () => {
    const stack = fakeAudioStack();
    const segments: { seq: number; isFinal: boolean }[] = [];
    let n = 0;
    const recorder = await startLocalAsrRecorder({
      segmenter: {
        update: () => {
          n += 1;
          return { boundary: n % 2 === 0, speech: true };
        },
        config: { overlapMs: 0 },
      },
      onSegment: (s) => segments.push({ seq: s.seq, isFinal: s.isFinal }),
    });

    const silent = new Float32Array(320).fill(0);
    // Boundary on frame 2 over silence → dropped, no seq consumed.
    stack.drive(silent);
    stack.drive(silent);
    expect(segments).toHaveLength(0);

    // Now a real segment: boundary on frame 4 over speech → seq 0.
    const loud = new Float32Array(320).fill(0.3);
    stack.drive(loud);
    stack.drive(loud);
    expect(segments).toEqual([{ seq: 0, isFinal: false }]);

    await recorder.stop();
  });

  it("emits a header-only final marker when the trailing tail is silent", async () => {
    const stack = fakeAudioStack();
    const segments: { seq: number; isFinal: boolean; bytes: number }[] = [];
    const recorder = await startLocalAsrRecorder({
      segmenter: {
        update: () => ({ boundary: false, speech: false }),
        config: { overlapMs: 0 },
      },
      onSegment: (s) =>
        segments.push({ seq: s.seq, isFinal: s.isFinal, bytes: s.wav.length }),
    });

    // Feed only silence into the (never-cut) pending segment. On stop() the tail
    // is silent, so the final marker is emitted as a header-only WAV (44 bytes)
    // — the sink recognizes this and finalizes the stitcher without a POST.
    const silent = new Float32Array(320).fill(0);
    stack.drive(silent);
    stack.drive(silent);
    await recorder.stop();
    const finals = segments.filter((s) => s.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.bytes).toBe(44); // RIFF header only, no PCM data
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

import { describe, expect, it } from "vitest";
import {
  createVoiceActivityDetector,
  DEFAULT_VOICE_ACTIVITY,
  type VoiceActivityDetector,
} from "./voice-activity";

const FRAME_MS = 50;
const LOUD = { peak: 0.5, rms: 0.1 };
const QUIET = { peak: 0, rms: 0 };

function feed(
  detector: VoiceActivityDetector,
  stats: typeof LOUD,
  fromMs: number,
  durationMs: number,
): { stoppedAtMs: number | null; nextMs: number } {
  let t = fromMs;
  for (; t < fromMs + durationMs; t += FRAME_MS) {
    if (detector(stats, t).shouldStop) return { stoppedAtMs: t, nextMs: t };
  }
  return { stoppedAtMs: null, nextMs: t };
}

function detector(): VoiceActivityDetector {
  return createVoiceActivityDetector({}, 0, () => 0);
}

describe("createVoiceActivityDetector", () => {
  const { startGraceMs, minSpeechMs, silenceMs, maxSpeechMs } =
    DEFAULT_VOICE_ACTIVITY;

  it("ignores a sub-minSpeech blip before real speech", () => {
    const vad = detector();
    let r = feed(vad, LOUD, startGraceMs, FRAME_MS);
    expect(r.stoppedAtMs).toBeNull();
    r = feed(vad, QUIET, r.nextMs, 13_000);
    expect(r.stoppedAtMs).toBeNull();
    expect(vad.hasSpeech).toBe(false);

    const speechStart = r.nextMs;
    r = feed(vad, LOUD, speechStart, 1_000);
    expect(r.stoppedAtMs).toBeNull();
    r = feed(vad, QUIET, r.nextMs, silenceMs + FRAME_MS);
    expect(r.stoppedAtMs).not.toBeNull();
    const lastLoudMs = speechStart + 1_000 - FRAME_MS;
    expect(r.stoppedAtMs ?? 0).toBeGreaterThanOrEqual(lastLoudMs + silenceMs);
  });

  it("stops after speech of at least minSpeechMs and a silence window", () => {
    const vad = detector();
    let r = feed(vad, LOUD, startGraceMs, minSpeechMs + FRAME_MS);
    expect(r.stoppedAtMs).toBeNull();
    expect(vad.hasSpeech).toBe(true);
    r = feed(vad, QUIET, r.nextMs, silenceMs + FRAME_MS);
    expect(r.stoppedAtMs).not.toBeNull();
  });

  it("stops continuous speech at maxSpeechMs", () => {
    const vad = detector();
    const r = feed(vad, LOUD, startGraceMs, maxSpeechMs + 1_000);
    expect(r.stoppedAtMs).toBe(startGraceMs + maxSpeechMs);
  });

  it("reports no speech after a reset blip", () => {
    const vad = detector();
    let r = feed(vad, LOUD, startGraceMs, FRAME_MS);
    r = feed(vad, QUIET, r.nextMs, silenceMs + FRAME_MS);
    expect(vad.hasSpeech).toBe(false);
    // The blip is forgotten: later silence is no longer buffered as a turn.
    expect(vad(QUIET, r.nextMs).shouldBuffer).toBe(false);
  });
});

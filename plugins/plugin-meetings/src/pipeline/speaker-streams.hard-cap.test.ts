/**
 * With cloud ASR the transcriber answers only final windows; interim windows
 * come back empty, so nothing is confirmed while a speaker keeps talking.
 * When the speaker's buffer passes the 30 s hard cap, that speech must be
 * transcribed, not discarded. Real SpeakerStreamManager on a test clock; the
 * ASR backend is a scripted stand-in.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpeakerStreamManager } from "./speaker-streams";

const SAMPLE_RATE = 16_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("transcribes a speaker's first 30 s instead of dropping them at the hard cap", async () => {
  let clock = 0;
  const streams = new SpeakerStreamManager({ now: () => clock });
  const transcribedSec: number[] = [];
  const emitted: string[] = [];
  streams.onSegmentReady = (key, _name, audio, purpose, generation) => {
    const seconds = audio.length / SAMPLE_RATE;
    // Cloud ASR: interim windows are not transcribed.
    const text = purpose === "final" ? `speech ${seconds.toFixed(0)}s` : "";
    if (text) transcribedSec.push(seconds);
    queueMicrotask(() =>
      streams.handleTranscriptionResult(
        key,
        text,
        undefined,
        undefined,
        generation,
      ),
    );
  };
  streams.onSegmentConfirmed = (event) => emitted.push(event.text);
  streams.addSpeaker("alice", "Alice");

  // 41 s of continuous speech, then silence until the idle flush.
  for (let second = 0; second < 41; second++) {
    streams.feedAudio("alice", new Float32Array(SAMPLE_RATE).fill(0.1));
    clock += 1000;
    await vi.advanceTimersByTimeAsync(1000);
  }
  for (let second = 0; second < 20; second++) {
    clock += 1000;
    await vi.advanceTimersByTimeAsync(1000);
  }
  streams.removeAll();

  const total = transcribedSec.reduce((sum, seconds) => sum + seconds, 0);
  expect(emitted.length).toBeGreaterThan(1);
  expect(total).toBe(41);
});

it("keeps the hard-cap transcription when the speaker changes while it is in flight", async () => {
  let clock = 0;
  const streams = new SpeakerStreamManager({ now: () => clock });
  const emitted: string[] = [];
  let pendingFinal: (() => void) | undefined;
  streams.onSegmentReady = (key, _name, audio, purpose, generation) => {
    if (purpose !== "final") {
      queueMicrotask(() =>
        streams.handleTranscriptionResult(
          key,
          "",
          undefined,
          undefined,
          generation,
        ),
      );
      return;
    }
    // Hold the cap submission's result until after the speaker change.
    pendingFinal = () =>
      streams.handleTranscriptionResult(
        key,
        `speech ${(audio.length / SAMPLE_RATE).toFixed(0)}s`,
        undefined,
        undefined,
        generation,
      );
  };
  streams.onSegmentConfirmed = (event) => emitted.push(event.text);
  streams.addSpeaker("alice", "Alice");

  for (let second = 0; second < 32 && !pendingFinal; second++) {
    streams.feedAudio("alice", new Float32Array(SAMPLE_RATE).fill(0.1));
    clock += 1000;
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(pendingFinal).toBeDefined();

  // Zoom/Teams speaker change while the cap transcription is in flight.
  await streams.flushSpeaker("alice");
  pendingFinal?.();
  streams.removeAll();

  expect(emitted.some((text) => /^speech 3\ds$/.test(text))).toBe(true);
});

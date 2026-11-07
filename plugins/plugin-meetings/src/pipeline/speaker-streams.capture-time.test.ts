/**
 * Teams holds audio until a caption names its speaker, then feeds the batch
 * late with each chunk's capture time. The speaker's window and its idle
 * timeout must run from when that speech was captured, not from when the
 * batch was fed. Real SpeakerStreamManager on a test clock; the ASR backend
 * is a scripted stand-in.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpeakerStreamManager } from "./speaker-streams";

/** page-capture.ts ScriptProcessor buffer: 4096 samples = 256 ms at 16 kHz. */
const CHUNK_SAMPLES = 4096;
const CHUNK_MS = 256;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("starts the window and the idle timeout of a late-fed batch at its capture time", async () => {
  let clock = 0;
  const streams = new SpeakerStreamManager({ now: () => clock });
  const finalSubmitsAtMs: number[] = [];
  const startsMs: number[] = [];
  streams.onSegmentReady = (key, _name, _audio, purpose, generation) => {
    if (purpose === "final") finalSubmitsAtMs.push(clock);
    queueMicrotask(() =>
      streams.handleTranscriptionResult(
        key,
        purpose === "final" ? "Good morning everyone" : "",
        undefined,
        undefined,
        generation,
      ),
    );
  };
  streams.onSegmentConfirmed = (event) => startsMs.push(event.startMs);
  streams.addSpeaker("alice", "Alice");

  const advance = async (ms: number) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  // One second of speech captured from 4.0 s, fed when the caption lands at
  // 5.5 s; then silence.
  await advance(5_500);
  for (let i = 0; i < 4; i++) {
    streams.feedAudio(
      "alice",
      new Float32Array(CHUNK_SAMPLES).fill(0.1),
      4_000 + i * CHUNK_MS,
    );
  }
  while (finalSubmitsAtMs.length === 0 && clock < 30_000) await advance(500);
  streams.removeAll();

  // The idle timeout (15 s) runs from the last chunk's capture at 4.768 s:
  // the 2 s submit tick at 20 s sends the final window, not the one at 22 s.
  expect({ finalSubmitsAtMs, startsMs }).toEqual({
    finalSubmitsAtMs: [20_000],
    startsMs: [4_000],
  });
});

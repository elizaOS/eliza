/**
 * A segment's end is where the speaker's audio ended, not when its
 * transcript came back. With cloud ASR the interim windows come back empty,
 * so a Google Meet utterance (Meet never flushes a speaker) is emitted by the
 * idle submit, more than 15 s after the speaker stopped. Real
 * SpeakerStreamManager on a test clock; the ASR backend is a scripted
 * stand-in.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type ConfirmedSegmentEvent,
  SpeakerStreamManager,
} from "./speaker-streams";

const SAMPLE_RATE = 16_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function cloudAsrStreams(clock: { ms: number }) {
  const streams = new SpeakerStreamManager({ now: () => clock.ms });
  const emitted: ConfirmedSegmentEvent[] = [];
  streams.onSegmentReady = (key, _name, _audio, purpose, generation) => {
    const text = purpose === "final" ? "Let's review the roadmap." : "";
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
  streams.onSegmentConfirmed = (event) => emitted.push(event);
  streams.addSpeaker("0", "Alice");
  return { streams, emitted };
}

async function speak(
  streams: SpeakerStreamManager,
  clock: { ms: number },
  seconds: number,
): Promise<void> {
  for (let s = 0; s < seconds; s++) {
    streams.feedAudio("0", new Float32Array(SAMPLE_RATE).fill(0.1));
    clock.ms += 1000;
    await vi.advanceTimersByTimeAsync(1000);
  }
}

async function wait(clock: { ms: number }, seconds: number): Promise<void> {
  for (let s = 0; s < seconds; s++) {
    clock.ms += 1000;
    await vi.advanceTimersByTimeAsync(1000);
  }
}

it("ends an idle-submitted utterance where its audio ends", async () => {
  const clock = { ms: 0 };
  const { streams, emitted } = cloudAsrStreams(clock);

  await speak(streams, clock, 4);
  // Capture forwards nothing while the speaker is quiet.
  await wait(clock, 20);
  streams.removeAll();

  expect(emitted.map((e) => [e.startMs, e.endMs])).toEqual([[0, 4000]]);
});

it("ends after the last audio when the speaker paused inside the window", async () => {
  const clock = { ms: 0 };
  const { streams, emitted } = cloudAsrStreams(clock);

  await speak(streams, clock, 2);
  // A 5 s pause, shorter than the idle timeout: capture drops the silence.
  await wait(clock, 5);
  await speak(streams, clock, 2);
  await wait(clock, 20);
  streams.removeAll();

  // 4 s of audio, but the last of it arrived at 8000 ms.
  expect(emitted.map((e) => [e.startMs, e.endMs])).toEqual([[0, 8000]]);
});

it("ends a full-text confirmation at its boundary while the speaker keeps talking", async () => {
  const clock = { ms: 0 };
  const streams = new SpeakerStreamManager({ now: () => clock.ms });
  const emitted: ConfirmedSegmentEvent[] = [];
  // A local ASR with word timings that hears the same words twice in a row
  // (the full-text confirmation), each answer landing 1 s after its window
  // went out while the speaker's audio keeps arriving.
  const answers: Array<[string, number, number]> = [
    ["First sentence.", 0.2, 1.5],
    ["First sentence.", 0.2, 1.5],
    ["Second sentence.", 0.5, 4],
    ["Second sentence.", 0.5, 4],
  ];
  streams.onSegmentReady = (key, _name, _audio, _purpose, generation) => {
    const answer = answers.shift();
    if (!answer) return;
    const [text, startSec, endSec] = answer;
    setTimeout(
      () =>
        streams.handleTranscriptionResult(
          key,
          text,
          endSec,
          [{ text, startSec, endSec }],
          generation,
        ),
      1000,
    );
  };
  streams.onSegmentConfirmed = (event) => emitted.push(event);
  streams.addSpeaker("0", "Alice");

  await speak(streams, clock, 6);
  await wait(clock, 3);
  streams.removeAll();

  // Each segment ends where its words end; the next starts there.
  expect(emitted.map((e) => [e.text, e.startMs, e.endMs])).toEqual([
    ["First sentence.", 0, 1500],
    ["Second sentence.", 1500, 5500],
  ]);
});

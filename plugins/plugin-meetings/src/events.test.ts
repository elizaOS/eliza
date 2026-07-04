/**
 * Transcript-fan-out throttling for MeetingEventEmitter (at most two events per
 * second per session, with a trailing flush). Deterministic — fake runtime and
 * fake timers.
 */
import type { MeetingTranscriptEvent } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingEventEmitter } from "./events.js";
import { makeFakeRuntime, segment } from "./test-support.js";

function transcriptEvent(
  sessionId: string,
  texts: string[],
): MeetingTranscriptEvent {
  return {
    type: "meeting-transcript",
    sessionId,
    transcriptId: "t-1",
    confirmed: texts.map((t, i) =>
      segment(`s-${t}`, "Jill", t, i * 100, i * 100 + 99),
    ),
    pending: [],
  };
}

describe("MeetingEventEmitter — transcript throttling (≤2/s per session)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst into one trailing event carrying all confirmed segments", async () => {
    const fake = makeFakeRuntime();
    const emitter = new MeetingEventEmitter(fake.runtime);

    emitter.emitTranscript(transcriptEvent("a", ["one"]));
    expect(fake.broadcasts).toHaveLength(1);

    // Burst within the 500ms window — queued + merged, not sent.
    emitter.emitTranscript(transcriptEvent("a", ["two"]));
    emitter.emitTranscript(transcriptEvent("a", ["three"]));
    expect(fake.broadcasts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(fake.broadcasts).toHaveLength(2);
    const merged = fake.broadcasts[1] as MeetingTranscriptEvent;
    expect(merged.confirmed.map((s) => s.text)).toEqual(["two", "three"]);
  });

  it("throttles per session, not globally", () => {
    const fake = makeFakeRuntime();
    const emitter = new MeetingEventEmitter(fake.runtime);
    emitter.emitTranscript(transcriptEvent("a", ["one"]));
    emitter.emitTranscript(transcriptEvent("b", ["uno"]));
    expect(fake.broadcasts).toHaveLength(2);
  });

  it("dispose flushes the queued event immediately", () => {
    const fake = makeFakeRuntime();
    const emitter = new MeetingEventEmitter(fake.runtime);
    emitter.emitTranscript(transcriptEvent("a", ["one"]));
    emitter.emitTranscript(transcriptEvent("a", ["two"]));
    expect(fake.broadcasts).toHaveLength(1);
    emitter.dispose("a");
    expect(fake.broadcasts).toHaveLength(2);
  });

  it("drops events silently when connector-setup is unavailable", () => {
    const fake = makeFakeRuntime();
    (fake.runtime as { getService: (n: string) => unknown }).getService = () =>
      null;
    const emitter = new MeetingEventEmitter(fake.runtime);
    emitter.emitStatus({
      id: "s",
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      nativeMeetingId: "abc-defg-hij",
      botName: "Bot",
      status: "requested",
      requestedAt: Date.now(),
      participants: [],
    });
    expect(fake.broadcasts).toHaveLength(0);
  });
});

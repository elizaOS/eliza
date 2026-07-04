import { describe, expect, it } from "vitest";
import type { MeetingAudioSink } from "../../../types.js";
import { TeamsCaptionRouter } from "../caption-router.js";

interface SinkCall {
  method: "push" | "setName" | "flush" | "joined" | "left";
  key: string;
  samples?: Float32Array;
}

function makeSink() {
  const calls: SinkCall[] = [];
  const sink: MeetingAudioSink = {
    pushSpeakerAudio: (key, samples) => calls.push({ method: "push", key, samples }),
    setSpeakerName: (key) => calls.push({ method: "setName", key }),
    flushSpeaker: (key) => calls.push({ method: "flush", key }),
    participantJoined: (p) => calls.push({ method: "joined", key: p.id }),
    participantLeft: (id) => calls.push({ method: "left", key: id }),
  };
  return { sink, calls };
}

function chunk(fill: number, length = 4): Float32Array {
  return new Float32Array(length).fill(fill);
}

function makeRouter(overrides: Partial<{ now: () => number }> = {}) {
  const { sink, calls } = makeSink();
  let t = 0;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const router = new TeamsCaptionRouter({
    sink,
    botName: "Eliza Bot",
    now: overrides.now ?? clock.now,
  });
  return { router, sink, calls, clock };
}

describe("TeamsCaptionRouter", () => {
  it("flushes queued audio to the caption author on first caption", () => {
    const { router, calls, clock } = makeRouter();
    router.onAudioChunk(chunk(0.1));
    clock.advance(500);
    router.onAudioChunk(chunk(0.2));
    clock.advance(100);
    router.onCaption("Alice", "hello there everyone");

    const pushes = calls.filter((c) => c.method === "push");
    expect(pushes).toHaveLength(2);
    expect(pushes.every((c) => c.key === "Alice")).toBe(true);
    expect(calls.some((c) => c.method === "setName" && c.key === "Alice")).toBe(true);
    expect(router.currentSpeaker).toBe("Alice");
    expect(router.queuedChunks).toBe(0);
  });

  it("on speaker change flushes only the 2s lookback window to the NEW speaker and flushes the previous speaker's stream", () => {
    const { router, calls, clock } = makeRouter();
    router.onCaption("Alice", "first sentence words");
    // Alice's tail audio, then a long gap, then Bob starts speaking.
    router.onAudioChunk(chunk(0.1)); // t=0 — stale by the time Bob's caption lands
    clock.advance(3000);
    router.onAudioChunk(chunk(0.2)); // t=3000 — within 2s lookback
    clock.advance(1000);
    router.onAudioChunk(chunk(0.3)); // t=4000 — within lookback
    clock.advance(500); // caption at t=4500

    calls.length = 0;
    router.onCaption("Bob", "now it is my turn");

    const pushes = calls.filter((c) => c.method === "push");
    expect(pushes).toHaveLength(2); // stale t=0 chunk discarded
    expect(pushes.every((c) => c.key === "Bob")).toBe(true);
    expect(pushes[0].samples?.[0]).toBeCloseTo(0.2);
    expect(pushes[1].samples?.[0]).toBeCloseTo(0.3);
    expect(calls.some((c) => c.method === "flush" && c.key === "Alice")).toBe(true);
    expect(router.currentSpeaker).toBe("Bob");
  });

  it("treats small caption text changes as ASR refinements (no flush) but flushes on growth", () => {
    const { router, calls } = makeRouter();
    router.onCaption("Alice", "hello world");
    router.onAudioChunk(chunk(0.1));

    calls.length = 0;
    router.onCaption("Alice", "hello world."); // +1 char refinement
    expect(calls.filter((c) => c.method === "push")).toHaveLength(0);
    expect(router.queuedChunks).toBe(1);

    router.onCaption("Alice", "hello world. how are you"); // real growth
    const pushes = calls.filter((c) => c.method === "push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].key).toBe("Alice");
  });

  it("flushes when caption text shrinks (Teams started a new caption entry)", () => {
    const { router, calls } = makeRouter();
    router.onCaption("Alice", "a fairly long finished sentence");
    router.onAudioChunk(chunk(0.4));
    calls.length = 0;
    router.onCaption("Alice", "next"); // shorter than previous → new entry
    expect(calls.filter((c) => c.method === "push")).toHaveLength(1);
  });

  it("deduplicates identical caption keys", () => {
    const { router, calls } = makeRouter();
    router.onCaption("Alice", "hello everyone here");
    router.onAudioChunk(chunk(0.1));
    calls.length = 0;
    router.onCaption("Alice", "hello everyone here"); // exact repeat
    expect(calls).toHaveLength(0);
    expect(router.queuedChunks).toBe(1);
  });

  it("never routes the bot's own captions or audio", () => {
    const { router, calls } = makeRouter();
    router.onAudioChunk(chunk(0.1));
    router.onCaption("Eliza Bot", "I am the bot speaking somehow");
    expect(calls.filter((c) => c.method === "push")).toHaveLength(0);
    expect(router.captionsActive).toBe(false);
  });

  it("evicts ring-buffer chunks older than maxQueueAgeMs", () => {
    const { router, clock } = makeRouter();
    router.onAudioChunk(chunk(0.1)); // t=0
    clock.advance(11_000); // beyond the 10s horizon
    router.onAudioChunk(chunk(0.2)); // triggers eviction
    expect(router.queuedChunks).toBe(1);
  });

  it("voice-level fallback routes audio until the first caption takes over permanently", () => {
    const { router, calls } = makeRouter();
    router.onAudioChunk(chunk(0.1));
    router.onVoiceActivity("Carol", true);
    let pushes = calls.filter((c) => c.method === "push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].key).toBe("Carol");

    // Caption arrives — captions now own routing.
    router.onCaption("Alice", "caption takes over now");
    calls.length = 0;
    router.onAudioChunk(chunk(0.2));
    router.onVoiceActivity("Carol", true);
    pushes = calls.filter((c) => c.method === "push");
    expect(pushes).toHaveLength(0); // voice fallback is dead after captions
    expect(router.currentSpeaker).toBe("Alice");
  });

  it("finalize drains remaining audio to the current speaker and flushes", () => {
    const { router, calls } = makeRouter();
    router.onCaption("Alice", "hello hello hello");
    router.onAudioChunk(chunk(0.5));
    calls.length = 0;
    router.finalize();
    expect(calls.filter((c) => c.method === "push" && c.key === "Alice")).toHaveLength(1);
    expect(calls.some((c) => c.method === "flush" && c.key === "Alice")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { MeetingAudioSink } from "../../../types.js";
import { ZoomSpeakerAttributor } from "../speaker-attribution.js";

interface SinkCall {
  method: "push" | "setName" | "flush";
  key: string;
  name?: string;
}

function makeSink() {
  const calls: SinkCall[] = [];
  const sink: MeetingAudioSink = {
    pushSpeakerAudio: (key) => calls.push({ method: "push", key }),
    setSpeakerName: (key, name) => calls.push({ method: "setName", key, name }),
    flushSpeaker: (key) => calls.push({ method: "flush", key }),
    participantJoined: () => {},
    participantLeft: () => {},
  };
  return { sink, calls };
}

describe("ZoomSpeakerAttributor", () => {
  it("locks the first speaker on a single vote and names the segment", () => {
    const { sink, calls } = makeSink();
    const attributor = new ZoomSpeakerAttributor({ sink });
    attributor.onActiveSpeakerPoll("Alice");
    expect(attributor.currentSpeaker).toBe("Alice");
    expect(calls).toContainEqual({ method: "setName", key: "zoom-speaker-0", name: "Alice" });
  });

  it("requires consecutive votes before switching speaker (flicker filtering)", () => {
    const { sink, calls } = makeSink();
    const attributor = new ZoomSpeakerAttributor({ sink, voteThreshold: 2 });
    attributor.onActiveSpeakerPoll("Alice");

    attributor.onActiveSpeakerPoll("Bob"); // 1 vote — not enough
    expect(attributor.currentSpeaker).toBe("Alice");
    attributor.onActiveSpeakerPoll("Alice"); // resets Bob's candidacy
    attributor.onActiveSpeakerPoll("Bob"); // 1 vote again
    expect(attributor.currentSpeaker).toBe("Alice");
    attributor.onActiveSpeakerPoll("Bob"); // 2nd consecutive vote — lock
    expect(attributor.currentSpeaker).toBe("Bob");

    // Previous segment flushed, new segment named.
    expect(calls).toContainEqual({ method: "flush", key: "zoom-speaker-0" });
    expect(calls).toContainEqual({ method: "setName", key: "zoom-speaker-1", name: "Bob" });
  });

  it("attributes audio chunks to the current segment key across a speaker change", () => {
    const { sink, calls } = makeSink();
    const attributor = new ZoomSpeakerAttributor({ sink, voteThreshold: 2 });
    attributor.onActiveSpeakerPoll("Alice");
    attributor.onAudioChunk(new Float32Array(4));
    attributor.onActiveSpeakerPoll("Bob");
    attributor.onActiveSpeakerPoll("Bob");
    attributor.onAudioChunk(new Float32Array(4));

    const pushes = calls.filter((c) => c.method === "push");
    expect(pushes.map((c) => c.key)).toEqual(["zoom-speaker-0", "zoom-speaker-1"]);
  });

  it("null polls (silence) never break a lock or accumulate votes", () => {
    const { sink } = makeSink();
    const attributor = new ZoomSpeakerAttributor({ sink, voteThreshold: 2 });
    attributor.onActiveSpeakerPoll("Alice");
    attributor.onActiveSpeakerPoll("Bob"); // 1 vote
    attributor.onActiveSpeakerPoll(null); // silence resets candidate
    attributor.onActiveSpeakerPoll("Bob"); // 1 vote again — not 2
    expect(attributor.currentSpeaker).toBe("Alice");
  });

  it("finalize flushes the active segment", () => {
    const { sink, calls } = makeSink();
    const attributor = new ZoomSpeakerAttributor({ sink });
    attributor.onActiveSpeakerPoll("Alice");
    attributor.finalize();
    expect(calls).toContainEqual({ method: "flush", key: "zoom-speaker-0" });
  });
});

/**
 * Deterministic coverage for TalkMode's output mute policy. The harness proves
 * state transitions that do not require hardware audio, while explicitly
 * leaving real mute/silent-switch routing to native device evidence.
 */

import { describe, expect, it } from "vitest";

import {
  createTalkModeAudioState,
  reduceTalkModeAudioPolicy,
} from "./volumeMutePolicy";

describe("volume and mute policy", () => {
  it("keeps capture active and visibly recording when output is muted", () => {
    let state = createTalkModeAudioState();
    state = reduceTalkModeAudioPolicy(state, { type: "capture-started" });
    state = reduceTalkModeAudioPolicy(state, {
      type: "output-mute-changed",
      muted: true,
    });
    state = reduceTalkModeAudioPolicy(state, {
      type: "output-volume-changed",
      volume: 0,
    });
    expect(state.captureActive).toBe(true);
    expect(state.captureIndicator).toBe("recording");
  });

  it("continues TTS silently when hardware mute or volume 0 is applied", () => {
    let state = createTalkModeAudioState();

    state = reduceTalkModeAudioPolicy(state, {
      type: "tts-started",
      utteranceId: "reply-1",
    });
    expect(state.ttsAudibility).toBe("audible");
    expect(state.ttsProgress).toBe("continue");

    state = reduceTalkModeAudioPolicy(state, {
      type: "output-volume-changed",
      volume: 0,
    });
    expect(state.ttsAudibility).toBe("silent-by-output-policy");
    expect(state.ttsProgress).toBe("continue");
    expect(state.ttsUtteranceId).toBe("reply-1");

    state = reduceTalkModeAudioPolicy(state, {
      type: "output-mute-changed",
      muted: true,
    });
    expect(state.ttsAudibility).toBe("silent-by-output-policy");
    expect(state.ttsProgress).toBe("continue");
    expect(state.ttsUtteranceId).toBe("reply-1");
  });

  it("restores audibility for the same utterance when output volume returns", () => {
    let state = createTalkModeAudioState({
      outputMuted: true,
      outputVolume: 0,
    });

    state = reduceTalkModeAudioPolicy(state, {
      type: "tts-started",
      utteranceId: "reply-2",
    });
    expect(state.ttsAudibility).toBe("silent-by-output-policy");

    state = reduceTalkModeAudioPolicy(state, {
      type: "output-mute-changed",
      muted: false,
    });
    state = reduceTalkModeAudioPolicy(state, {
      type: "output-volume-changed",
      volume: 0.4,
    });

    expect(state.ttsUtteranceId).toBe("reply-2");
    expect(state.ttsAudibility).toBe("audible");
    expect(state.ttsProgress).toBe("continue");
  });

  it("ignores stale TTS finish events and clamps invalid output volume", () => {
    let state = createTalkModeAudioState({ outputVolume: Number.NaN });
    expect(state.outputVolume).toBe(1);

    state = reduceTalkModeAudioPolicy(state, {
      type: "output-volume-changed",
      volume: 2,
    });
    expect(state.outputVolume).toBe(1);

    state = reduceTalkModeAudioPolicy(state, {
      type: "tts-started",
      utteranceId: "current",
    });
    state = reduceTalkModeAudioPolicy(state, {
      type: "tts-finished",
      utteranceId: "stale",
    });
    expect(state.ttsUtteranceId).toBe("current");

    state = reduceTalkModeAudioPolicy(state, {
      type: "tts-finished",
      utteranceId: "current",
    });
    expect(state.ttsUtteranceId).toBeNull();
    expect(state.ttsAudibility).toBe("not-speaking");
    expect(state.ttsProgress).toBe("idle");
  });
});

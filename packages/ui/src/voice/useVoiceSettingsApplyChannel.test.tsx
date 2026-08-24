/** Verifies useVoiceSettingsApplyChannel through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * jsdom coverage for the chat-to-voice view event bridge. The hook runs against
 * real localStorage and the real persistence mirrors so the test proves the
 * broadcast contract reaches the same `loadContinuousChatMode` / `loadVadAutoStop`
 * values the running shell/capture path reads — no stubbed setters.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadContinuousChatMode,
  loadOsIntentAutoStartConsent,
  loadVadAutoStop,
  saveContinuousChatMode,
  saveOsIntentAutoStartConsent,
  saveVadAutoStop,
} from "../state/persistence";
import { emitViewEvent } from "../views/view-event-bus";
import {
  useVoiceSettingsApplyChannel,
  VOICE_SETTINGS_APPLY_EVENT,
} from "./useVoiceSettingsApplyChannel";

function Channel(): null {
  useVoiceSettingsApplyChannel();
  return null;
}

function apply(payload: Record<string, unknown>): void {
  act(() => {
    emitViewEvent(VOICE_SETTINGS_APPLY_EVENT, payload, "agent");
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useVoiceSettingsApplyChannel", () => {
  it("re-seeds the continuous-chat and VAD mirrors the shell reads", () => {
    render(<Channel />);
    apply({
      continuous: "always-on",
      vadAutoStop: { silenceMs: 1200, speechRmsThreshold: 0.004 },
    });

    expect(loadContinuousChatMode()).toBe("always-on");
    expect(loadVadAutoStop()).toEqual({
      silenceMs: 1200,
      speechRmsThreshold: 0.004,
    });
  });

  it("ignores an unknown continuous mode and a non-numeric VAD pair", () => {
    saveContinuousChatMode("vad-gated");
    saveVadAutoStop({ silenceMs: 800, speechRmsThreshold: 0.005 });
    render(<Channel />);

    apply({
      continuous: "turbo",
      vadAutoStop: { silenceMs: "loud", speechRmsThreshold: 0.01 },
    });

    // Prior mirror values survive an invalid broadcast — the capture path is
    // never handed a malformed value.
    expect(loadContinuousChatMode()).toBe("vad-gated");
    expect(loadVadAutoStop()).toEqual({
      silenceMs: 800,
      speechRmsThreshold: 0.005,
    });
  });

  it("applies a single provided field without disturbing the other mirror", () => {
    saveVadAutoStop({ silenceMs: 950, speechRmsThreshold: 0.006 });
    render(<Channel />);

    apply({ continuous: "off" });

    expect(loadContinuousChatMode()).toBe("off");
    expect(loadVadAutoStop()).toEqual({
      silenceMs: 950,
      speechRmsThreshold: 0.006,
    });
  });

  it("applies explicit shortcut consent without enabling the other capture mode", () => {
    render(<Channel />);
    apply({ osIntentAutoStartVoice: true });
    expect(loadOsIntentAutoStartConsent()).toEqual({
      voice: true,
      transcription: false,
    });

    apply({ osIntentAutoStartTranscription: true });
    expect(loadOsIntentAutoStartConsent()).toEqual({
      voice: true,
      transcription: true,
    });
  });
});

describe("useVoiceSettingsApplyChannel payload validation edges", () => {
  it("ignores a continuous value whose type is not string", () => {
    saveContinuousChatMode("vad-gated");
    render(<Channel />);

    apply({ continuous: 42 });
    expect(loadContinuousChatMode()).toBe("vad-gated");

    apply({ continuous: null });
    expect(loadContinuousChatMode()).toBe("vad-gated");
  });

  it("rejects array and null vadAutoStop payloads wholesale", () => {
    saveVadAutoStop({ silenceMs: 777, speechRmsThreshold: 0.123 });
    render(<Channel />);

    apply({ vadAutoStop: [] });
    expect(loadVadAutoStop()).toEqual({
      silenceMs: 777,
      speechRmsThreshold: 0.123,
    });

    apply({ vadAutoStop: null });
    expect(loadVadAutoStop()).toEqual({
      silenceMs: 777,
      speechRmsThreshold: 0.123,
    });
  });

  it("does not partially apply a pair whose speechRmsThreshold alone is missing", () => {
    saveVadAutoStop({ silenceMs: 777, speechRmsThreshold: 0.123 });
    render(<Channel />);

    apply({ vadAutoStop: { silenceMs: 500 } });

    expect(loadVadAutoStop()).toEqual({
      silenceMs: 777,
      speechRmsThreshold: 0.123,
    });
  });

  it("rejects non-finite VAD numbers", () => {
    saveVadAutoStop({ silenceMs: 777, speechRmsThreshold: 0.123 });
    render(<Channel />);

    apply({ vadAutoStop: { silenceMs: Number.NaN, speechRmsThreshold: 0.01 } });
    apply({
      vadAutoStop: {
        silenceMs: 400,
        speechRmsThreshold: Number.POSITIVE_INFINITY,
      },
    });

    expect(loadVadAutoStop()).toEqual({
      silenceMs: 777,
      speechRmsThreshold: 0.123,
    });
  });

  it("persists an explicit false consent while the absent sibling keeps its stored value", () => {
    saveOsIntentAutoStartConsent({ voice: true, transcription: true });
    render(<Channel />);

    apply({ osIntentAutoStartVoice: false });

    expect(loadOsIntentAutoStartConsent()).toEqual({
      voice: false,
      transcription: true,
    });
  });

  it("ignores a consent field whose type is not boolean while persisting the valid sibling", () => {
    saveOsIntentAutoStartConsent({ voice: true, transcription: true });
    render(<Channel />);

    apply({
      osIntentAutoStartVoice: "yes",
      osIntentAutoStartTranscription: false,
    });

    expect(loadOsIntentAutoStartConsent()).toEqual({
      voice: true,
      transcription: false,
    });
  });

  it("leaves stored consent untouched when a broadcast carries no consent field", () => {
    saveContinuousChatMode("vad-gated");
    saveOsIntentAutoStartConsent({ voice: true, transcription: true });
    render(<Channel />);

    apply({ continuous: "always-on" });

    expect(loadContinuousChatMode()).toBe("always-on");
    expect(loadOsIntentAutoStartConsent()).toEqual({
      voice: true,
      transcription: true,
    });
  });

  it("lets a later valid broadcast replace earlier mirror values", () => {
    render(<Channel />);

    apply({
      continuous: "off",
      vadAutoStop: { silenceMs: 1200, speechRmsThreshold: 0.004 },
    });
    apply({
      continuous: "always-on",
      vadAutoStop: { silenceMs: 800, speechRmsThreshold: 0.005 },
    });

    expect(loadContinuousChatMode()).toBe("always-on");
    expect(loadVadAutoStop()).toEqual({
      silenceMs: 800,
      speechRmsThreshold: 0.005,
    });
  });

  it("writes nothing when the broadcast payload is empty", () => {
    saveContinuousChatMode("vad-gated");
    saveVadAutoStop({ silenceMs: 777, speechRmsThreshold: 0.123 });
    saveOsIntentAutoStartConsent({ voice: true, transcription: true });
    render(<Channel />);

    apply({});

    expect(loadContinuousChatMode()).toBe("vad-gated");
    expect(loadVadAutoStop()).toEqual({
      silenceMs: 777,
      speechRmsThreshold: 0.123,
    });
    expect(loadOsIntentAutoStartConsent()).toEqual({
      voice: true,
      transcription: true,
    });
  });
});

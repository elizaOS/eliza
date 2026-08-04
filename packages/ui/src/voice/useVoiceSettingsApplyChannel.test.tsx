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
  loadVadAutoStop,
  saveContinuousChatMode,
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
});

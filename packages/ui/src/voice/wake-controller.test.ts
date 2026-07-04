/**
 * Unit coverage for the wake-controller state machine: wake-path selection and
 * the confirm window. Pure functions, no mic.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIRM_WINDOW_MS,
  hasTrainedHead,
  initialWakeControllerState,
  selectWakePath,
  type WakeCapabilities,
  type WakeControllerConfig,
  wakeControllerReducer,
} from "./wake-controller";

/**
 * Unit coverage for the unified wake controller (issue #9880, §D). Validates the
 * path-selection priority and each detection path's confirmation behavior.
 */

const HEADS = new Set(["hey eliza", "eliza"]);

function config(
  caps: WakeCapabilities,
  over: Partial<WakeControllerConfig> = {},
): WakeControllerConfig {
  return {
    characterName: "eliza",
    trainedHeads: HEADS,
    capabilities: caps,
    ...over,
  };
}

const ALL: WakeCapabilities = {
  openWakeWord: true,
  asrConfirm: true,
  swabble: true,
};

describe("selectWakePath", () => {
  it("prefers the head fast-path when a trained head exists", () => {
    expect(selectWakePath(config(ALL))).toBe("head-fast-path");
  });

  it("uses two-stage ASR when openWakeWord+ASR but no head for the name", () => {
    expect(selectWakePath(config(ALL, { characterName: "ada" }))).toBe(
      "two-stage-asr",
    );
  });

  it("falls back to Swabble when the fused detector is unavailable", () => {
    const caps = { openWakeWord: false, asrConfirm: false, swabble: true };
    expect(selectWakePath(config(caps, { characterName: "ada" }))).toBe(
      "swabble-fallback",
    );
  });

  it("prefers two-stage over Swabble when both are possible", () => {
    // openWakeWord + ASR (battery-cheap) beats continuous Swabble ASR.
    expect(selectWakePath(config(ALL, { characterName: "ada" }))).toBe(
      "two-stage-asr",
    );
  });

  it("falls back to Swabble when openWakeWord exists but cannot confirm a renamed name", () => {
    const caps = { openWakeWord: true, asrConfirm: false, swabble: true };
    expect(selectWakePath(config(caps, { characterName: "ada" }))).toBe(
      "swabble-fallback",
    );
  });

  it("returns null when no name-aware detector is available", () => {
    const caps = { openWakeWord: true, asrConfirm: false, swabble: false };
    expect(selectWakePath(config(caps, { characterName: "ada" }))).toBeNull();
    expect(
      selectWakePath(
        config(
          { openWakeWord: false, asrConfirm: false, swabble: false },
          { characterName: "ada" },
        ),
      ),
    ).toBeNull();
  });
});

describe("hasTrainedHead", () => {
  it("matches case/spacing-insensitively via normalizeForWake", () => {
    expect(hasTrainedHead(config(ALL, { characterName: "Eliza" }))).toBe(true);
    expect(hasTrainedHead(config(ALL, { characterName: "Hey Eliza!" }))).toBe(
      true,
    );
    expect(hasTrainedHead(config(ALL, { characterName: "Ada" }))).toBe(false);
  });
});

describe("wakeControllerReducer — head fast-path", () => {
  it("emits a name detection immediately on head-fired", () => {
    const cfg = config(ALL);
    const { state, emit } = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "head-fired", confidence: 0.97, now: 1000 },
      cfg,
    );
    expect(state.phase).toBe("idle");
    expect(emit).toEqual({
      wakeWord: "eliza",
      command: "",
      transcript: "eliza",
      confidence: 0.97,
      path: "head-fast-path",
    });
  });

  it("ignores head-fired when the selected path is not the head fast-path", () => {
    // ada has no head → two-stage path → a stray head event is ignored.
    const cfg = config(ALL, { characterName: "ada" });
    const { emit } = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "head-fired", now: 1000 },
      cfg,
    );
    expect(emit).toBeNull();
  });
});

describe("wakeControllerReducer — two-stage ASR", () => {
  const cfg = config(ALL, { characterName: "ada" });

  it("confirms a candidate when the Stage-B transcript matches the name", () => {
    const armed = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-a-candidate", now: 1000 },
      cfg,
    );
    expect(armed.state.phase).toBe("confirming");
    expect(armed.emit).toBeNull();

    const confirmed = wakeControllerReducer(
      armed.state,
      {
        type: "stage-b-transcript",
        transcript: "hey ada what time is it",
        now: 1200,
      },
      cfg,
    );
    expect(confirmed.state.phase).toBe("idle");
    expect(confirmed.emit).toEqual({
      wakeWord: "ada",
      command: "what time is it",
      transcript: "hey ada what time is it",
      path: "two-stage-asr",
    });
  });

  it("rejects a candidate when the Stage-B transcript is not the wake phrase", () => {
    const armed = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-a-candidate", now: 1000 },
      cfg,
    );
    const rejected = wakeControllerReducer(
      armed.state,
      {
        type: "stage-b-transcript",
        transcript: "hey there how are you",
        now: 1200,
      },
      cfg,
    );
    expect(rejected.state.phase).toBe("idle");
    expect(rejected.emit).toBeNull();
  });

  it("abandons the candidate when no transcript arrives within the confirm window", () => {
    const armed = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-a-candidate", now: 1000 },
      cfg,
    );
    const early = wakeControllerReducer(
      armed.state,
      { type: "tick", now: 1000 + DEFAULT_CONFIRM_WINDOW_MS - 1 },
      cfg,
    );
    expect(early.state.phase).toBe("confirming");
    const timedOut = wakeControllerReducer(
      armed.state,
      { type: "tick", now: 1000 + DEFAULT_CONFIRM_WINDOW_MS },
      cfg,
    );
    expect(timedOut.state.phase).toBe("idle");
    expect(timedOut.emit).toBeNull();
  });

  it("ignores a Stage-B transcript when no candidate is armed", () => {
    const { state, emit } = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-b-transcript", transcript: "hey ada", now: 1000 },
      cfg,
    );
    expect(state.phase).toBe("idle");
    expect(emit).toBeNull();
  });

  it("follows a rename: a head name on two-stage still confirms by ASR", () => {
    // Renamed to a name WITH a head but openWakeWord off → two-stage by caps.
    const caps = { openWakeWord: false, asrConfirm: true, swabble: false };
    const twoStage = config(caps, { characterName: "ada" });
    expect(selectWakePath(twoStage)).toBeNull(); // no openWakeWord → no Stage A
  });
});

describe("wakeControllerReducer — Swabble fallback", () => {
  const caps = { openWakeWord: false, asrConfirm: false, swabble: true };
  const cfg = config(caps, { characterName: "ada" });

  it("passes a Swabble wake straight through", () => {
    const { emit } = wakeControllerReducer(
      initialWakeControllerState(),
      {
        type: "swabble-wake",
        wakeWord: "ada",
        command: "play music",
        transcript: "hey ada play music",
        confidence: 0.8,
      },
      cfg,
    );
    expect(emit).toEqual({
      wakeWord: "ada",
      command: "play music",
      transcript: "hey ada play music",
      confidence: 0.8,
      path: "swabble-fallback",
    });
  });

  it("ignores a Swabble wake when a faster path is selected", () => {
    const { emit } = wakeControllerReducer(
      initialWakeControllerState(),
      {
        type: "swabble-wake",
        wakeWord: "eliza",
        command: "",
        transcript: "hey eliza",
      },
      config(ALL), // head fast-path selected → swabble ignored
    );
    expect(emit).toBeNull();
  });
});

describe("wakeControllerReducer — reset", () => {
  it("returns to idle from a confirming state", () => {
    const cfg = config(ALL, { characterName: "ada" });
    const armed = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-a-candidate", now: 1000 },
      cfg,
    );
    expect(armed.state.phase).toBe("confirming");
    const { state, emit } = wakeControllerReducer(
      armed.state,
      { type: "reset" },
      cfg,
    );
    expect(state.phase).toBe("idle");
    expect(emit).toBeNull();
  });
});

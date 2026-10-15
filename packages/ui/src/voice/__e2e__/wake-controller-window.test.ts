/**
 * The two-stage wake controller arms a confirm window when Stage-A raises a
 * candidate; a Stage-B transcript must arrive inside that window to confirm.
 * The window was only enforced by `tick` events: a transcript arriving after
 * the window expired — with no tick dispatched in between — revived the stale
 * candidate and emitted a false wake. The reducer now enforces the window on
 * the transcript path as well.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIRM_WINDOW_MS,
  initialWakeControllerState,
  wakeControllerReducer,
  type WakeControllerConfig,
} from "../wake-controller";

function twoStageConfig(
  overrides: Partial<WakeControllerConfig> = {},
): WakeControllerConfig {
  return {
    characterName: "Eliza",
    trainedHeads: new Set<string>(),
    capabilities: { openWakeWord: true, asrConfirm: true, swabble: false },
    ...overrides,
  };
}

const TRANSCRIPT = "hey eliza turn on the lights";

describe("wake controller confirm window", () => {
  it("ignores a transcript arriving after the window expired without a tick", () => {
    const config = twoStageConfig({ confirmWindowMs: 2500 });
    const candidate = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-a-candidate", now: 100 },
      config,
    );
    expect(candidate.state.phase).toBe("confirming");
    // 1000ms past the window, and no tick was ever dispatched.
    const late = wakeControllerReducer(
      candidate.state,
      { type: "stage-b-transcript", transcript: TRANSCRIPT, now: 3600 },
      config,
    );
    expect(late.emit).toBeNull();
    expect(late.state.phase).toBe("idle");
  });

  it("still confirms a transcript inside the window", () => {
    const config = twoStageConfig({ confirmWindowMs: 2500 });
    const candidate = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-a-candidate", now: 100 },
      config,
    );
    const confirmed = wakeControllerReducer(
      candidate.state,
      { type: "stage-b-transcript", transcript: TRANSCRIPT, now: 200 },
      config,
    );
    expect(confirmed.emit).not.toBeNull();
    expect(confirmed.emit?.command).toBe("turn on the lights");
    expect(confirmed.emit?.path).toBe("two-stage-asr");
  });

  it("expires a transcript arriving exactly at the window boundary", () => {
    const config = twoStageConfig({ confirmWindowMs: 2500 });
    const candidate = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-a-candidate", now: 100 },
      config,
    );
    // Matches the tick handler's >= boundary.
    const boundary = wakeControllerReducer(
      candidate.state,
      { type: "stage-b-transcript", transcript: TRANSCRIPT, now: 2600 },
      config,
    );
    expect(boundary.emit).toBeNull();
    expect(boundary.state.phase).toBe("idle");
  });

  it("confirms a transcript just inside the window", () => {
    const config = twoStageConfig({ confirmWindowMs: 2500 });
    const candidate = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-a-candidate", now: 100 },
      config,
    );
    const confirmed = wakeControllerReducer(
      candidate.state,
      { type: "stage-b-transcript", transcript: TRANSCRIPT, now: 2599 },
      config,
    );
    expect(confirmed.emit).not.toBeNull();
  });

  it("tick expiry still abandons the candidate", () => {
    const config = twoStageConfig({ confirmWindowMs: 2500 });
    const candidate = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-a-candidate", now: 100 },
      config,
    );
    const ticked = wakeControllerReducer(
      candidate.state,
      { type: "tick", now: 2600 },
      config,
    );
    expect(ticked.emit).toBeNull();
    expect(ticked.state.phase).toBe("idle");
    // A transcript after the tick finds no armed candidate.
    const after = wakeControllerReducer(
      ticked.state,
      { type: "stage-b-transcript", transcript: TRANSCRIPT, now: 2700 },
      config,
    );
    expect(after.emit).toBeNull();
  });

  it("uses the default window when confirmWindowMs is unset", () => {
    const config = twoStageConfig();
    const candidate = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "stage-a-candidate", now: 0 },
      config,
    );
    const late = wakeControllerReducer(
      candidate.state,
      {
        type: "stage-b-transcript",
        transcript: TRANSCRIPT,
        now: DEFAULT_CONFIRM_WINDOW_MS + 1,
      },
      config,
    );
    expect(late.emit).toBeNull();
  });
});

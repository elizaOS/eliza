/**
 * Pins every exported gesture-tuning constant to its shipped value and to the
 * divergence doctrine documented in constants.ts (#12188): shared defaults
 * every surface inherits, plus named per-surface overrides whose DIRECTION of
 * departure is load-bearing (looser/tighter/stiffer/opposite-bias).
 *
 * Pure data — no DOM, no events, no mocks. A retuned literal or a silently
 * flipped override direction fails here instead of drifting inside its hook.
 */
import { describe, expect, it } from "vitest";
import {
  AXIS_COMMIT_SLOP,
  COPY_HOLD_MS,
  DEFAULT_HOLD_MS,
  DEFAULT_PULL_DISTANCE,
  DEFAULT_PULL_VELOCITY,
  DEFAULT_SWIPE_DISTANCE,
  DEFAULT_SWIPE_VELOCITY,
  GRAPH_PAN_ENGAGE_SLOP,
  HORIZONTAL_DOMINANCE_RATIO,
  OVERSHOOT_RESISTANCE,
  PAGER_AXIS_COMMIT_SLOP,
  PAGER_AXIS_DOMINANCE_RATIO,
  PAGER_FLICK_VELOCITY,
  PUSH_TO_TALK_HOLD_MS,
  SHEET_DETENT_OVERSHOOT_SCALE,
  TAP_SLOP,
  TOUCH_TAP_MOVE_SLOP,
} from "./constants";

const NAMED_VALUES: Array<[string, number]> = [
  ["AXIS_COMMIT_SLOP", AXIS_COMMIT_SLOP],
  ["COPY_HOLD_MS", COPY_HOLD_MS],
  ["DEFAULT_HOLD_MS", DEFAULT_HOLD_MS],
  ["DEFAULT_PULL_DISTANCE", DEFAULT_PULL_DISTANCE],
  ["DEFAULT_PULL_VELOCITY", DEFAULT_PULL_VELOCITY],
  ["DEFAULT_SWIPE_DISTANCE", DEFAULT_SWIPE_DISTANCE],
  ["DEFAULT_SWIPE_VELOCITY", DEFAULT_SWIPE_VELOCITY],
  ["GRAPH_PAN_ENGAGE_SLOP", GRAPH_PAN_ENGAGE_SLOP],
  ["HORIZONTAL_DOMINANCE_RATIO", HORIZONTAL_DOMINANCE_RATIO],
  ["OVERSHOOT_RESISTANCE", OVERSHOOT_RESISTANCE],
  ["PAGER_AXIS_COMMIT_SLOP", PAGER_AXIS_COMMIT_SLOP],
  ["PAGER_AXIS_DOMINANCE_RATIO", PAGER_AXIS_DOMINANCE_RATIO],
  ["PAGER_FLICK_VELOCITY", PAGER_FLICK_VELOCITY],
  ["PUSH_TO_TALK_HOLD_MS", PUSH_TO_TALK_HOLD_MS],
  ["SHEET_DETENT_OVERSHOOT_SCALE", SHEET_DETENT_OVERSHOOT_SCALE],
  ["TAP_SLOP", TAP_SLOP],
  ["TOUCH_TAP_MOVE_SLOP", TOUCH_TAP_MOVE_SLOP],
];

const DISTANCES_AND_DURATIONS = [
  TAP_SLOP,
  TOUCH_TAP_MOVE_SLOP,
  GRAPH_PAN_ENGAGE_SLOP,
  AXIS_COMMIT_SLOP,
  PAGER_AXIS_COMMIT_SLOP,
  DEFAULT_PULL_DISTANCE,
  DEFAULT_SWIPE_DISTANCE,
  DEFAULT_HOLD_MS,
  COPY_HOLD_MS,
  PUSH_TO_TALK_HOLD_MS,
  SHEET_DETENT_OVERSHOOT_SCALE,
];

const VELOCITIES = [
  DEFAULT_PULL_VELOCITY,
  DEFAULT_SWIPE_VELOCITY,
  PAGER_FLICK_VELOCITY,
];

describe("shipped tuning values", () => {
  it("pins the movement slops", () => {
    expect(TAP_SLOP).toBe(8);
    expect(TOUCH_TAP_MOVE_SLOP).toBe(10);
    expect(GRAPH_PAN_ENGAGE_SLOP).toBe(4);
    expect(AXIS_COMMIT_SLOP).toBe(8);
    expect(PAGER_AXIS_COMMIT_SLOP).toBe(6);
  });

  it("pins the dominance ratios", () => {
    expect(HORIZONTAL_DOMINANCE_RATIO).toBe(0.8);
    expect(PAGER_AXIS_DOMINANCE_RATIO).toBe(1.15);
  });

  it("pins the shared pull/swipe release defaults", () => {
    expect(DEFAULT_PULL_DISTANCE).toBe(56);
    expect(DEFAULT_PULL_VELOCITY).toBe(0.5);
    expect(DEFAULT_SWIPE_DISTANCE).toBe(64);
    expect(DEFAULT_SWIPE_VELOCITY).toBe(0.4);
    expect(PAGER_FLICK_VELOCITY).toBe(0.45);
  });

  it("pins the long-press timer table", () => {
    expect(DEFAULT_HOLD_MS).toBe(450);
    expect(COPY_HOLD_MS).toBe(420);
    expect(PUSH_TO_TALK_HOLD_MS).toBe(200);
  });

  it("pins the overscroll damping factors", () => {
    expect(OVERSHOOT_RESISTANCE).toBe(0.35);
    expect(SHEET_DETENT_OVERSHOOT_SCALE).toBe(6);
  });
});

describe("divergence doctrine", () => {
  it("judges raw press wobble looser than the axis-locked tap slop", () => {
    expect(TOUCH_TAP_MOVE_SLOP).toBeGreaterThan(TAP_SLOP);
  });

  it("engages a graph-canvas pan tighter than a tap", () => {
    expect(GRAPH_PAN_ENGAGE_SLOP).toBeLessThan(TAP_SLOP);
  });

  it("commits the pager axis sooner than the shared slop", () => {
    expect(PAGER_AXIS_COMMIT_SLOP).toBeLessThan(AXIS_COMMIT_SLOP);
  });

  it("gives the pager and the pull surfaces OPPOSITE dominance biases", () => {
    // Pull surfaces: horizontal need only reach 0.8× vertical (~51° cone).
    expect(HORIZONTAL_DOMINANCE_RATIO).toBeLessThan(1);
    // Pager rail: horizontal must clearly BEAT vertical.
    expect(PAGER_AXIS_DOMINANCE_RATIO).toBeGreaterThan(1);
  });

  it("orders the hold table push-to-talk < copy < context menu", () => {
    expect(PUSH_TO_TALK_HOLD_MS).toBeLessThan(COPY_HOLD_MS);
    expect(COPY_HOLD_MS).toBeLessThan(DEFAULT_HOLD_MS);
  });

  it("keeps the pager flick slightly stiffer than the shared swipe flick", () => {
    expect(PAGER_FLICK_VELOCITY).toBeGreaterThan(DEFAULT_SWIPE_VELOCITY);
    // "Deliberately kept slightly stiffer": the gap stays smaller than the
    // shared default itself — a retune to 2× would be a doctrine change.
    expect(PAGER_FLICK_VELOCITY - DEFAULT_SWIPE_VELOCITY).toBeLessThan(
      DEFAULT_SWIPE_VELOCITY,
    );
  });
});

describe("tap/axis slop sharing", () => {
  it("shares one slop between tap detection and axis commitment", () => {
    // constants.ts declares TAP_SLOP as also the axis-commit check's slop;
    // equality is the shipped tuning, not coincidence.
    expect(AXIS_COMMIT_SLOP).toBe(TAP_SLOP);
  });
});

describe("value domains", () => {
  it("exports exactly the documented table of finite numbers", () => {
    expect(NAMED_VALUES).toHaveLength(17);
    for (const [name, value] of NAMED_VALUES) {
      expect(typeof value, name).toBe("number");
      expect(Number.isFinite(value), name).toBe(true);
    }
  });

  it("keeps every distance, duration and scale strictly positive", () => {
    for (const value of DISTANCES_AND_DURATIONS) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it("keeps every release velocity a positive sub-unity px/ms fraction", () => {
    for (const velocity of VELOCITIES) {
      expect(velocity).toBeGreaterThan(0);
      expect(velocity).toBeLessThan(1);
    }
  });

  it("keeps both dominance ratios positive", () => {
    expect(HORIZONTAL_DOMINANCE_RATIO).toBeGreaterThan(0);
    expect(PAGER_AXIS_DOMINANCE_RATIO).toBeGreaterThan(0);
  });

  it("keeps linear resistance a true damping factor below unity", () => {
    // rubberBand applies it multiplicatively to overshoot: at >= 1 the
    // "damped" travel would stop shrinking toward the edge.
    expect(OVERSHOOT_RESISTANCE).toBeGreaterThan(0);
    expect(OVERSHOOT_RESISTANCE).toBeLessThan(1);
  });
});

describe("dominance semantics", () => {
  it("admits a deliberate diagonal that a strict 1.0 cone rejected (#10715)", () => {
    const horizontalPx = 64;
    const verticalPx = 80;
    // Widened cone: 64 >= 80 × 0.8 → horizontal-dominant.
    expect(horizontalPx).toBeGreaterThanOrEqual(
      verticalPx * HORIZONTAL_DOMINANCE_RATIO,
    );
    // The same gesture fails the old strict rule the ratio replaced.
    expect(horizontalPx).toBeLessThan(verticalPx);
  });

  it("still rejects a mostly-vertical scroll under the widened cone", () => {
    const horizontalPx = 30;
    const verticalPx = 100;
    expect(horizontalPx).toBeLessThan(verticalPx * HORIZONTAL_DOMINANCE_RATIO);
  });
});

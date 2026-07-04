/**
 * Fuzz coverage for the wake listen-window: randomized events must keep the
 * mic-open predicate consistent. Pure, no mic.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAKE_WINDOW_CONFIG,
  initialWakeWindowState,
  micShouldBeOpen,
  type WakeWindowConfig,
  type WakeWindowEvent,
  type WakeWindowState,
  wakeWindowReducer,
} from "./wake-listen-window";

/**
 * Deterministic state fuzz for the wake-listen-window reducer (issue #9880).
 * No Math.random (repo determinism rules) — a seeded LCG drives the event
 * stream, so every run replays identically. We assert the safety invariants the
 * UX depends on: the mic is never stuck open, idle is the only mic-closed
 * phase, and a quiet window always drains to idle within the safety cap.
 */

const CONFIG: WakeWindowConfig = DEFAULT_WAKE_WINDOW_CONFIG;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const EVENT_KINDS = [
  "wake",
  "user-speech-final",
  "agent-responded",
  "tick",
  "reset",
] as const;

function randomEvent(rand: () => number, clock: number): WakeWindowEvent {
  const kind = EVENT_KINDS[Math.floor(rand() * EVENT_KINDS.length)];
  if (kind === "reset") return { type: "reset" };
  return { type: kind, now: clock };
}

describe("wake-listen-window fuzz", () => {
  it("never violates the core invariants over random event streams", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = lcg(seed);
      let state: WakeWindowState = initialWakeWindowState();
      let clock = 1000;
      for (let step = 0; step < 80; step++) {
        clock += Math.floor(rand() * 4000); // advance 0–4s per step
        const event = randomEvent(rand, clock);
        const next = wakeWindowReducer(state, event, CONFIG);

        // Invariant 1: micShouldBeOpen iff phase !== idle.
        expect(micShouldBeOpen(next)).toBe(next.phase !== "idle");
        // Invariant 2: a reset always lands idle.
        if (event.type === "reset") expect(next.phase).toBe("idle");
        // Invariant 3: agent-responded from a non-idle phase closes the window.
        if (event.type === "agent-responded" && state.phase !== "idle") {
          expect(next.phase).toBe("idle");
        }
        // Invariant 4: openedAt is only 0 when idle.
        if (next.phase !== "idle") expect(next.openedAt).toBeGreaterThan(0);

        state = next;
      }

      // Invariant 5 (liveness): from wherever we ended, a quiet stretch of ticks
      // longer than the safety cap MUST drain the window to idle (the mic can
      // never be permanently stuck open).
      let drainClock = clock + CONFIG.maxWindowMs + 1;
      state = wakeWindowReducer(
        state,
        { type: "tick", now: drainClock },
        CONFIG,
      );
      drainClock += CONFIG.maxWindowMs + 1;
      state = wakeWindowReducer(
        state,
        { type: "tick", now: drainClock },
        CONFIG,
      );
      expect(state.phase).toBe("idle");
      expect(micShouldBeOpen(state)).toBe(false);
    }
  });
});

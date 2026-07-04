/**
 * Fuzz coverage for the wake-controller state machine: randomized event
 * sequences must never violate the wake-path invariants. Pure, no mic.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIRM_WINDOW_MS,
  initialWakeControllerState,
  selectWakePath,
  type WakeCapabilities,
  type WakeControllerConfig,
  type WakeControllerEvent,
  type WakeControllerState,
  wakeControllerReducer,
} from "./wake-controller";

/**
 * Deterministic state fuzz for the unified wake controller (issue #9880, §D).
 * A seeded LCG drives the event stream (no Math.random — repo determinism
 * rules), so each run replays identically. We assert the invariants the wake UX
 * depends on across all detection paths: the confirm window never gets stuck,
 * `confirming` is reachable only on the two-stage path, and an emit is only ever
 * produced by the selected path's resolving event.
 */

const HEADS = new Set(["eliza"]);

// Three capability profiles, one per detection path, so every branch is fuzzed.
const PROFILES: Array<{ caps: WakeCapabilities; name: string }> = [
  {
    caps: { openWakeWord: true, asrConfirm: true, swabble: true },
    name: "eliza",
  }, // head-fast-path
  {
    caps: { openWakeWord: true, asrConfirm: true, swabble: true },
    name: "ada",
  }, //   two-stage-asr
  {
    caps: { openWakeWord: false, asrConfirm: false, swabble: true },
    name: "ada",
  }, // swabble-fallback
];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function randomEvent(rand: () => number, clock: number): WakeControllerEvent {
  const r = rand();
  if (r < 0.18) return { type: "stage-a-candidate", now: clock };
  if (r < 0.36)
    return {
      type: "stage-b-transcript",
      transcript: rand() < 0.5 ? "hey ada do the thing" : "unrelated chatter",
      now: clock,
    };
  if (r < 0.54) return { type: "head-fired", now: clock };
  if (r < 0.72)
    return {
      type: "swabble-wake",
      wakeWord: "ada",
      command: "go",
      transcript: "hey ada go",
    };
  if (r < 0.9) return { type: "tick", now: clock };
  return { type: "reset" };
}

describe("wake-controller fuzz", () => {
  it("holds the core invariants over random event streams on every path", () => {
    for (const { caps, name } of PROFILES) {
      const cfg: WakeControllerConfig = {
        characterName: name,
        trainedHeads: HEADS,
        capabilities: caps,
      };
      const path = selectWakePath(cfg);

      for (let seed = 1; seed <= 120; seed++) {
        const rand = lcg(seed);
        let state: WakeControllerState = initialWakeControllerState();
        let clock = 1000;
        for (let step = 0; step < 80; step++) {
          clock += Math.floor(rand() * 2000);
          const event = randomEvent(rand, clock);
          const { state: next, emit } = wakeControllerReducer(
            state,
            event,
            cfg,
          );

          // Invariant 1: `confirming` is only ever reachable on the two-stage path.
          if (next.phase === "confirming") expect(path).toBe("two-stage-asr");
          // Invariant 2: candidateAt > 0 iff confirming.
          expect(next.candidateAt > 0).toBe(next.phase === "confirming");
          // Invariant 3: a reset always lands idle, no emit.
          if (event.type === "reset") {
            expect(next.phase).toBe("idle");
            expect(emit).toBeNull();
          }
          // Invariant 4: an emit only comes from the selected path, and its path
          // field always matches the selected path.
          if (emit) expect(emit.path).toBe(path);
          // Invariant 5: after any emit the controller is idle (no double-fire).
          if (emit) expect(next.phase).toBe("idle");

          state = next;
        }

        // Invariant 6 (liveness): a quiet stretch of ticks longer than the
        // confirm window MUST drain a dangling candidate to idle.
        const drainAt = clock + DEFAULT_CONFIRM_WINDOW_MS + 1;
        state = wakeControllerReducer(
          state,
          { type: "tick", now: drainAt },
          cfg,
        ).state;
        expect(state.phase).toBe("idle");
      }
    }
  });
});

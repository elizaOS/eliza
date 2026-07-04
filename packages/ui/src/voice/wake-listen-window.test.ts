/**
 * Unit coverage for the wake listen-window state machine (when the mic should be
 * open after a wake). Pure functions, no mic.
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

const CONFIG: WakeWindowConfig = { idleTimeoutMs: 8000, maxWindowMs: 30000 };

/** Fold a sequence of events over the reducer from the initial state. */
function run(events: WakeWindowEvent[], config = CONFIG): WakeWindowState {
  return events.reduce(
    (s, e) => wakeWindowReducer(s, e, config),
    initialWakeWindowState(),
  );
}

describe("wakeWindowReducer", () => {
  it("starts idle with the mic closed", () => {
    const s = initialWakeWindowState();
    expect(s.phase).toBe("idle");
    expect(micShouldBeOpen(s)).toBe(false);
  });

  it("opens the mic when a wake word fires", () => {
    const s = run([{ type: "wake", now: 1000 }]);
    expect(s.phase).toBe("open");
    expect(s.openedAt).toBe(1000);
    expect(micShouldBeOpen(s)).toBe(true);
  });

  it("cold-wake trajectory: wake → speak → agent reply closes the window", () => {
    const s = run([
      { type: "wake", now: 1000 },
      { type: "tick", now: 2000 },
      { type: "user-speech-final", now: 2500 },
      { type: "tick", now: 4000 },
      { type: "agent-responded", now: 5000 },
    ]);
    expect(s.phase).toBe("idle");
    expect(micShouldBeOpen(s)).toBe(false);
  });

  it("stays open (awaiting) after the user speaks, until the agent responds", () => {
    const s = run([
      { type: "wake", now: 1000 },
      { type: "user-speech-final", now: 2000 },
      // Well past the idle timeout — but the user already spoke, so we hold for
      // the agent rather than timing out.
      { type: "tick", now: 1000 + 20000 },
    ]);
    expect(s.phase).toBe("awaiting-response");
    expect(micShouldBeOpen(s)).toBe(true);
  });

  it("closes after the idle timeout when the user never speaks", () => {
    const justBefore = run([
      { type: "wake", now: 1000 },
      { type: "tick", now: 1000 + 7999 },
    ]);
    expect(justBefore.phase).toBe("open");

    const atTimeout = wakeWindowReducer(
      justBefore,
      { type: "tick", now: 1000 + 8000 },
      CONFIG,
    );
    expect(atTimeout.phase).toBe("idle");
    expect(micShouldBeOpen(atTimeout)).toBe(false);
  });

  it("enforces the safety cap even while awaiting a (never-arriving) reply", () => {
    const s = run([
      { type: "wake", now: 1000 },
      { type: "user-speech-final", now: 2000 },
      { type: "tick", now: 1000 + 30000 },
    ]);
    expect(s.phase).toBe("idle");
  });

  it("re-arms (refreshes the timers) on a second wake instead of toggling off", () => {
    const afterFirst = run([
      { type: "wake", now: 1000 },
      { type: "tick", now: 1000 + 7000 },
    ]);
    expect(afterFirst.phase).toBe("open");

    const reArmed = wakeWindowReducer(
      afterFirst,
      { type: "wake", now: 9000 },
      CONFIG,
    );
    expect(reArmed.phase).toBe("open");
    expect(reArmed.openedAt).toBe(9000);

    // The original idle deadline (1000+8000=9000) has passed, but the re-arm
    // reset the clock, so a tick just after it does NOT close the window.
    const stillOpen = wakeWindowReducer(
      reArmed,
      { type: "tick", now: 9500 },
      CONFIG,
    );
    expect(stillOpen.phase).toBe("open");
  });

  it("re-wake out of awaiting-response drops back to a fresh open window", () => {
    const s = run([
      { type: "wake", now: 1000 },
      { type: "user-speech-final", now: 2000 },
      { type: "wake", now: 3000 },
    ]);
    expect(s.phase).toBe("open");
    expect(s.openedAt).toBe(3000);
    expect(s.awaitingSince).toBe(0);
  });

  it("ignores stray user/agent signals while idle", () => {
    expect(
      wakeWindowReducer(
        initialWakeWindowState(),
        { type: "user-speech-final", now: 1000 },
        CONFIG,
      ).phase,
    ).toBe("idle");
    expect(
      wakeWindowReducer(
        initialWakeWindowState(),
        { type: "agent-responded", now: 1000 },
        CONFIG,
      ).phase,
    ).toBe("idle");
  });

  it("reset force-closes an open window and is a no-op when idle", () => {
    const open = run([{ type: "wake", now: 1000 }]);
    expect(wakeWindowReducer(open, { type: "reset" }, CONFIG).phase).toBe(
      "idle",
    );
    const idle = initialWakeWindowState();
    expect(wakeWindowReducer(idle, { type: "reset" }, CONFIG)).toBe(idle);
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_WAKE_WINDOW_CONFIG.idleTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_WAKE_WINDOW_CONFIG.maxWindowMs).toBeGreaterThan(
      DEFAULT_WAKE_WINDOW_CONFIG.idleTimeoutMs,
    );
  });
});

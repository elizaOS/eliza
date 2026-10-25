/**
 * Wake-word listening window — the orchestration seam between a native wake
 * detection ("hey eliza") and the mic.
 *
 * The native Swabble detector tells us *when* a wake word fired; this pure
 * state machine decides *how long the mic stays open* afterward. The product
 * rule (see VOICE_UX.md) is: a wake word enables voice for a period of time
 * UNTIL THE AGENT RESPONDS.
 *
 *   idle --wake--> open --user speech--> awaiting-response --agent reply--> idle
 *                   |                          |
 *                   | idle timeout (no speech) | safety cap (runaway)
 *                   +------------> idle <-------+
 *
 * A second wake while a window is already open RE-ARMS it (refreshes the
 * timestamps) rather than toggling anything off — wake is only ever an entry
 * ramp, never an exit. The React hook (`useWakeListenWindow`) is a thin adapter
 * that feeds events in and mirrors `micShouldBeOpen` onto the existing
 * hands-free mic. Everything time-dependent is driven by an explicit `now` so
 * the whole machine is testable under a frozen clock.
 */

export type WakeWindowPhase = "idle" | "open" | "awaiting-response";

export interface WakeWindowState {
  phase: WakeWindowPhase;
  /** When the current window was opened (or last re-armed). 0 when idle. */
  openedAt: number;
  /** When we transitioned to awaiting-response. 0 unless awaiting. */
  awaitingSince: number;
}

export type WakeWindowEvent =
  /** Native wake word fired. */
  | { type: "wake"; now: number }
  /** A user utterance finalized while the window was open. */
  | { type: "user-speech-final"; now: number }
  /** The agent produced a reply (spoke or sent a turn). Closes the window. */
  | { type: "agent-responded"; now: number }
  /** Clock advanced — drives the idle timeout and the safety cap. */
  | { type: "tick"; now: number }
  /** External force-close (mic turned off, wake disabled, unmount). */
  | { type: "reset" };

export interface WakeWindowConfig {
  /**
   * Max ms to keep the mic open after wake when the user never speaks. Closes a
   * dangling open mic. Default 8000.
   */
  idleTimeoutMs: number;
  /**
   * Hard safety cap on total window lifetime regardless of phase, so a missed
   * `agent-responded` signal can never pin the mic open forever. Default 30000.
   */
  maxWindowMs: number;
}

export const DEFAULT_WAKE_WINDOW_CONFIG: WakeWindowConfig = {
  idleTimeoutMs: 8000,
  maxWindowMs: 30000,
};

export function initialWakeWindowState(): WakeWindowState {
  return { phase: "idle", openedAt: 0, awaitingSince: 0 };
}

/** True when the mic should be held open for this state. */
export function micShouldBeOpen(state: WakeWindowState): boolean {
  return state.phase !== "idle";
}

const IDLE: WakeWindowState = {
  phase: "idle",
  openedAt: 0,
  awaitingSince: 0,
};

/**
 * Pure reducer. Given the current window state and an event, returns the next
 * state. Never mutates its input.
 */
export function wakeWindowReducer(
  state: WakeWindowState,
  event: WakeWindowEvent,
  config: WakeWindowConfig = DEFAULT_WAKE_WINDOW_CONFIG,
): WakeWindowState {
  switch (event.type) {
    case "reset":
      return state.phase === "idle" ? state : IDLE;

    case "wake":
      // Open, or re-arm an already-open window (refresh the timers, drop back
      // to plain "open" so the user gets the full idle budget to speak again).
      return { phase: "open", openedAt: event.now, awaitingSince: 0 };

    case "user-speech-final":
      // Only meaningful while a window is open; ignore strays when idle.
      if (state.phase === "idle") return state;
      return {
        phase: "awaiting-response",
        openedAt: state.openedAt,
        awaitingSince: event.now,
      };

    case "agent-responded":
      // The terminal transition: the agent answered, so the window closes.
      if (state.phase === "idle") return state;
      return IDLE;

    case "tick": {
      if (state.phase === "idle") return state;
      // Safety cap: total lifetime exceeded — force close in any phase.
      if (event.now - state.openedAt >= config.maxWindowMs) return IDLE;
      // Idle timeout: opened but the user never started speaking.
      if (
        state.phase === "open" &&
        event.now - state.openedAt >= config.idleTimeoutMs
      ) {
        return IDLE;
      }
      return state;
    }

    default: {
      const _exhaustive: never = event;
      return state;
    }
  }
}

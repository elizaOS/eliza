/**
 * router-loop-guard.ts — the consolidated, pure loop-guard state machine for
 * `SubAgentRouter` (#9960).
 *
 * The router has two runaway-loop backstops and a duplicate-post guard:
 *   - a per-session round-trip cap that force-stops a ping-pong loop,
 *   - a per-lineage `session_state_lost` respawn cap that stops re-spawning a
 *     repeatedly-crashing task and reports one honest terminal failure, and
 *   - a per-completion-lineage compare-and-set that absorbs the cross-session
 *     retry cascade so the user sees one reply, not three.
 *
 * That accounting used to live as five separate mutable `Map`/`Set`s and inline
 * branches scattered through the awaited `handleEvent` body — the dominant
 * flakiness surface (#9960): untestable without a runtime + a live subprocess,
 * and carrying a documented TOCTOU window and a manual counter roll-back.
 *
 * This module folds ALL of that accounting into one explicit, pure reducer —
 * `routerLoopTransition(state, event)` — modeled on `detectStalledSessions`
 * (`task-watchdog-service.ts`) and `runSupervisorTick` (`task-supervisor-service.ts`).
 * The service classifies each ACP event and drives the reducer once per
 * decision point; the reducer owns every counter and returns a `decision` the
 * service executes (force-stop, respawn, post, suppress). Because it is pure
 * and returns a fresh state, a fuzz test can replay arbitrary event orderings
 * and assert the invariants the live system depends on: no double-post, no
 * early force-stop, no leaked (unbounded / un-force-stopped) session.
 */

/** FIFO bound on every per-session / per-lineage map so state can't grow without limit. */
export const ROUTER_LOOP_STATE_BOUND = 1024;

export const DEFAULT_ROUND_TRIP_CAP = 32;
export const DEFAULT_STATE_LOST_RESPAWN_CAP = 3;

/**
 * The complete loop-guard state. Every field is treated as immutable: the
 * reducer never mutates the input, it returns a fresh state with copied
 * collections.
 */
export interface RouterLoopState {
  readonly roundTripCap: number;
  readonly stateLostRespawnCap: number;
  /** Per-session count of injected (counted) round-trips. */
  readonly roundTripCounts: ReadonlyMap<string, number>;
  /** Sessions already force-stopped + surfaced for exceeding the round-trip cap. */
  readonly capExceededSessions: ReadonlySet<string>;
  /** Per stable origin lineage: `session_state_lost` respawn count. */
  readonly stateLostRespawnCounts: ReadonlyMap<string, number>;
  /** Lineages already reported as terminal (one honest failure each). */
  readonly stateLostCapNotified: ReadonlySet<string>;
  /** Completion lineage key → the first session that claimed its post slot. */
  readonly completionFirstPostedSession: ReadonlyMap<string, string>;
}

/** One incoming loop-guard signal, derived from a classified ACP event. */
export type RouterLoopEvent =
  /**
   * A `task_complete` arrived for `lineageKey`: clear that lineage's state-lost
   * respawn accounting so a later genuine restart is not pre-capped by an
   * earlier transient crash.
   */
  | { type: "task_complete_progress"; lineageKey: string }
  /**
   * An `error` with `failureKind === "session_state_lost"` for `lineageKey`.
   * `completionKey` (when resolvable) lets the reducer detect a teardown race:
   * if that completion lineage already posted, the deliverable shipped and the
   * state-loss is suppressed instead of triggering a respawn / failure post.
   */
  | { type: "state_lost"; lineageKey: string; completionKey?: string | null }
  /** An injectable terminal event for `sessionId` (counts toward the round-trip cap). */
  | { type: "round_trip"; sessionId: string }
  /**
   * A previously-counted round-trip for `sessionId` was suppressed downstream
   * (verify-retry handoff, stale continuation, or completion dedupe). Undo the
   * increment iff it is still the current value. `expectedCount` is the `count`
   * returned by the `round_trip` decision being undone.
   */
  | { type: "rollback_round_trip"; sessionId: string; expectedCount: number }
  /** Claim the post slot for a completion lineage, for `sessionId`. */
  | { type: "claim_completion"; completionKey: string; sessionId: string };

/** What the service should do for a given event. */
export type RouterLoopDecision =
  /** Lineage state-lost accounting cleared; nothing else to do. */
  | { kind: "noted" }
  /** Under the cap: attempt a deterministic in-router respawn for this lineage. */
  | { kind: "respawn"; count: number }
  /** Cap exhausted, first time: report one terminal failure for this lineage. */
  | { kind: "terminal_failure"; count: number }
  /** Cap exhausted, already reported: drop silently (no post). */
  | { kind: "already_terminal"; count: number }
  /** Under the round-trip cap: post normally. */
  | { kind: "proceed"; count: number }
  /** First event over the cap: force-stop the session and post the cap notice. */
  | { kind: "force_stop"; count: number }
  /** Already force-stopped: suppress this event (no post). */
  | { kind: "already_capped"; count: number }
  /** The undone increment was still current and was rolled back. */
  | { kind: "rolled_back" }
  /** A later event already advanced the counter; nothing rolled back. */
  | { kind: "noop" }
  /** This session holds the completion slot (newly, or a same-session re-claim): post. */
  | { kind: "claimed" }
  /** A different session already holds the slot: suppress this duplicate. */
  | { kind: "already_claimed" };

export interface RouterLoopTransition {
  readonly state: RouterLoopState;
  readonly decision: RouterLoopDecision;
}

export function createRouterLoopState(opts?: {
  roundTripCap?: number;
  stateLostRespawnCap?: number;
}): RouterLoopState {
  return {
    roundTripCap:
      opts?.roundTripCap && opts.roundTripCap > 0
        ? opts.roundTripCap
        : DEFAULT_ROUND_TRIP_CAP,
    stateLostRespawnCap:
      opts?.stateLostRespawnCap && opts.stateLostRespawnCap > 0
        ? opts.stateLostRespawnCap
        : DEFAULT_STATE_LOST_RESPAWN_CAP,
    roundTripCounts: new Map(),
    capExceededSessions: new Set(),
    stateLostRespawnCounts: new Map(),
    stateLostCapNotified: new Set(),
    completionFirstPostedSession: new Map(),
  };
}

/** Copy a map, set a key, and FIFO-evict down to the bound. */
function setBounded<V>(
  source: ReadonlyMap<string, V>,
  key: string,
  value: V,
): Map<string, V> {
  const next = new Map(source);
  next.set(key, value);
  while (next.size > ROUTER_LOOP_STATE_BOUND) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/** Copy a set, add a key, and FIFO-evict down to the bound. */
function addBounded(source: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(source);
  next.add(key);
  while (next.size > ROUTER_LOOP_STATE_BOUND) {
    const oldest = next.values().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function deleteFromMap<V>(
  source: ReadonlyMap<string, V>,
  key: string,
): Map<string, V> {
  if (!source.has(key)) return source as Map<string, V>;
  const next = new Map(source);
  next.delete(key);
  return next;
}

function deleteFromSet(source: ReadonlySet<string>, key: string): Set<string> {
  if (!source.has(key)) return source as Set<string>;
  const next = new Set(source);
  next.delete(key);
  return next;
}

/**
 * Pure: apply one loop-guard event to `state`, returning the next state and the
 * decision the service must execute. Never mutates `state`.
 */
export function routerLoopTransition(
  state: RouterLoopState,
  event: RouterLoopEvent,
): RouterLoopTransition {
  switch (event.type) {
    case "task_complete_progress": {
      const stateLostRespawnCounts = deleteFromMap(
        state.stateLostRespawnCounts,
        event.lineageKey,
      );
      const stateLostCapNotified = deleteFromSet(
        state.stateLostCapNotified,
        event.lineageKey,
      );
      return {
        state: { ...state, stateLostRespawnCounts, stateLostCapNotified },
        decision: { kind: "noted" },
      };
    }

    case "state_lost": {
      // If this lineage already posted a completion, its deliverable shipped
      // before the process dropped its session state. A late `state_lost` here
      // is a teardown race, not a real failure: re-dispatching would rebuild a
      // finished artifact and surfacing a "couldn't finish, retry?" line
      // contradicts the success the user already saw. Suppress it (no respawn,
      // no post) — the `already_terminal` decision is exactly drop-silently.
      // The completion slot is keyed by `completionKey` (a different shape from
      // the respawn `lineageKey`), so the router passes it through explicitly.
      if (
        event.completionKey != null &&
        state.completionFirstPostedSession.has(event.completionKey)
      ) {
        return {
          state,
          decision: { kind: "already_terminal", count: 0 },
        };
      }
      const count =
        (state.stateLostRespawnCounts.get(event.lineageKey) ?? 0) + 1;
      const stateLostRespawnCounts = setBounded(
        state.stateLostRespawnCounts,
        event.lineageKey,
        count,
      );
      if (count <= state.stateLostRespawnCap) {
        return {
          state: { ...state, stateLostRespawnCounts },
          decision: { kind: "respawn", count },
        };
      }
      // Cap exhausted: report a single terminal failure per lineage.
      if (state.stateLostCapNotified.has(event.lineageKey)) {
        return {
          state: { ...state, stateLostRespawnCounts },
          decision: { kind: "already_terminal", count },
        };
      }
      const stateLostCapNotified = addBounded(
        state.stateLostCapNotified,
        event.lineageKey,
      );
      return {
        state: { ...state, stateLostRespawnCounts, stateLostCapNotified },
        decision: { kind: "terminal_failure", count },
      };
    }

    case "round_trip": {
      const count = (state.roundTripCounts.get(event.sessionId) ?? 0) + 1;
      const roundTripCounts = setBounded(
        state.roundTripCounts,
        event.sessionId,
        count,
      );
      if (count <= state.roundTripCap) {
        return {
          state: { ...state, roundTripCounts },
          decision: { kind: "proceed", count },
        };
      }
      // Over the cap. The first over-cap event force-stops + surfaces; any
      // subsequent event for an already-capped session is suppressed.
      if (state.capExceededSessions.has(event.sessionId)) {
        return {
          state: { ...state, roundTripCounts },
          decision: { kind: "already_capped", count },
        };
      }
      const capExceededSessions = addBounded(
        state.capExceededSessions,
        event.sessionId,
      );
      return {
        state: { ...state, roundTripCounts, capExceededSessions },
        decision: { kind: "force_stop", count },
      };
    }

    case "rollback_round_trip": {
      const current = state.roundTripCounts.get(event.sessionId);
      // Only undo when our increment is still the current value: a subsequent event
      // may have advanced it, in which case the round-trip really happened.
      if (current !== event.expectedCount) {
        return { state, decision: { kind: "noop" } };
      }
      const roundTripCounts =
        event.expectedCount <= 1
          ? deleteFromMap(state.roundTripCounts, event.sessionId)
          : setBounded(
              state.roundTripCounts,
              event.sessionId,
              event.expectedCount - 1,
            );
      return {
        state: { ...state, roundTripCounts },
        decision: { kind: "rolled_back" },
      };
    }

    case "claim_completion": {
      const holder = state.completionFirstPostedSession.get(
        event.completionKey,
      );
      if (holder !== undefined) {
        // Same session re-claiming (progressive completes) still posts; a
        // different session is a cross-session retry cascade and is absorbed.
        return {
          state,
          decision: {
            kind: holder === event.sessionId ? "claimed" : "already_claimed",
          },
        };
      }
      const completionFirstPostedSession = setBounded(
        state.completionFirstPostedSession,
        event.completionKey,
        event.sessionId,
      );
      return {
        state: { ...state, completionFirstPostedSession },
        decision: { kind: "claimed" },
      };
    }

    default: {
      // Exhaustiveness guard: a new event type must add a case above.
      const _never: never = event;
      throw new Error(
        `routerLoopTransition: unhandled event ${JSON.stringify(_never)}`,
      );
    }
  }
}

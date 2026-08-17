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

import {
  MAX_SESSION_RETRY_ATTEMPTS,
  stateLostRespawnCapFor,
  stateLostRespawnUnderCap,
} from "./orchestrator-task-types.js";

/** FIFO bound on every per-session / per-lineage map so state can't grow without limit. */
export const ROUTER_LOOP_STATE_BOUND = 1024;

export const DEFAULT_ROUND_TRIP_CAP = 32;
/** Derived from the shared crash-retry budget so the router's respawn cap and
 * the task service's terminal budget are ONE number (#14104): with a budget of
 * N errored sessions, the router may respawn at most `N - 1` times, so the Nth
 * error terminates the task instead of spawning an (N+1)th orphan worker. */
export const DEFAULT_STATE_LOST_RESPAWN_CAP = stateLostRespawnCapFor(
  MAX_SESSION_RETRY_ATTEMPTS,
);

/**
 * Per-request voice ledger entry: which session posted the single spawn ack
 * for this user request, and which session holds its single user-facing
 * terminal. `finalized` distinguishes a provisional result (a `task_complete`
 * claimed before verification settles — supersedable exactly once by a park
 * notice) from a settled terminal.
 *
 * Finality is not absolute for a `failure` holder: its narration explicitly
 * invites the planner to retry ("spawn a fresh session"), so a later GENUINE
 * `result` supersedes it (`claim_request_terminal`), and an admitted respawn
 * for the same request clears it outright (`respawn_admitted`) so the new
 * generation regains the request's voice. Without those two escapes a
 * transient error permanently gagged the key and the invited retry's real
 * success was eaten (live defect).
 */
export interface RequestVoiceEntry {
  readonly ackSessionId?: string;
  readonly terminal?: {
    readonly holderSessionId: string;
    readonly kind: "result" | "parked" | "failure";
    readonly provisional: boolean;
    readonly finalized: boolean;
  };
}

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
  /**
   * Request key (stable per USER coding request, across sessions AND
   * respawns — see `requestVoiceKeyForMeta`) → its voice ledger entry. The
   * lineage/completion slots above are per session generation; a task-service
   * respawn mints a new session and a new lineage, so every generation's
   * completion passed those guards and relayed. This slot is the broader
   * invariant: ≤1 ack and ≤1 terminal per request, one sanctioned
   * provisional-result → parked supersede.
   */
  readonly requestVoice: ReadonlyMap<string, RequestVoiceEntry>;
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
  | { type: "claim_completion"; completionKey: string; sessionId: string }
  /** Claim the single spawn-ack slot for a user request, for `sessionId`. */
  | { type: "claim_request_ack"; requestKey: string; sessionId: string }
  /**
   * Claim the single user-facing terminal slot for a user request. A
   * `provisional` claim (a `task_complete` before verification settles) may be
   * superseded exactly once by a `parked` claim; everything else is
   * first-writer-wins.
   */
  | {
      type: "claim_request_terminal";
      requestKey: string;
      sessionId: string;
      kind: "result" | "parked" | "failure";
      provisional: boolean;
    }
  /**
   * A NEW spawn was admitted for this request (verify-driven or planner-driven
   * retry). A `failure` terminal held by an earlier generation is cleared so
   * the retry regains the request's voice — its progress/questions un-mute and
   * its eventual terminal claims a fresh slot. `result`/`parked` holders are
   * untouched (the request genuinely concluded), as is the ack slot (one spawn
   * ack per request stands across every generation).
   */
  | { type: "respawn_admitted"; requestKey: string };

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
  | { kind: "already_claimed" }
  /** The request's ack slot was free and is now held by this session: post the ack. */
  | { kind: "ack_granted" }
  /** An ack already posted for this request: suppress this duplicate ack. */
  | { kind: "ack_already_posted" }
  /** The request's terminal slot was free and is now held by this session: post. */
  | { kind: "terminal_granted" }
  /** A sanctioned supersede (provisional result → park, or failure → genuine result): post. */
  | { kind: "terminal_granted_supersede" }
  /** A terminal already holds this request's voice: suppress (holderKind for logging). */
  | { kind: "terminal_denied"; holderKind: "result" | "parked" | "failure" }
  /** An admitted respawn cleared the request's failure terminal: the voice is live again. */
  | { kind: "voice_reset" };

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
    requestVoice: new Map(),
  };
}

const UUID_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pickKeyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** Separator between the request-root base key and a fan-out part suffix.
 * NUL cannot appear in message ids, uuids, or minted part labels, so composed
 * keys can never collide with a bare base key (same trick as the per-origin
 * cap's `spawnOriginKeyFor`). */
const REQUEST_VOICE_PART_SEP = "\0";

/**
 * The canonical request-voice key ladder, read from a session's (or task's)
 * metadata. The BASE mirrors `spawnRootIdFromMeta` (sub-agent-router.ts) —
 * `spawnRootMessageId ?? originConnectorMessageId ?? messageId(uuid)` — plus a
 * `task:<taskId>` fallback so task-service-spawned sessions (no connector
 * message at all) and `notifyVerifyEscalation`'s task-level projection resolve
 * the SAME key. Returns null when nothing stable exists; callers must fail
 * open (no gating) on null.
 *
 * `requestVoicePart` scopes the key WITHIN one user request: a deliberate
 * multi-part fan-out (lane plan with several lanes, a multi-part TASKS create)
 * stamps a distinct part per lane/part at spawn time, so genuinely parallel
 * lanes each own their own ack/terminal slot instead of the first lane's
 * terminal gagging the rest. The part is INHERITED verbatim by every respawn
 * of the same logical lane (task-metadata carry, router synthetic-inbound
 * re-stamp), never re-minted, so respawn-shares-key still holds per lane.
 * Sessions without a part (single-task requests, pre-stamp sessions) keep the
 * bare base key — the original ledger behavior.
 */
export function requestVoiceKeyForMeta(
  meta: Record<string, unknown> | undefined,
): string | null {
  if (!meta) return null;
  const direct =
    pickKeyString(meta.spawnRootMessageId) ??
    pickKeyString(meta.originConnectorMessageId);
  const messageId = pickKeyString(meta.messageId);
  const taskId = pickKeyString(meta.taskId);
  const base =
    direct ??
    (messageId && UUID_KEY_RE.test(messageId) ? messageId : undefined) ??
    (taskId ? `task:${taskId}` : undefined);
  if (!base) return null;
  const part = pickKeyString(meta.requestVoicePart);
  return part ? `${base}${REQUEST_VOICE_PART_SEP}${part}` : base;
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
      if (stateLostRespawnUnderCap(count, state.stateLostRespawnCap)) {
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

    case "claim_request_ack": {
      // Synchronous CAS like claim_completion: no await between get and set,
      // so the TOCTOU window is closed by construction.
      const entry = state.requestVoice.get(event.requestKey);
      if (entry?.ackSessionId !== undefined) {
        return { state, decision: { kind: "ack_already_posted" } };
      }
      const requestVoice = setBounded(state.requestVoice, event.requestKey, {
        ...entry,
        ackSessionId: event.sessionId,
      });
      return {
        state: { ...state, requestVoice },
        decision: { kind: "ack_granted" },
      };
    }

    case "claim_request_terminal": {
      const entry = state.requestVoice.get(event.requestKey);
      const held = entry?.terminal;
      if (held === undefined) {
        // Empty slot: first terminal wins. A provisional claim (task_complete
        // before verification settles) stays supersedable; anything else is
        // final immediately.
        const requestVoice = setBounded(state.requestVoice, event.requestKey, {
          ...entry,
          terminal: {
            holderSessionId: event.sessionId,
            kind: event.kind,
            provisional: event.provisional,
            finalized: !event.provisional,
          },
        });
        return {
          state: { ...state, requestVoice },
          decision: { kind: "terminal_granted" },
        };
      }
      if (held.provisional && !held.finalized && event.kind === "parked") {
        // The ONE sanctioned correction: a provisional result is superseded by
        // the honest park notice, exactly once — the slot finalizes here so a
        // second park (respawn doubled the task) is denied.
        const requestVoice = setBounded(state.requestVoice, event.requestKey, {
          ...entry,
          terminal: {
            holderSessionId: event.sessionId,
            kind: "parked",
            provisional: event.provisional,
            finalized: true,
          },
        });
        return {
          state: { ...state, requestVoice },
          decision: { kind: "terminal_granted_supersede" },
        };
      }
      if (held.kind === "failure" && event.kind === "result") {
        // A failure narration invites the planner to retry, so its finality
        // binds only against duplicate failures and redundant parks — never
        // against the GENUINE success it asked for. Without this supersede the
        // invited retry's task_complete was terminal_denied and the user was
        // left with the stale error (live defect). The new holder is the
        // standard supersedable-provisional result when `provisional`, so the
        // one sanctioned parked correction above still applies to it.
        const requestVoice = setBounded(state.requestVoice, event.requestKey, {
          ...entry,
          terminal: {
            holderSessionId: event.sessionId,
            kind: "result",
            provisional: event.provisional,
            finalized: !event.provisional,
          },
        });
        return {
          state: { ...state, requestVoice },
          decision: { kind: "terminal_granted_supersede" },
        };
      }
      return {
        state,
        decision: { kind: "terminal_denied", holderKind: held.kind },
      };
    }

    case "respawn_admitted": {
      const entry = state.requestVoice.get(event.requestKey);
      if (entry?.terminal?.kind !== "failure") {
        // Nothing to revive: empty slot, or a result/parked terminal that an
        // admitted respawn must not disturb (the request genuinely concluded).
        return { state, decision: { kind: "noop" } };
      }
      // Drop ONLY the failure terminal. The ack slot survives — the request
      // was ack'd once and the retry must not re-ack — and the fresh slot
      // means the retry's terminal claims `terminal_granted` normally, with
      // every downstream `finalized` gate (progress mute, question gate)
      // released for the new generation.
      const { terminal: _cleared, ...rest } = entry;
      const requestVoice = setBounded(state.requestVoice, event.requestKey, {
        ...rest,
      });
      return {
        state: { ...state, requestVoice },
        decision: { kind: "voice_reset" },
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

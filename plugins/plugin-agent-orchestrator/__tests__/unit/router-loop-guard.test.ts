/**
 * Fuzz + property tests for the consolidated router loop-guard reducer (#9960).
 *
 * The acceptance criterion: "A property/fuzz test over the consolidated router
 * state machine passes: no event ordering yields a double-post, early
 * force-stop, or leaked session." These tests enumerate thousands of random
 * event orderings (seeded, so any failure reproduces) across overlapping
 * sessions, lineages, and completion keys, and assert those three invariants
 * directly from the reducer's decision stream — using an oracle that is
 * independent of the reducer's internal bookkeeping.
 */

import { describe, expect, it } from "vitest";
import {
  createRouterLoopState,
  ROUTER_LOOP_STATE_BOUND,
  type RouterLoopEvent,
  type RouterLoopState,
  requestVoiceKeyForMeta,
  routerLoopTransition,
} from "../../src/services/router-loop-guard.js";

/** Deterministic PRNG so a failing seed reproduces exactly. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("routerLoopTransition — deterministic behavior", () => {
  it("force-stops exactly once when round-trips exceed the cap", () => {
    let state = createRouterLoopState({ roundTripCap: 3 });
    const decisions = [];
    for (let i = 0; i < 6; i++) {
      const t = routerLoopTransition(state, {
        type: "round_trip",
        sessionId: "s1",
      });
      state = t.state;
      decisions.push(t.decision);
    }
    expect(decisions.map((d) => d.kind)).toEqual([
      "proceed", // 1
      "proceed", // 2
      "proceed", // 3 (== cap)
      "force_stop", // 4 (first over cap)
      "already_capped", // 5
      "already_capped", // 6
    ]);
  });

  it("rolls back a suppressed round-trip so the cap is not tripped early", () => {
    let state = createRouterLoopState({ roundTripCap: 1 });
    // Session B's every post is suppressed (rolled back); it must never trip.
    for (let i = 0; i < 5; i++) {
      const rt = routerLoopTransition(state, {
        type: "round_trip",
        sessionId: "b",
      });
      state = rt.state;
      expect(rt.decision.kind).toBe("proceed");
      const count = "count" in rt.decision ? rt.decision.count : -1;
      const rb = routerLoopTransition(state, {
        type: "rollback_round_trip",
        sessionId: "b",
        expectedCount: count,
      });
      state = rb.state;
      expect(rb.decision.kind).toBe("rolled_back");
    }
    expect(state.roundTripCounts.get("b") ?? 0).toBe(0);
    expect(state.capExceededSessions.has("b")).toBe(false);
  });

  it("rollback is a no-op once a later event advances the counter", () => {
    let state = createRouterLoopState({ roundTripCap: 10 });
    const first = routerLoopTransition(state, {
      type: "round_trip",
      sessionId: "s",
    });
    state = first.state;
    const firstCount = "count" in first.decision ? first.decision.count : -1;
    // A second event advances the counter before we try to roll the first back.
    state = routerLoopTransition(state, {
      type: "round_trip",
      sessionId: "s",
    }).state;
    const rb = routerLoopTransition(state, {
      type: "rollback_round_trip",
      sessionId: "s",
      expectedCount: firstCount,
    });
    expect(rb.decision.kind).toBe("noop");
    expect(rb.state.roundTripCounts.get("s")).toBe(2);
  });

  it("absorbs a cross-session completion but allows same-session re-claims", () => {
    let state = createRouterLoopState();
    const a = routerLoopTransition(state, {
      type: "claim_completion",
      completionKey: "k",
      sessionId: "s1",
    });
    state = a.state;
    expect(a.decision.kind).toBe("claimed");
    // Same session re-claims (progressive completes) still post.
    const again = routerLoopTransition(state, {
      type: "claim_completion",
      completionKey: "k",
      sessionId: "s1",
    });
    state = again.state;
    expect(again.decision.kind).toBe("claimed");
    // A different session for the same lineage is absorbed.
    const other = routerLoopTransition(state, {
      type: "claim_completion",
      completionKey: "k",
      sessionId: "s2",
    });
    expect(other.decision.kind).toBe("already_claimed");
  });

  it("reports one terminal failure after the state-lost respawn cap, then drops", () => {
    let state = createRouterLoopState({ stateLostRespawnCap: 2 });
    const kinds = [];
    for (let i = 0; i < 5; i++) {
      const t = routerLoopTransition(state, {
        type: "state_lost",
        lineageKey: "L",
      });
      state = t.state;
      kinds.push(t.decision.kind);
    }
    expect(kinds).toEqual([
      "respawn", // 1
      "respawn", // 2 (== cap)
      "terminal_failure", // 3 (first over cap)
      "already_terminal", // 4
      "already_terminal", // 5
    ]);
  });

  it("resets the state-lost lineage on a task_complete so a later restart is not pre-capped", () => {
    let state = createRouterLoopState({ stateLostRespawnCap: 1 });
    state = routerLoopTransition(state, {
      type: "state_lost",
      lineageKey: "L",
    }).state; // count 1 (== cap)
    state = routerLoopTransition(state, {
      type: "task_complete_progress",
      lineageKey: "L",
    }).state; // reset
    const after = routerLoopTransition(state, {
      type: "state_lost",
      lineageKey: "L",
    });
    expect(after.decision.kind).toBe("respawn"); // not terminal — counter reset
  });

  it("suppresses a state-loss whose completion lineage already posted (teardown race, no false retry)", () => {
    let state = createRouterLoopState({ stateLostRespawnCap: 2 });
    // task_complete posts the deliverable and claims the completion slot.
    const claim = routerLoopTransition(state, {
      type: "claim_completion",
      completionKey: "C",
      sessionId: "s1",
    });
    state = claim.state;
    expect(claim.decision.kind).toBe("claimed");
    // The codex process then drops its session state on teardown — but the
    // artifact already shipped. This must NOT respawn or report a failure.
    const lost = routerLoopTransition(state, {
      type: "state_lost",
      lineageKey: "L",
      completionKey: "C",
    });
    expect(lost.decision.kind).toBe("already_terminal"); // drop silently
    if (lost.decision.kind === "already_terminal") {
      expect(lost.decision.count).toBe(0); // no respawn counted
    }
    // And the respawn counter is untouched (the suppression short-circuits).
    expect(lost.state.stateLostRespawnCounts.get("L")).toBeUndefined();
  });

  it("still respawns a state-loss when its completion lineage has NOT posted", () => {
    const state = createRouterLoopState({ stateLostRespawnCap: 2 });
    // No prior claim_completion for "C" — a genuine mid-build crash.
    const lost = routerLoopTransition(state, {
      type: "state_lost",
      lineageKey: "L",
      completionKey: "C",
    });
    expect(lost.decision.kind).toBe("respawn");
  });

  it("grants the request ack exactly once per requestKey", () => {
    let state = createRouterLoopState();
    const first = routerLoopTransition(state, {
      type: "claim_request_ack",
      requestKey: "req",
      sessionId: "s1",
    });
    state = first.state;
    expect(first.decision.kind).toBe("ack_granted");
    // A respawn's second ack for the SAME request is denied — even from the
    // same session, and regardless of which session asks.
    for (const sessionId of ["s1", "s2"]) {
      const again = routerLoopTransition(state, {
        type: "claim_request_ack",
        requestKey: "req",
        sessionId,
      });
      state = again.state;
      expect(again.decision.kind).toBe("ack_already_posted");
    }
    // A different request is an independent slot.
    expect(
      routerLoopTransition(state, {
        type: "claim_request_ack",
        requestKey: "other",
        sessionId: "s2",
      }).decision.kind,
    ).toBe("ack_granted");
  });

  it("grants one terminal, then supersedes a provisional result with a park exactly once", () => {
    let state = createRouterLoopState();
    // Session A's task_complete claims the terminal provisionally.
    const result = routerLoopTransition(state, {
      type: "claim_request_terminal",
      requestKey: "req",
      sessionId: "a",
      kind: "result",
      provisional: true,
    });
    state = result.state;
    expect(result.decision.kind).toBe("terminal_granted");
    // Any further result — same session's re-engage completion, or a
    // respawned session's duplicate — is denied with the holder's kind.
    for (const sessionId of ["a", "b"]) {
      const dup = routerLoopTransition(state, {
        type: "claim_request_terminal",
        requestKey: "req",
        sessionId,
        kind: "result",
        provisional: true,
      });
      state = dup.state;
      expect(dup.decision.kind).toBe("terminal_denied");
      if (dup.decision.kind === "terminal_denied") {
        expect(dup.decision.holderKind).toBe("result");
      }
    }
    // The ONE sanctioned correction: provisional result → park notice.
    const park = routerLoopTransition(state, {
      type: "claim_request_terminal",
      requestKey: "req",
      sessionId: "b",
      kind: "parked",
      provisional: false,
    });
    state = park.state;
    expect(park.decision.kind).toBe("terminal_granted_supersede");
    // The supersede finalized the slot: a SECOND park (respawn doubled the
    // task) is denied, as is anything else.
    const secondPark = routerLoopTransition(state, {
      type: "claim_request_terminal",
      requestKey: "req",
      sessionId: "c",
      kind: "parked",
      provisional: false,
    });
    expect(secondPark.decision.kind).toBe("terminal_denied");
    if (secondPark.decision.kind === "terminal_denied") {
      expect(secondPark.decision.holderKind).toBe("parked");
    }
    expect(state.requestVoice.get("req")?.terminal?.finalized).toBe(true);
  });

  it("finalizes a failure terminal against parks and duplicate failures, but a genuine result supersedes it", () => {
    let state = createRouterLoopState();
    const failure = routerLoopTransition(state, {
      type: "claim_request_terminal",
      requestKey: "req",
      sessionId: "a",
      kind: "failure",
      provisional: false,
    });
    state = failure.state;
    expect(failure.decision.kind).toBe("terminal_granted");
    // Finalized: the dead session's residual questions/progress stay muted...
    expect(state.requestVoice.get("req")?.terminal?.finalized).toBe(true);
    // ...and redundant terminals for the same request are denied.
    for (const kind of ["parked", "failure"] as const) {
      const dup = routerLoopTransition(state, {
        type: "claim_request_terminal",
        requestKey: "req",
        sessionId: "b",
        kind,
        provisional: false,
      });
      state = dup.state;
      expect(dup.decision.kind).toBe("terminal_denied");
      if (dup.decision.kind === "terminal_denied") {
        expect(dup.decision.holderKind).toBe("failure");
      }
    }
    // But the failure narration INVITED a retry: the retry's genuine
    // task_complete outranks the stale error (live defect: the invited
    // retry's success was eaten and the user kept only the error).
    const result = routerLoopTransition(state, {
      type: "claim_request_terminal",
      requestKey: "req",
      sessionId: "retry",
      kind: "result",
      provisional: true,
    });
    state = result.state;
    expect(result.decision.kind).toBe("terminal_granted_supersede");
    // The new holder is the standard supersedable-provisional result: the
    // one sanctioned parked correction still applies, exactly once.
    expect(state.requestVoice.get("req")?.terminal?.kind).toBe("result");
    expect(state.requestVoice.get("req")?.terminal?.finalized).toBe(false);
    const park = routerLoopTransition(state, {
      type: "claim_request_terminal",
      requestKey: "req",
      sessionId: "retry",
      kind: "parked",
      provisional: false,
    });
    state = park.state;
    expect(park.decision.kind).toBe("terminal_granted_supersede");
    expect(state.requestVoice.get("req")?.terminal?.finalized).toBe(true);
    // Settled for good: a late failure cannot re-open the chain.
    expect(
      routerLoopTransition(state, {
        type: "claim_request_terminal",
        requestKey: "req",
        sessionId: "c",
        kind: "failure",
        provisional: false,
      }).decision.kind,
    ).toBe("terminal_denied");
  });

  it("respawn_admitted clears only a failure terminal, reviving the request's voice", () => {
    let state = createRouterLoopState();
    // Empty slot: nothing to revive.
    expect(
      routerLoopTransition(state, {
        type: "respawn_admitted",
        requestKey: "req",
      }).decision.kind,
    ).toBe("noop");
    state = routerLoopTransition(state, {
      type: "claim_request_ack",
      requestKey: "req",
      sessionId: "a",
    }).state;
    state = routerLoopTransition(state, {
      type: "claim_request_terminal",
      requestKey: "req",
      sessionId: "a",
      kind: "failure",
      provisional: false,
    }).state;
    const reset = routerLoopTransition(state, {
      type: "respawn_admitted",
      requestKey: "req",
    });
    state = reset.state;
    expect(reset.decision.kind).toBe("voice_reset");
    // The terminal slot is empty again (finalized gates release for the new
    // generation) while the ack slot survives — one spawn ack per request.
    expect(state.requestVoice.get("req")?.terminal).toBeUndefined();
    expect(state.requestVoice.get("req")?.ackSessionId).toBe("a");
    expect(
      routerLoopTransition(state, {
        type: "claim_request_ack",
        requestKey: "req",
        sessionId: "retry",
      }).decision.kind,
    ).toBe("ack_already_posted");
    // The retry's completion claims a FRESH grant (not a supersede).
    const retryResult = routerLoopTransition(state, {
      type: "claim_request_terminal",
      requestKey: "req",
      sessionId: "retry",
      kind: "result",
      provisional: true,
    });
    state = retryResult.state;
    expect(retryResult.decision.kind).toBe("terminal_granted");
    // A result/parked holder is never disturbed by an admitted respawn: the
    // request genuinely concluded.
    expect(
      routerLoopTransition(state, {
        type: "respawn_admitted",
        requestKey: "req",
      }).decision.kind,
    ).toBe("noop");
    expect(state.requestVoice.get("req")?.terminal?.kind).toBe("result");
  });

  it("keeps ack and terminal slots independent within one request entry", () => {
    let state = createRouterLoopState();
    state = routerLoopTransition(state, {
      type: "claim_request_terminal",
      requestKey: "req",
      sessionId: "a",
      kind: "result",
      provisional: true,
    }).state;
    // Terminal held does not consume the ack slot, and granting the ack
    // afterwards preserves the terminal.
    const ack = routerLoopTransition(state, {
      type: "claim_request_ack",
      requestKey: "req",
      sessionId: "a",
    });
    state = ack.state;
    expect(ack.decision.kind).toBe("ack_granted");
    expect(state.requestVoice.get("req")?.terminal?.kind).toBe("result");
    expect(state.requestVoice.get("req")?.ackSessionId).toBe("a");
  });

  it("FIFO-bounds the requestVoice ledger", () => {
    let state = createRouterLoopState();
    for (let i = 0; i < ROUTER_LOOP_STATE_BOUND + 10; i++) {
      state = routerLoopTransition(state, {
        type: "claim_request_ack",
        requestKey: `req${i}`,
        sessionId: `s${i}`,
      }).state;
    }
    expect(state.requestVoice.size).toBe(ROUTER_LOOP_STATE_BOUND);
    // The oldest entries were evicted, the newest survive.
    expect(state.requestVoice.has("req0")).toBe(false);
    expect(state.requestVoice.has(`req${ROUTER_LOOP_STATE_BOUND + 9}`)).toBe(
      true,
    );
  });

  it("never mutates the input state (immutability)", () => {
    const state = createRouterLoopState({ roundTripCap: 1 });
    const next = routerLoopTransition(state, {
      type: "round_trip",
      sessionId: "s",
    });
    expect(state.roundTripCounts.size).toBe(0); // input untouched
    expect(next.state.roundTripCounts.get("s")).toBe(1);
    expect(next.state).not.toBe(state);
  });
});

describe("requestVoiceKeyForMeta — canonical key ladder", () => {
  const UUID = "0b0b0b0b-1111-2222-3333-444444444444";

  it("prefers spawnRootMessageId, then originConnectorMessageId, then uuid messageId, then task:<taskId>", () => {
    expect(
      requestVoiceKeyForMeta({
        spawnRootMessageId: "root-1",
        originConnectorMessageId: "conn-1",
        messageId: UUID,
        taskId: "t1",
      }),
    ).toBe("root-1");
    expect(
      requestVoiceKeyForMeta({
        originConnectorMessageId: "conn-1",
        messageId: UUID,
        taskId: "t1",
      }),
    ).toBe("conn-1");
    expect(requestVoiceKeyForMeta({ messageId: UUID, taskId: "t1" })).toBe(
      UUID,
    );
    // task-service-spawned sessions carry no connector/root message at all —
    // the taskId fallback makes them and notifyVerifyEscalation resolve the
    // SAME key.
    expect(requestVoiceKeyForMeta({ taskId: "t1" })).toBe("task:t1");
  });

  it("rejects a non-uuid messageId (falls through to taskId)", () => {
    expect(
      requestVoiceKeyForMeta({ messageId: "not-a-uuid", taskId: "t1" }),
    ).toBe("task:t1");
  });

  it("returns null (fail open) when nothing stable exists", () => {
    expect(requestVoiceKeyForMeta(undefined)).toBeNull();
    expect(requestVoiceKeyForMeta({})).toBeNull();
    expect(
      requestVoiceKeyForMeta({ messageId: "not-a-uuid", taskId: "  " }),
    ).toBeNull();
  });

  it("scopes the key by requestVoicePart so parallel fan-out lanes own distinct slots", () => {
    const laneA = requestVoiceKeyForMeta({
      spawnRootMessageId: "root-1",
      requestVoicePart: "lane:w1:a",
    });
    const laneB = requestVoiceKeyForMeta({
      spawnRootMessageId: "root-1",
      requestVoicePart: "lane:w1:b",
    });
    const bare = requestVoiceKeyForMeta({ spawnRootMessageId: "root-1" });
    expect(laneA).not.toBeNull();
    expect(laneA).not.toBe(laneB);
    expect(laneA).not.toBe(bare);
    expect(laneB).not.toBe(bare);
    // A respawn inherits the part VERBATIM → the exact same key (the
    // respawn-shares-key property, now per lane).
    expect(
      requestVoiceKeyForMeta({
        spawnRootMessageId: "root-1",
        requestVoicePart: "lane:w1:a",
      }),
    ).toBe(laneA);
  });

  it("applies the part suffix on every base rung, including task:<taskId>", () => {
    const part0 = requestVoiceKeyForMeta({
      taskId: "t1",
      requestVoicePart: "part:0",
    });
    const part1 = requestVoiceKeyForMeta({
      taskId: "t1",
      requestVoicePart: "part:1",
    });
    expect(part0).toContain("task:t1");
    expect(part0).not.toBe(part1);
    expect(part0).not.toBe(requestVoiceKeyForMeta({ taskId: "t1" }));
  });

  it("a part alone (no base) still fails open to null", () => {
    expect(requestVoiceKeyForMeta({ requestVoicePart: "part:0" })).toBeNull();
  });
});

/**
 * Independent oracle: derive the three invariants purely from the reducer's
 * observed decision stream, NOT from its internal maps. `committed[session]`
 * tracks net round-trips (every round_trip increments; every successful
 * `rolled_back` decrements) so we can assert force-stops fire only at cap+1.
 */
interface Recorded {
  event: RouterLoopEvent;
  kind: string;
  count: number | null;
}

function replay(events: RouterLoopEvent[], state: RouterLoopState): Recorded[] {
  const out: Recorded[] = [];
  let s = state;
  for (const event of events) {
    const t = routerLoopTransition(s, event);
    s = t.state;
    out.push({
      event,
      kind: t.decision.kind,
      count: "count" in t.decision ? t.decision.count : null,
    });
  }
  // Stash the final state on the array for leak assertions.
  (out as Recorded[] & { final: RouterLoopState }).final = s;
  return out;
}

function assertInvariants(
  recorded: Recorded[],
  cap: number,
  stateLostCap: number,
  seed: number,
): void {
  const ctx = `seed=${seed}`;

  // --- Invariant 1: no double-post (completion) ---
  // Every `claimed` decision for a given completion key must come from the same
  // session — a second distinct session would be a duplicate user-facing post.
  const claimedBy = new Map<string, string>();
  for (const r of recorded) {
    if (r.event.type === "claim_completion" && r.kind === "claimed") {
      const prev = claimedBy.get(r.event.completionKey);
      if (prev !== undefined) {
        expect(prev, `${ctx} double-post for ${r.event.completionKey}`).toBe(
          r.event.sessionId,
        );
      } else {
        claimedBy.set(r.event.completionKey, r.event.sessionId);
      }
    }
  }

  // --- Invariant 2: no early force-stop ---
  const committed = new Map<string, number>();
  const forceStops = new Map<string, number>();
  for (const r of recorded) {
    if (r.event.type === "round_trip") {
      const next = (committed.get(r.event.sessionId) ?? 0) + 1;
      committed.set(r.event.sessionId, next);
      if (r.kind === "proceed") {
        expect(next, `${ctx} proceed above cap`).toBeLessThanOrEqual(cap);
      } else if (r.kind === "force_stop") {
        // A force-stop may fire ONLY at the first crossing of the cap.
        expect(next, `${ctx} force_stop not at cap+1`).toBe(cap + 1);
        forceStops.set(
          r.event.sessionId,
          (forceStops.get(r.event.sessionId) ?? 0) + 1,
        );
      } else if (r.kind === "already_capped") {
        expect(next, `${ctx} already_capped at/under cap`).toBeGreaterThan(cap);
      }
    } else if (
      r.event.type === "rollback_round_trip" &&
      r.kind === "rolled_back"
    ) {
      committed.set(
        r.event.sessionId,
        (committed.get(r.event.sessionId) ?? 0) - 1,
      );
    }
  }
  // Each session is force-stopped at most once (no repeated force-stops).
  for (const [session, n] of forceStops) {
    expect(n, `${ctx} ${session} force-stopped ${n}x`).toBeLessThanOrEqual(1);
  }

  // --- Invariant 2b: state-lost respawn cap mirrors the round-trip property ---
  const slCount = new Map<string, number>();
  const terminalFailures = new Map<string, number>();
  for (const r of recorded) {
    if (r.event.type === "task_complete_progress") {
      slCount.delete(r.event.lineageKey);
      terminalFailures.delete(r.event.lineageKey);
    } else if (r.event.type === "state_lost") {
      const next = (slCount.get(r.event.lineageKey) ?? 0) + 1;
      slCount.set(r.event.lineageKey, next);
      if (r.kind === "respawn") {
        expect(next, `${ctx} respawn above cap`).toBeLessThanOrEqual(
          stateLostCap,
        );
      } else if (r.kind === "terminal_failure") {
        expect(next, `${ctx} terminal not at cap+1`).toBe(stateLostCap + 1);
        terminalFailures.set(
          r.event.lineageKey,
          (terminalFailures.get(r.event.lineageKey) ?? 0) + 1,
        );
      } else if (r.kind === "already_terminal") {
        expect(next, `${ctx} already_terminal under cap`).toBeGreaterThan(
          stateLostCap,
        );
      }
    }
  }
  // One honest terminal failure per lineage per cap-exhaustion window.
  for (const [lineage, n] of terminalFailures) {
    expect(n, `${ctx} ${lineage} terminal ${n}x`).toBeLessThanOrEqual(1);
  }

  // --- Invariant 2c: request voice — at most one ack_granted per requestKey
  // (acks never reset, even across respawn_admitted revives), and every
  // terminal decision must be consistent with an independently-tracked holder
  // model: a grant only on an empty slot; a supersede only as one of the two
  // sanctioned corrections (provisional result → park, failure → genuine
  // result); a voice_reset only for a failure holder; a denial everywhere
  // else. The model also bounds user-visible terminal posts: within one
  // holder generation the longest chain is failure → result → parked. ---
  const ackGrants = new Map<string, number>();
  interface OracleHolder {
    kind: "result" | "parked" | "failure";
    provisional: boolean;
    finalized: boolean;
  }
  const holders = new Map<string, OracleHolder>();
  const supersedesSinceReset = new Map<string, number>();
  for (const r of recorded) {
    if (r.event.type === "claim_request_ack" && r.kind === "ack_granted") {
      ackGrants.set(
        r.event.requestKey,
        (ackGrants.get(r.event.requestKey) ?? 0) + 1,
      );
    } else if (r.event.type === "respawn_admitted") {
      const key = r.event.requestKey;
      const holder = holders.get(key);
      if (r.kind === "voice_reset") {
        expect(
          holder?.kind,
          `${ctx} ${key} voice_reset without a failure holder`,
        ).toBe("failure");
        holders.delete(key);
        supersedesSinceReset.delete(key);
      } else {
        expect(r.kind, `${ctx} ${key} respawn_admitted decision`).toBe("noop");
        expect(
          holder?.kind === "failure",
          `${ctx} ${key} respawn_admitted noop left a failure holder`,
        ).toBe(false);
      }
    } else if (r.event.type === "claim_request_terminal") {
      const key = r.event.requestKey;
      const holder = holders.get(key);
      if (r.kind === "terminal_granted") {
        expect(
          holder,
          `${ctx} ${key} terminal granted over an existing holder`,
        ).toBeUndefined();
        holders.set(key, {
          kind: r.event.kind,
          provisional: r.event.provisional,
          finalized: !r.event.provisional,
        });
      } else if (r.kind === "terminal_granted_supersede") {
        const parkOverProvisional =
          holder?.provisional && !holder.finalized && r.event.kind === "parked";
        const resultOverFailure =
          holder !== undefined &&
          holder.kind === "failure" &&
          r.event.kind === "result";
        expect(
          parkOverProvisional || resultOverFailure,
          `${ctx} ${key} unsanctioned supersede (holder=${JSON.stringify(holder)}, kind=${r.event.kind})`,
        ).toBe(true);
        holders.set(
          key,
          r.event.kind === "parked"
            ? {
                kind: "parked",
                provisional: r.event.provisional,
                finalized: true,
              }
            : {
                kind: "result",
                provisional: r.event.provisional,
                finalized: !r.event.provisional,
              },
        );
        const n = (supersedesSinceReset.get(key) ?? 0) + 1;
        supersedesSinceReset.set(key, n);
        // Longest sanctioned chain per holder generation:
        // failure → result → parked.
        expect(n, `${ctx} ${key} superseded ${n}x`).toBeLessThanOrEqual(2);
      } else {
        expect(r.kind, `${ctx} ${key} terminal decision`).toBe(
          "terminal_denied",
        );
        expect(holder, `${ctx} ${key} denial with an empty slot`).toBeDefined();
      }
    }
  }
  for (const [key, n] of ackGrants) {
    expect(n, `${ctx} ${key} ack granted ${n}x`).toBeLessThanOrEqual(1);
  }
  // --- Invariant 3: no leaked session (bounded state) ---
  const final = (recorded as Recorded[] & { final: RouterLoopState }).final;
  expect(final.roundTripCounts.size).toBeLessThanOrEqual(
    ROUTER_LOOP_STATE_BOUND,
  );
  expect(final.capExceededSessions.size).toBeLessThanOrEqual(
    ROUTER_LOOP_STATE_BOUND,
  );
  expect(final.stateLostRespawnCounts.size).toBeLessThanOrEqual(
    ROUTER_LOOP_STATE_BOUND,
  );
  expect(final.stateLostCapNotified.size).toBeLessThanOrEqual(
    ROUTER_LOOP_STATE_BOUND,
  );
  expect(final.completionFirstPostedSession.size).toBeLessThanOrEqual(
    ROUTER_LOOP_STATE_BOUND,
  );
  expect(final.requestVoice.size).toBeLessThanOrEqual(ROUTER_LOOP_STATE_BOUND);
}

describe("routerLoopTransition — fuzz over event orderings", () => {
  it("upholds no-double-post / no-early-force-stop / no-leak across 400 random orderings", () => {
    // Small, overlapping pools force collisions and interleavings: multiple
    // sessions per lineage, multiple lineages per completion key, suppressions
    // racing completions.
    const SESSIONS = ["s0", "s1", "s2", "s3"];
    const LINEAGES = ["L0", "L1"];
    const KEYS = ["k0", "k1", "k2"];
    const REQUEST_KEYS = ["r0", "r1"];
    const TERMINAL_KINDS = ["result", "parked", "failure"] as const;

    for (let seed = 1; seed <= 400; seed++) {
      const rng = mulberry32(seed);
      const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
      const cap = 1 + Math.floor(rng() * 4); // 1..4
      const stateLostCap = 1 + Math.floor(rng() * 3); // 1..3
      const state = createRouterLoopState({
        roundTripCap: cap,
        stateLostRespawnCap: stateLostCap,
      });

      const events: RouterLoopEvent[] = [];
      // Remember the last counted round-trip per session so rollbacks target a
      // plausible value (the router rolls back the count it just produced).
      const lastCount = new Map<string, number>();
      const n = 30 + Math.floor(rng() * 40);
      for (let i = 0; i < n; i++) {
        const roll = rng();
        if (roll < 0.4) {
          const sessionId = pick(SESSIONS);
          events.push({ type: "round_trip", sessionId });
          lastCount.set(sessionId, (lastCount.get(sessionId) ?? 0) + 1);
        } else if (roll < 0.6) {
          const sessionId = pick(SESSIONS);
          // Mostly target the most recent increment; sometimes a stale value to
          // exercise the no-op path.
          const expectedCount =
            rng() < 0.8
              ? (lastCount.get(sessionId) ?? 0)
              : Math.floor(rng() * 6);
          events.push({
            type: "rollback_round_trip",
            sessionId,
            expectedCount,
          });
        } else if (roll < 0.72) {
          events.push({
            type: "claim_completion",
            completionKey: pick(KEYS),
            sessionId: pick(SESSIONS),
          });
        } else if (roll < 0.8) {
          events.push({ type: "state_lost", lineageKey: pick(LINEAGES) });
        } else if (roll < 0.86) {
          events.push({
            type: "task_complete_progress",
            lineageKey: pick(LINEAGES),
          });
        } else if (roll < 0.9) {
          events.push({
            type: "claim_request_ack",
            requestKey: pick(REQUEST_KEYS),
            sessionId: pick(SESSIONS),
          });
        } else if (roll < 0.93) {
          // An admitted retry spawn racing terminal claims: revives a gagged
          // failure key, must never disturb a result/parked conclusion.
          events.push({
            type: "respawn_admitted",
            requestKey: pick(REQUEST_KEYS),
          });
        } else {
          const kind = pick([...TERMINAL_KINDS]);
          events.push({
            type: "claim_request_terminal",
            requestKey: pick(REQUEST_KEYS),
            sessionId: pick(SESSIONS),
            kind,
            // Mirror production: results claim provisional, parks/failures
            // claim final — plus a random sprinkle of the off-diagonal
            // combinations to keep the reducer honest about them.
            provisional: kind === "result" ? rng() < 0.9 : rng() < 0.1,
          });
        }
      }

      const recorded = replay(events, state);
      assertInvariants(recorded, cap, stateLostCap, seed);
    }
  });

  it("keeps every map bounded under thousands of distinct keys (no leak)", () => {
    let state = createRouterLoopState({ roundTripCap: 100000 });
    const total = ROUTER_LOOP_STATE_BOUND * 3;
    for (let i = 0; i < total; i++) {
      state = routerLoopTransition(state, {
        type: "round_trip",
        sessionId: `s${i}`,
      }).state;
      state = routerLoopTransition(state, {
        type: "state_lost",
        lineageKey: `L${i}`,
      }).state;
      state = routerLoopTransition(state, {
        type: "claim_completion",
        completionKey: `k${i}`,
        sessionId: `s${i}`,
      }).state;
    }
    expect(state.roundTripCounts.size).toBe(ROUTER_LOOP_STATE_BOUND);
    expect(state.stateLostRespawnCounts.size).toBe(ROUTER_LOOP_STATE_BOUND);
    expect(state.completionFirstPostedSession.size).toBe(
      ROUTER_LOOP_STATE_BOUND,
    );
    // Deliberately heavy: 3×BOUND distinct keys × 3 transitions each. On a
    // loaded CI box the pure-CPU loop runs ~4-6s, over vitest's 5s default —
    // give it real headroom so the leak invariant isn't a flaky red.
  }, 30_000);
});

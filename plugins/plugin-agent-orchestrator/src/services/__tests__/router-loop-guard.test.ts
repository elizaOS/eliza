import { describe, expect, it, vi } from "vitest";

vi.mock("./orchestrator-task-types.js", () => ({
  MAX_SESSION_RETRY_ATTEMPTS: 5,
  stateLostRespawnCapFor: (budget: number) => Math.max(1, budget - 1),
  stateLostRespawnUnderCap: (count: number, cap: number) => count < cap,
}));

import {
  createRouterLoopState,
  ROUTER_LOOP_STATE_BOUND,
  routerLoopTransition,
} from "./router-loop-guard.ts";

describe("createRouterLoopState", () => {
  it("initializes with defaults", () => {
    const state = createRouterLoopState();
    expect(state.roundTripCap).toBe(32);
    expect(state.roundTripCounts.size).toBe(0);
  });
});

describe("routerLoopTransition", () => {
  it("counts round trips and force-stops at the cap", () => {
    let state = createRouterLoopState({ roundTripCap: 2 });
    const session = "session-1";
    let decision;
    for (let i = 0; i < 3; i++) {
      const result = routerLoopTransition(state, {
        type: "round_trip",
        sessionId: session,
      });
      state = result.state;
      decision = result.decision;
    }
    expect(decision.kind).toBe("force_stop");
  });

  it("suppresses duplicate completion claims for a different session", () => {
    const state = createRouterLoopState();
    const first = routerLoopTransition(state, {
      type: "claim_completion",
      completionKey: "lineage-1",
      sessionId: "s1",
    });
    expect(first.decision.kind).toBe("claimed");
    const second = routerLoopTransition(first.state, {
      type: "claim_completion",
      completionKey: "lineage-1",
      sessionId: "s2",
    });
    expect(second.decision.kind).toBe("already_claimed");
  });

  it("bounds per-session state", () => {
    const state = createRouterLoopState({ roundTripCap: 4 });
    expect(ROUTER_LOOP_STATE_BOUND).toBeGreaterThan(0);
    expect(state.roundTripCounts.size).toBeLessThanOrEqual(
      ROUTER_LOOP_STATE_BOUND,
    );
  });
});

// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import { partitionFocusDeferredActions } from "../src/activity-profile/focus-session.js";
import {
  type GoalSlim,
  planGoalCheckIns,
} from "../src/activity-profile/proactive-planner.js";
import type { ActivityProfile } from "../src/activity-profile/types.js";

/**
 * Wiring-regression guard for the proactive nudge pipeline (#9970). The issue
 * calls out that the early `null`/`[]` returns make "no signal" and "pipeline
 * broken" indistinguishable, so a wiring regression silently yields no nudges.
 * This pins the happy path end to end: a real awake profile + an actionable
 * goal must *produce* a nudge, and the focus-defer consumer must only defer it
 * while the owner is heads-down. If a loader/planner regresses to an empty
 * list, the first assertion fails loudly instead of the assistant going quiet.
 */

const NOW = new Date("2026-06-23T12:00:00Z");

const profile = (o: Partial<ActivityProfile> = {}): ActivityProfile =>
  ({
    isCurrentlySleeping: false,
    isCurrentlyActive: true,
    lastSeenPlatform: "discord",
    primaryPlatform: "client_chat",
    ...o,
  }) as unknown as ActivityProfile;

const goal = (o: Partial<GoalSlim> = {}): GoalSlim => ({
  id: "goal-1",
  title: "Ship the release",
  status: "active",
  linkedDefinitionCount: 0,
  recentCompletionRate: 0,
  lastReviewedAt: null,
  ...o,
});

describe("proactive nudge pipeline — produced then focus-gated", () => {
  it("produces a goal check-in nudge from a real awake profile + actionable goal", () => {
    const actions = planGoalCheckIns(profile(), [goal()], null, "UTC", NOW);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("goal_check_in");
    expect(actions[0]?.status).toBe("pending");
    expect(actions[0]?.goalId).toBe("goal-1");
  });

  it("yields no nudge while sleeping (no signal — distinct from a broken pipeline)", () => {
    expect(
      planGoalCheckIns(
        profile({ isCurrentlySleeping: true }),
        [goal()],
        null,
        "UTC",
        NOW,
      ),
    ).toHaveLength(0);
  });

  it("does not flood: at most one goal check-in across many goals", () => {
    const actions = planGoalCheckIns(
      profile(),
      [goal({ id: "a" }), goal({ id: "b" }), goal({ id: "c" })],
      null,
      "UTC",
      NOW,
    );
    expect(actions).toHaveLength(1);
  });

  it("dispatches the produced nudge when free, defers it during a focus session", () => {
    const produced = planGoalCheckIns(profile(), [goal()], null, "UTC", NOW);
    expect(produced).toHaveLength(1);

    const free = partitionFocusDeferredActions(produced, false);
    expect(free.dispatch).toHaveLength(1);
    expect(free.deferred).toHaveLength(0);

    const focused = partitionFocusDeferredActions(produced, true);
    expect(focused.dispatch).toHaveLength(0);
    expect(focused.deferred.map((a) => a.kind)).toEqual(["goal_check_in"]);
  });
});

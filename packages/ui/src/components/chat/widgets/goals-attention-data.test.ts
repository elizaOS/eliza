/**
 * Unit tests for goals attention data: validates wire parsing, filtering, and priority ranking.
 */
import { describe, expect, it } from "vitest";
import {
  type AttentionGoal,
  attentionCount,
  goalsEqual,
  liveGoals,
  mostUrgentGoal,
  parseGoals,
} from "./goals-attention-data.ts";

describe("goals-attention-data", () => {
  it("parses valid wire payload into AttentionGoal items", () => {
    const payload = {
      goals: [
        {
          goal: {
            id: "g-1",
            title: "Ship 20 PRs",
            status: "active",
            reviewState: "at_risk",
          },
        },
        {
          goal: {
            id: "g-2",
            title: "Documentation update",
            status: "archived",
            reviewState: "idle",
          },
        },
      ],
    };

    const parsed = parseGoals(payload);
    expect(parsed.length).toBe(2);
    expect(parsed[0].id).toBe("g-1");
    expect(parsed[0].reviewState).toBe("at_risk");
  });

  it("filters live goals excluding archived and satisfied goals", () => {
    const goals: AttentionGoal[] = [
      { id: "1", title: "A", status: "active", reviewState: "idle" },
      { id: "2", title: "B", status: "archived", reviewState: "idle" },
      { id: "3", title: "C", status: "satisfied", reviewState: "idle" },
    ];

    const live = liveGoals(goals);
    expect(live.map((g) => g.id)).toEqual(["1"]);
  });

  it("selects most urgent goal preferring at_risk over needs_attention", () => {
    const goals: AttentionGoal[] = [
      {
        id: "1",
        title: "Task 1",
        status: "active",
        reviewState: "needs_attention",
      },
      { id: "2", title: "Task 2", status: "active", reviewState: "at_risk" },
    ];

    const urgent = mostUrgentGoal(goals);
    expect(urgent?.id).toBe("2");
    expect(attentionCount(goals)).toBe(2);
  });

  it("compares goals equality shallowly", () => {
    const g1: AttentionGoal[] = [
      { id: "1", title: "A", status: "active", reviewState: "idle" },
    ];
    const g2: AttentionGoal[] = [
      { id: "1", title: "A", status: "active", reviewState: "idle" },
    ];
    const g3: AttentionGoal[] = [
      { id: "1", title: "B", status: "active", reviewState: "idle" },
    ];

    expect(goalsEqual(g1, g2)).toBe(true);
    expect(goalsEqual(g1, g3)).toBe(false);
  });
});

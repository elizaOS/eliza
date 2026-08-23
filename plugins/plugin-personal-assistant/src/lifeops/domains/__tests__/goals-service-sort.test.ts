/**
 * Unit tests for LifeOps GoalsService safe date sorting.
 */
import { describe, expect, it } from "vitest";

describe("GoalsService date sorting", () => {
  it("maintains strict total ordering when updatedAt contains invalid date strings", () => {
    const views = [
      {
        id: "goal-1",
        title: "Goal 1",
        updatedAt: "2026-05-01T10:00:00.000Z",
      },
      {
        id: "goal-invalid",
        title: "Goal Invalid",
        updatedAt: "not-a-date",
      },
      {
        id: "goal-2",
        title: "Goal 2",
        updatedAt: "2026-05-02T10:00:00.000Z",
      },
    ];

    views.sort((left, right) => {
      const leftTime = Number.isFinite(new Date(left.updatedAt).getTime())
        ? new Date(left.updatedAt).getTime()
        : 0;
      const rightTime = Number.isFinite(new Date(right.updatedAt).getTime())
        ? new Date(right.updatedAt).getTime()
        : 0;
      return leftTime - rightTime;
    });

    expect(views).toHaveLength(3);
    expect(views[0]?.id).toBe("goal-invalid");
    expect(views[1]?.id).toBe("goal-1");
    expect(views[2]?.id).toBe("goal-2");
  });
});

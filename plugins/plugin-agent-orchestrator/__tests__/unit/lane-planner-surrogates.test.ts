import { describe, expect, it } from "vitest";
import { createDeterministicLanePlan } from "../../src/services/lane-planner.ts";

describe("lane planner surrogate safety", () => {
  it("preserves surrogate pairs when constructing lane titles", () => {
    // "x" (1 char) + "🚀" (2 chars * 50 = 100 chars) -> bisects at 80
    const longTask = "x" + "🚀".repeat(50);
    const plan = createDeterministicLanePlan({
      task: longTask,
      lanes: [{ task: longTask }],
    });

    expect(plan.lanes.length).toBe(1);
    const title = plan.lanes[0].title;
    expect(title.length).toBe(79);
    for (const char of title) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import { schedulingAction } from "../src/actions/scheduling.js";

describe("life-ops scheduling action contract", () => {
  it("keeps SCHEDULING scoped to negotiation workflows", () => {
    expect(schedulingAction.suppressPostActionContinuation).toBe(true);
    expect(schedulingAction.similes ?? []).not.toContain("SCHEDULE_MEETING");
    expect(schedulingAction.similes ?? []).not.toContain("COORDINATE_SCHEDULE");
    expect(schedulingAction.description).toContain("existing proposal workflow");
  });
});

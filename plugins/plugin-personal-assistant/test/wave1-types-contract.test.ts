/**
 * Regression contract test ensuring wave1-types re-exports match @elizaos/plugin-scheduling.
 */
import type { ScheduledTaskInput as CanonicalScheduledTaskInput } from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import type { ScheduledTaskInput } from "../src/lifeops/wave1-types.ts";

describe("wave1-types contracts", () => {
  it("type assignability round-trips with canonical scheduled-task shapes", () => {
    const input: ScheduledTaskInput = {
      kind: "reminder",
      promptInstructions: "Check in with the user",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "test",
      ownerVisible: true,
    };

    const canonicalInput: CanonicalScheduledTaskInput = input;
    expect(canonicalInput.kind).toBe("reminder");
    expect(canonicalInput.priority).toBe("medium");
  });
});

import { describe, expect, it } from "vitest";
import { determineFailureMode } from "./action-selection-runner.ts";

describe("action selection benchmark scoring", () => {
  it("does not label a correct completed action as failed just because a later error was observed", () => {
    expect(
      determineFailureMode({
        pass: true,
        expected: "LIFE",
        actual: "LIFE",
        planned: "LIFE",
        filtered: [],
        hadError: true,
      }),
    ).toBe("passed");
  });

  it("keeps provider failures distinct from no-action success", () => {
    expect(
      determineFailureMode({
        pass: false,
        expected: null,
        actual: null,
        planned: null,
        filtered: [],
        hadError: true,
      }),
    ).toBe("error");
  });
});

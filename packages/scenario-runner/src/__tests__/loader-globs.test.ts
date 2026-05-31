import { describe, expect, it } from "vitest";
import { scenarioFileGlobAlternatives } from "../loader";

describe("scenarioFileGlobAlternatives", () => {
  it("treats globstar directory segments as zero-or-more directories", () => {
    expect(
      scenarioFileGlobAlternatives(
        "packages/test/scenarios/lifeops.*/**/*.scenario.ts",
      ),
    ).toEqual([
      "packages/test/scenarios/lifeops.*/**/*.scenario.ts",
      "packages/test/scenarios/lifeops.*/*.scenario.ts",
    ]);
  });

  it("keeps non-globstar globs unchanged", () => {
    expect(
      scenarioFileGlobAlternatives(
        "packages/test/scenarios/lifeops.*/*.scenario.ts",
      ),
    ).toEqual(["packages/test/scenarios/lifeops.*/*.scenario.ts"]);
  });
});

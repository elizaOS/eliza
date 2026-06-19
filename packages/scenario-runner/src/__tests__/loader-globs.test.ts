import { describe, expect, it } from "vitest";
import {
  scenarioFileGlobAlternatives,
  scenarioFileMatchesGlob,
} from "../loader";

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

describe("scenarioFileMatchesGlob", () => {
  const cwd = "/repo";

  it("matches root-prefixed directories containing dots with single-star globs", () => {
    expect(
      scenarioFileMatchesGlob(
        "/repo/packages/test/scenarios/lifeops.push/push.urgent-bypasses-do-not-disturb.scenario.ts",
        "packages/test/scenarios/lifeops.*/*.scenario.ts",
        cwd,
      ),
    ).toBe(true);
  });

  it("treats globstar directory segments as zero-or-more directories", () => {
    expect(
      scenarioFileMatchesGlob(
        "/repo/packages/test/scenarios/lifeops.push/push.urgent-bypasses-do-not-disturb.scenario.ts",
        "packages/test/scenarios/lifeops.*/**/*.scenario.ts",
        cwd,
      ),
    ).toBe(true);
    expect(
      scenarioFileMatchesGlob(
        "/repo/packages/test/scenarios/lifeops.push/nested/push.urgent-bypasses-do-not-disturb.scenario.ts",
        "packages/test/scenarios/lifeops.*/**/*.scenario.ts",
        cwd,
      ),
    ).toBe(true);
  });

  it("does not let single-star globs cross directory separators", () => {
    expect(
      scenarioFileMatchesGlob(
        "/repo/packages/test/scenarios/lifeops.push/nested/push.urgent-bypasses-do-not-disturb.scenario.ts",
        "packages/test/scenarios/lifeops.*/*.scenario.ts",
        cwd,
      ),
    ).toBe(false);
  });

  it("matches absolute globs against absolute file paths", () => {
    expect(
      scenarioFileMatchesGlob(
        "/repo/packages/test/scenarios/lifeops.push/push.urgent-bypasses-do-not-disturb.scenario.ts",
        "/repo/packages/test/scenarios/lifeops.*/*.scenario.ts",
        cwd,
      ),
    ).toBe(true);
  });
});

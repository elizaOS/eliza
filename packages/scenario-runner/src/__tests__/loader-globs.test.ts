/** Unit tests for the loader's file-glob matching (loader.ts): globstar segment expansion and `scenarioFileMatchesGlob`, pure string logic with no filesystem. */
import { describe, expect, it } from "vitest";
import {
  scenarioFileGlobAlternatives,
  scenarioFileMatchesGlob,
} from "../loader";

describe("scenarioFileGlobAlternatives", () => {
  it("treats globstar directory segments as zero-or-more directories", () => {
    expect(
      scenarioFileGlobAlternatives(
        "plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.*/**/*.scenario.ts",
      ),
    ).toEqual([
      "plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.*/**/*.scenario.ts",
      "plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.*/*.scenario.ts",
    ]);
  });

  it("keeps non-globstar globs unchanged", () => {
    expect(
      scenarioFileGlobAlternatives(
        "plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.*/*.scenario.ts",
      ),
    ).toEqual([
      "plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.*/*.scenario.ts",
    ]);
  });
});

describe("scenarioFileMatchesGlob", () => {
  const cwd = "/repo";

  it("matches root-prefixed directories containing dots with single-star globs", () => {
    expect(
      scenarioFileMatchesGlob(
        "/repo/plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.push/push.urgent-bypasses-do-not-disturb.scenario.ts",
        "plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.*/*.scenario.ts",
        cwd,
      ),
    ).toBe(true);
  });

  it("treats globstar directory segments as zero-or-more directories", () => {
    expect(
      scenarioFileMatchesGlob(
        "/repo/plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.push/push.urgent-bypasses-do-not-disturb.scenario.ts",
        "plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.*/**/*.scenario.ts",
        cwd,
      ),
    ).toBe(true);
    expect(
      scenarioFileMatchesGlob(
        "/repo/plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.push/nested/push.urgent-bypasses-do-not-disturb.scenario.ts",
        "plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.*/**/*.scenario.ts",
        cwd,
      ),
    ).toBe(true);
  });

  it("does not let single-star globs cross directory separators", () => {
    expect(
      scenarioFileMatchesGlob(
        "/repo/plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.push/nested/push.urgent-bypasses-do-not-disturb.scenario.ts",
        "plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.*/*.scenario.ts",
        cwd,
      ),
    ).toBe(false);
  });

  it("matches absolute globs against absolute file paths", () => {
    expect(
      scenarioFileMatchesGlob(
        "/repo/plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.push/push.urgent-bypasses-do-not-disturb.scenario.ts",
        "/repo/plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.*/*.scenario.ts",
        cwd,
      ),
    ).toBe(true);
  });
});

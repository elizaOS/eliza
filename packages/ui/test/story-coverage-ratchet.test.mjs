/**
 * Verifies that the story ratchet tracks uncovered component identities while
 * allowing intentional deletion of components that previously had stories.
 */

import { describe, expect, it } from "vitest";
import {
  extractLocalStoryImports,
  findStoryCoverageRegressions,
  resolveLocalStoryImport,
} from "../scripts/story-coverage-ratchet.mjs";

describe("story coverage ratchet", () => {
  it("recognizes components imported by a centralized story", () => {
    expect(
      extractLocalStoryImports(`
        import type { Meta } from "@storybook/react";
        import { HomeScreen } from "./HomeScreen";
        import "./story.css";
      `),
    ).toEqual(["./HomeScreen", "./story.css"]);
    expect(
      resolveLocalStoryImport(
        "/repo/src/HomeDashboard.stories.tsx",
        "./HomeScreen",
        (candidate) => candidate === "/repo/src/HomeScreen.tsx",
      ),
    ).toBe("/repo/src/HomeScreen.tsx");
  });

  it("allows deletion of a covered component", () => {
    expect(
      findStoryCoverageRegressions(
        {
          componentFiles: 9,
          withStories: 7,
          missingStories: 2,
          missing: ["src/components/A.tsx", "src/components/B.tsx"],
        },
        {
          componentFiles: 10,
          withStories: 8,
          missingStories: 2,
          missing: ["src/components/A.tsx", "src/components/B.tsx"],
        },
      ),
    ).toEqual([]);
  });

  it("rejects a new gap even when another missing component was removed", () => {
    expect(
      findStoryCoverageRegressions(
        {
          componentFiles: 10,
          withStories: 8,
          missingStories: 2,
          missing: ["src/components/B.tsx", "src/components/New.tsx"],
        },
        {
          componentFiles: 10,
          withStories: 8,
          missingStories: 2,
          missing: ["src/components/A.tsx", "src/components/B.tsx"],
        },
      ),
    ).toEqual(["src/components/New.tsx"]);
  });

  it("supports the prior count-only baseline until it is regenerated", () => {
    expect(
      findStoryCoverageRegressions(
        { missingStories: 2, missing: ["a", "b"] },
        { missingStories: 2 },
      ),
    ).toEqual([]);
    expect(
      findStoryCoverageRegressions(
        { missingStories: 3, missing: ["a", "b", "c"] },
        { missingStories: 2 },
      ),
    ).toEqual(["1 new missing story"]);
  });
});

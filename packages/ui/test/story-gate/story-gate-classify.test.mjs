/** Proves Story Gate classifies render, console, and accessibility failures without baselines. */

import { describe, expect, it } from "vitest";
import { classifyStoryGateFailures } from "./run-story-gate.mjs";

describe("Story Gate failure classification", () => {
  it("accepts healthy and runtime-dependent stories with no hard signals", () => {
    expect(
      classifyStoryGateFailures({
        results: [
          {
            id: "healthy",
            verdict: "good",
            issues: [],
            consoleErrors: [],
            a11y: [],
          },
          {
            id: "runtime-dependent",
            verdict: "needs-runtime",
            issues: ["needs-runtime: AppProvider"],
            consoleErrors: [],
            a11y: [],
          },
          {
            id: "static-public-asset",
            verdict: "good",
            issues: [],
            consoleErrors: [
              "Failed to load resource: the server responded with a status of 404 (Not Found)",
            ],
            a11y: [],
          },
          {
            id: "missing-app-provider",
            verdict: "good",
            issues: [],
            consoleErrors: [
              "Error: useAppSelector used before AppProvider rendered",
            ],
            a11y: [],
          },
        ],
      }).failures,
    ).toEqual([]);
  });

  it("fails directly on broken renders, console errors, and axe violations", () => {
    expect(
      classifyStoryGateFailures({
        results: [
          {
            id: "broken-story",
            verdict: "broken",
            issues: ["story-threw: boom"],
            consoleErrors: [],
            a11y: [],
          },
          {
            id: "console-story",
            verdict: "good",
            issues: [],
            consoleErrors: ["request 123 failed"],
            a11y: [],
          },
          {
            id: "a11y-story",
            verdict: "good",
            issues: [],
            consoleErrors: [],
            a11y: [{ id: "aria-required-attr" }, { id: "aria-required-attr" }],
          },
        ],
      }).failures,
    ).toEqual([
      {
        id: "broken-story",
        kind: "broken",
        detail: "story-threw: boom",
      },
      {
        id: "console-story",
        kind: "console-error",
        detail: "request <n> failed",
      },
      {
        id: "a11y-story",
        kind: "a11y-violation",
        detail: "aria-required-attr",
      },
    ]);
  });
});

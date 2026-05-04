import { describe, expect, it } from "vitest";
import { shouldRestoreAgentsListAfterAppLaunch } from "./app-manager-agents-list-guard.js";

describe("shouldRestoreAgentsListAfterAppLaunch", () => {
  it("restores when an app replaces the primary user character", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(
        [{ name: "Chen", id: "main" }],
        [{ name: "Hyperscape Explorer", id: "main" }],
      ),
    ).toBe(true);
  });

  it("allows apps to append agents without replacing existing entries", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(
        [{ name: "Chen", id: "main" }],
        [
          { name: "Chen", id: "main" },
          { name: "Hyperscape Explorer", id: "hyperscape" },
        ],
      ),
    ).toBe(false);
  });

  it("restores an absent agents.list when an app creates one", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(undefined, [
        { name: "Hyperscape Explorer", id: "hyperscape" },
      ]),
    ).toBe(true);
  });
});

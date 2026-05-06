import { describe, expect, it } from "vitest";
import { shouldRestoreAgentsListAfterAppLaunch } from "./app-manager-agents-list-guard.js";

describe("shouldRestoreAgentsListAfterAppLaunch", () => {
  it("restores when an app populates agents.list for a preset-backed agent", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(undefined, [
        { name: "Hyperscape Explorer" },
      ]),
    ).toBe(true);
  });

  it("restores when an app replaces the user's existing first agent", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(
        [{ name: "Chen", system: "original" }],
        [{ name: "Hyperscape Explorer" }],
      ),
    ).toBe(true);
  });

  it("does not restore when an app only appends a supplemental agent", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(
        [{ name: "Chen" }],
        [{ name: "Chen" }, { name: "Hyperscape Explorer" }],
      ),
    ).toBe(false);
  });
});

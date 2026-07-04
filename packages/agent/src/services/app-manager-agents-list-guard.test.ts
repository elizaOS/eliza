/**
 * Unit tests for `shouldRestoreAgentsListAfterAppLaunch` — a pure, deterministic
 * predicate; each case is a fixed before/after agents-list pair.
 */
import { describe, expect, it } from "vitest";
import { shouldRestoreAgentsListAfterAppLaunch } from "./app-manager-agents-list-guard.ts";

describe("shouldRestoreAgentsListAfterAppLaunch", () => {
  it("restores when an app populates agents.list for a preset-backed agent", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(undefined, [
        { name: "Sample Explorer" },
      ]),
    ).toBe(true);
  });

  it("restores when an app replaces the user's existing first agent", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(
        [{ name: "Chen", system: "original" }],
        [{ name: "Sample Explorer" }],
      ),
    ).toBe(true);
  });

  it("does not restore when an app only appends a supplemental agent", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(
        [{ name: "Chen" }],
        [{ name: "Chen" }, { name: "Sample Explorer" }],
      ),
    ).toBe(false);
  });
});

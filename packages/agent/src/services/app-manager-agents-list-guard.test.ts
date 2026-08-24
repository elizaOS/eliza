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

  it("restores when an app populates an explicitly empty agents.list", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch([], [{ name: "Sample Explorer" }]),
    ).toBe(true);
  });

  it("does not restore when an explicitly empty agents.list stays empty", () => {
    expect(shouldRestoreAgentsListAfterAppLaunch([], [])).toBe(false);
  });

  it("returns false when after is not an array", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch([{ name: "Chen" }], null),
    ).toBe(false);
    expect(
      shouldRestoreAgentsListAfterAppLaunch([{ name: "Chen" }], undefined),
    ).toBe(false);
    expect(
      shouldRestoreAgentsListAfterAppLaunch([{ name: "Chen" }], {
        name: "Sample Explorer",
      }),
    ).toBe(false);
  });

  it("restores when an app removes agents (after.length < before.length)", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(
        [{ name: "Chen" }, { name: "Agent 2" }],
        [{ name: "Chen" }],
      ),
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

  it("restores when an app mutates an existing agent in the list", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(
        [{ name: "Chen" }, { name: "Agent 2", model: "v1" }],
        [{ name: "Chen" }, { name: "Agent 2", model: "v2" }],
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

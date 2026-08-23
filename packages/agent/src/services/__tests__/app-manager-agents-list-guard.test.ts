import { describe, expect, it } from "vitest";
import { shouldRestoreAgentsListAfterAppLaunch } from "./app-manager-agents-list-guard.ts";

describe("shouldRestoreAgentsListAfterAppLaunch", () => {
  it("restores when the app populates a previously-empty list", () => {
    expect(
      shouldRestoreAgentsListAfterAppLaunch(undefined, [{ id: "a" }]),
    ).toBe(true);
  });

  it("does not restore when nothing changed", () => {
    const before = [{ id: "a" }];
    expect(shouldRestoreAgentsListAfterAppLaunch(before, before)).toBe(false);
  });

  it("restores when the first agent is replaced", () => {
    const before = [{ id: "a" }];
    const after = [{ id: "b" }];
    expect(shouldRestoreAgentsListAfterAppLaunch(before, after)).toBe(true);
  });

  it("does not restore when a supplemental agent is appended", () => {
    const before = [{ id: "a" }];
    const after = [{ id: "a" }, { id: "b" }];
    expect(shouldRestoreAgentsListAfterAppLaunch(before, after)).toBe(false);
  });

  it("restores when the list shrinks", () => {
    const before = [{ id: "a" }, { id: "b" }];
    const after = [{ id: "a" }];
    expect(shouldRestoreAgentsListAfterAppLaunch(before, after)).toBe(true);
  });

  it("rejects non-array after values", () => {
    expect(shouldRestoreAgentsListAfterAppLaunch([], "junk" as never)).toBe(
      false,
    );
    expect(shouldRestoreAgentsListAfterAppLaunch(undefined, null)).toBe(false);
  });
});

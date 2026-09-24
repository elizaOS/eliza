/**
 * Schema-level tests for the platform-gated deferral field (#10757).
 *
 * A `deferred` annotation marks a live-only scenario that cannot run in any
 * current lane because the platform/runner it needs does not exist yet. The
 * schema validates its shape eagerly (at definition time) so a typo fails there,
 * not in CI, and forbids pairing it with the keyless PR-deterministic lane.
 */

import { describe, expect, it } from "vitest";
import { scenario, scenarioDeferral } from "../schema/index.js";

const base = {
  id: "x.deferred",
  title: "x",
  domain: "x",
  turns: [],
} as const;

describe("scenarioDeferral (#10757)", () => {
  it("returns null when the scenario is not deferred", () => {
    expect(scenarioDeferral({ ...base })).toBeNull();
  });

  it("resolves reason + runner for a valid deferral", () => {
    const value = {
      ...base,
      lane: "live-only" as const,
      deferred: {
        reason: "requires macOS",
        runner: "eliza-e2e-macos",
      },
    };
    expect(scenarioDeferral(value)).toEqual({
      reason: "requires macOS",
      runner: "eliza-e2e-macos",
    });
  });

  it("allows a reason without a runner", () => {
    const value = { ...base, deferred: { reason: "needs a device" } };
    expect(scenarioDeferral(value)).toEqual({ reason: "needs a device" });
  });

  it("throws when the reason is missing or blank", () => {
    expect(() =>
      scenarioDeferral({ ...base, deferred: { runner: "x" } }),
    ).toThrow(/invalid `deferred`/);
    expect(() =>
      scenarioDeferral({ ...base, deferred: { reason: "   " } }),
    ).toThrow(/invalid `deferred`/);
  });

  it("forbids a deferred scenario from claiming the pr-deterministic lane", () => {
    expect(() =>
      scenarioDeferral({
        ...base,
        lane: "pr-deterministic",
        deferred: { reason: "requires macOS" },
      }),
    ).toThrow(/must be live-only/);
  });

  it("scenario() validates the deferral eagerly at definition time", () => {
    expect(() =>
      scenario({
        ...base,
        lane: "pr-deterministic",
        deferred: { reason: "requires macOS" },
      }),
    ).toThrow(/must be live-only/);
    // A well-formed deferred scenario passes through unchanged.
    const ok = scenario({
      ...base,
      lane: "live-only",
      deferred: { reason: "requires macOS", runner: "eliza-e2e-macos" },
    });
    expect(ok.deferred?.reason).toBe("requires macOS");
  });
});

/**
 * Pure-transform coverage for the laddered progression rule (#12284 item 10).
 * No runtime graph: exercises `deriveTarget` directly, asserting that each
 * completed occurrence advances one rung and that the ladder clamps at its top.
 */
import { describe, expect, it } from "vitest";
import type { LifeOpsProgressionRule } from "../contracts/index.js";
import { deriveTarget } from "./engine.ts";

const ladder: LifeOpsProgressionRule = {
  kind: "laddered",
  metric: "pages_read",
  rungs: ["Read one page", "Read for five minutes", "Read a full chapter"],
};

describe("deriveTarget — laddered progression", () => {
  it("returns rung 0 (the two-minute step) at completedCountBefore 0", () => {
    expect(deriveTarget(ladder, 0)).toEqual({
      kind: "laddered",
      metric: "pages_read",
      rung: 0,
      rungTitle: "Read one page",
      rungsTotal: 3,
      unit: null,
      completedCountBefore: 0,
    });
  });

  it("advances one rung per completed occurrence", () => {
    expect(deriveTarget(ladder, 1)).toMatchObject({
      rung: 1,
      rungTitle: "Read for five minutes",
    });
    expect(deriveTarget(ladder, 2)).toMatchObject({
      rung: 2,
      rungTitle: "Read a full chapter",
    });
  });

  it("clamps at the final rung once the ladder is exhausted", () => {
    // Fourth+ completion stays on the last (largest) rung rather than running
    // off the end of the array.
    expect(deriveTarget(ladder, 3)).toMatchObject({
      rung: 2,
      rungTitle: "Read a full chapter",
    });
    expect(deriveTarget(ladder, 99)).toMatchObject({
      rung: 2,
      rungTitle: "Read a full chapter",
    });
  });

  it("single-rung ladder is the degenerate pure-shrink case", () => {
    const shrinkOnly: LifeOpsProgressionRule = {
      kind: "laddered",
      metric: "tidy",
      rungs: ["Put away one item"],
    };
    // Every occurrence surfaces the same small step; it never grows.
    expect(deriveTarget(shrinkOnly, 0)).toMatchObject({
      rung: 0,
      rungTitle: "Put away one item",
      rungsTotal: 1,
    });
    expect(deriveTarget(shrinkOnly, 5)).toMatchObject({
      rung: 0,
      rungTitle: "Put away one item",
    });
  });

  it("carries an explicit unit when supplied", () => {
    const withUnit: LifeOpsProgressionRule = {
      kind: "laddered",
      metric: "steps",
      rungs: ["Walk to the mailbox"],
      unit: "minutes",
    };
    expect(deriveTarget(withUnit, 0)).toMatchObject({ unit: "minutes" });
  });

  it("returns null for a none rule (no progression surfaced)", () => {
    expect(deriveTarget({ kind: "none" }, 0)).toBeNull();
  });
});

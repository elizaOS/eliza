/**
 * Validation coverage for the laddered progression rule (#12284 item 10).
 * No runtime graph: exercises `normalizeProgressionRule` directly, asserting it
 * accepts a well-formed ladder and fails fast (no silent default) on bad input.
 */
import { describe, expect, it } from "vitest";
import type { LifeOpsProgressionRule } from "../contracts/index.js";
import { normalizeProgressionRule } from "./service-normalize-task.ts";

describe("normalizeProgressionRule — laddered", () => {
  it("accepts a valid laddered rule and trims rung titles", () => {
    const rule: LifeOpsProgressionRule = {
      kind: "laddered",
      metric: "pages_read",
      rungs: ["  Read one page  ", "Read a chapter"],
      unit: "pages",
    };
    expect(normalizeProgressionRule(rule)).toEqual({
      kind: "laddered",
      metric: "pages_read",
      rungs: ["Read one page", "Read a chapter"],
      unit: "pages",
    });
  });

  it("accepts a single-rung ladder (degenerate pure-shrink)", () => {
    expect(
      normalizeProgressionRule({
        kind: "laddered",
        metric: "tidy",
        rungs: ["Put away one item"],
      }),
    ).toEqual({
      kind: "laddered",
      metric: "tidy",
      rungs: ["Put away one item"],
    });
  });

  it("throws on an empty rungs array — no silent default", () => {
    expect(() =>
      normalizeProgressionRule({
        kind: "laddered",
        metric: "pages_read",
        rungs: [],
      }),
    ).toThrow(/rungs must be a non-empty array/);
  });

  it("throws on a missing metric", () => {
    expect(() =>
      normalizeProgressionRule({
        kind: "laddered",
        metric: "",
        rungs: ["Read one page"],
      }),
    ).toThrow(/progressionRule\.metric/);
  });

  it("throws when a rung is empty/blank", () => {
    expect(() =>
      normalizeProgressionRule({
        kind: "laddered",
        metric: "pages_read",
        rungs: ["Read one page", "   "],
      }),
    ).toThrow(/progressionRule\.rungs\[1\]/);
  });
});

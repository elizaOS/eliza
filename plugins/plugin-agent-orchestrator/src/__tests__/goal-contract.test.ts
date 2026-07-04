/**
 * Verifies buildDefaultAcceptanceCriteria (#8896).
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDefaultAcceptanceCriteria,
  shouldRequireGoalContract,
} from "../services/goal-contract.js";

describe("buildDefaultAcceptanceCriteria (#8896)", () => {
  it("returns the base coding criteria for a plain coding task", () => {
    const criteria = buildDefaultAcceptanceCriteria("ship the thing", "coding");
    expect(criteria.length).toBe(4);
    expect(criteria.some((c) => c.includes("typechecks"))).toBe(true);
    expect(criteria.some((c) => c.includes("tests pass"))).toBe(true);
    expect(criteria.some((c) => c.includes("diff is coherent"))).toBe(true);
  });

  it("appends view-create extras (registered view + screenshot)", () => {
    const criteria = buildDefaultAcceptanceCriteria(
      "add a view",
      "view-create",
    );
    expect(criteria.length).toBe(6);
    expect(criteria.some((c) => c.includes("GET /api/views"))).toBe(true);
    expect(criteria.some((c) => c.toLowerCase().includes("screenshot"))).toBe(
      true,
    );
  });

  it("appends app-build extras (HTTP 200 smoke)", () => {
    const criteria = buildDefaultAcceptanceCriteria("build app", "app-build");
    expect(criteria.some((c) => c.includes("HTTP 200"))).toBe(true);
  });

  it("falls back to base criteria for an unknown/undefined kind", () => {
    expect(buildDefaultAcceptanceCriteria("x", "mystery").length).toBe(4);
    expect(buildDefaultAcceptanceCriteria("x").length).toBe(4);
  });
});

describe("shouldRequireGoalContract", () => {
  const prev = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
  afterEach(() => {
    if (prev === undefined) delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
    else process.env.ELIZA_REQUIRE_GOAL_CONTRACT = prev;
  });

  it("defaults on", () => {
    delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
    expect(shouldRequireGoalContract()).toBe(true);
  });

  it("opts out only on explicit '0'", () => {
    process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
    expect(shouldRequireGoalContract()).toBe(false);
    process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "1";
    expect(shouldRequireGoalContract()).toBe(true);
  });
});

/**
 * Slug-identity veto for the near-duplicate spawn guard (live false positive:
 * "tide-glass" blocked against a parked "ember-tide" on the shared "tide"
 * boilerplate token). Deterministic — pure text functions.
 */

import { describe, expect, it } from "vitest";
import { goalSimilarity, hasDistinctSlugIdentity } from "../actions/tasks.js";

const BOILER = "build a one-file page in the shared route workdir called";

describe("hasDistinctSlugIdentity", () => {
  it("distinct slugs veto despite boilerplate similarity crossing the threshold", () => {
    const a = `${BOILER} tide-glass`;
    const b = `${BOILER} ember-tide`;
    expect(goalSimilarity(a, b)).toBeGreaterThanOrEqual(0.6);
    expect(hasDistinctSlugIdentity(a, b)).toBe(true);
  });

  it("a shared slug is NOT vetoed — a genuine re-ask still matches", () => {
    expect(
      hasDistinctSlugIdentity(`${BOILER} ember-tide`, `${BOILER} ember-tide`),
    ).toBe(false);
  });

  it("texts without slugs never veto (guard behavior unchanged)", () => {
    expect(
      hasDistinctSlugIdentity(
        "fix the flaky scheduler test",
        "fix the scheduler flake",
      ),
    ).toBe(false);
  });
});

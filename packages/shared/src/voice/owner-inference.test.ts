/**
 * Tests speaker owner-candidate inference (resolveOwnerCandidate) over a stream
 * of confidence-scored observations: dominance/share/margin thresholds, tie
 * ambiguity, the confidence floor and unrecognized-speaker filtering, and the
 * undecided path. Pure function.
 */
import { describe, expect, it } from "vitest";
import { resolveOwnerCandidate } from "./owner-inference";

const C = (entityId: string | null, confidence = 0.9) => ({
  entityId,
  confidence,
});

describe("resolveOwnerCandidate", () => {
  it("stays undecided with too few observations", () => {
    const r = resolveOwnerCandidate([C("owner"), C("owner")]);
    expect(r.ownerEntityId).toBeNull();
    expect(r.qualifyingObservations).toBe(2);
    expect(r.reason).toMatch(/insufficient/);
  });

  it("names a dominant speaker as the owner", () => {
    const r = resolveOwnerCandidate([
      C("owner"),
      C("owner"),
      C("owner"),
      C("guest"),
    ]);
    expect(r.ownerEntityId).toBe("owner");
    expect(r.share).toBeGreaterThan(0.5);
    expect(r.reason).toMatch(/dominant/);
  });

  it("stays undecided on a tie (two-equals household)", () => {
    const r = resolveOwnerCandidate([C("a"), C("a"), C("b"), C("b")]);
    expect(r.ownerEntityId).toBeNull();
    expect(r.reason).toMatch(/ambiguous/);
  });

  it("ignores low-confidence and unrecognized observations", () => {
    const r = resolveOwnerCandidate([
      C("owner", 0.95),
      C("owner", 0.92),
      C("owner", 0.91),
      C("intruder", 0.5), // below floor → ignored
      C(null, 0.99), // unrecognized → ignored
    ]);
    expect(r.ownerEntityId).toBe("owner");
    expect(r.qualifyingObservations).toBe(3);
  });

  it("respects a stricter margin requirement", () => {
    const obs = [C("owner"), C("owner"), C("guest")];
    // Default margin 1: owner (1.8) − guest (0.9) = 0.9 < 1 → undecided.
    expect(resolveOwnerCandidate(obs).ownerEntityId).toBeNull();
    // Looser margin: now decides.
    expect(resolveOwnerCandidate(obs, { minMargin: 0.5 }).ownerEntityId).toBe(
      "owner",
    );
  });

  it("decides for the owner once they clearly dominate over time", () => {
    const stream = [C("owner"), C("guest"), C("owner"), C("owner"), C("owner")];
    const r = resolveOwnerCandidate(stream);
    expect(r.ownerEntityId).toBe("owner");
  });
});

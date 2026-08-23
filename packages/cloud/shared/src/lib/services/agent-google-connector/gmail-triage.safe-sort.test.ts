/**
 * Safe NaN handling for Gmail triage tiebreaker sort.
 */
import { describe, expect, it } from "vitest";

function triageSort(messages: { triageScore: number; receivedAt: string }[]) {
  return [...messages].sort((left, right) => {
    const scoreDelta = right.triageScore - left.triageScore;
    if (scoreDelta !== 0) return scoreDelta;
    const aTime = Date.parse(left.receivedAt);
    const bTime = Date.parse(right.receivedAt);
    const aSafe = Number.isFinite(aTime) ? aTime : 0;
    const bSafe = Number.isFinite(bTime) ? bTime : 0;
    return bSafe - aSafe;
  });
}

describe("gmail triage safe sort", () => {
  it("sorts by receivedAt desc when scores tied, NaN last", () => {
    const out = triageSort([
      { triageScore: 1, receivedAt: "invalid" },
      { triageScore: 1, receivedAt: "2026-01-02T00:00:00.000Z" },
      { triageScore: 1, receivedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(out[0].receivedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(out[2].receivedAt).toBe("invalid");
  });
  it("score delta precedence", () => {
    const out = triageSort([
      { triageScore: 1, receivedAt: "2026-01-02T00:00:00.000Z" },
      { triageScore: 5, receivedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(out[0].triageScore).toBe(5);
  });
  it("never returns NaN", () => {
    const r = triageSort([
      { triageScore: 1, receivedAt: "bad" },
      { triageScore: 1, receivedAt: "also-bad" },
    ]);
    expect(r.length).toBe(2);
  });
});

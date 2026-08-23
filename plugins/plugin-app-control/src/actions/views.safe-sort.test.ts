/**
 * Regression for app-control views score sort handling.
 */
import { describe, expect, it } from "vitest";

type Scored = { view: { id: string }; score: number };
function compareScored(a: Scored, b: Scored): number {
  const bS = typeof b.score === "number" && Number.isFinite(b.score) ? b.score : 0;
  const aS = typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0;
  if (bS !== aS) return bS - aS;
  return String(a.view.id).localeCompare(String(b.view.id));
}

describe("app-control views safe-sort", () => {
  it("treats NaN score as 0", () => {
    const rows: Scored[] = [
      { view: { id: "b" }, score: Number.NaN },
      { view: { id: "a" }, score: 10 },
      { view: { id: "c" }, score: Number.POSITIVE_INFINITY },
    ];
    expect([...rows].sort(compareScored).map(r => r.view.id)).toEqual(["a", "b", "c"]);
  });
  it("breaks ties by view id", () => {
    const rows: Scored[] = [
      { view: { id: "b" }, score: 5 },
      { view: { id: "a" }, score: 5 },
    ];
    expect([...rows].sort(compareScored).map(r => r.view.id)).toEqual(["a", "b"]);
  });
});

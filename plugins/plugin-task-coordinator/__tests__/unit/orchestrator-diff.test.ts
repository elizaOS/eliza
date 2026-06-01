import { describe, expect, it } from "vitest";
import { lineDiff } from "../../src/orchestrator-diff";

const compact = (old: string, next: string) =>
  lineDiff(old, next).map(
    (r) => `${r.type[0]}${r.oldLine ?? "_"}:${r.newLine ?? "_"} ${r.text}`,
  );

describe("lineDiff", () => {
  it("marks every line context when unchanged", () => {
    const rows = lineDiff("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => r.type === "context")).toBe(true);
    expect(rows.map((r) => [r.oldLine, r.newLine])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("aligns a single-line change as remove+add around shared context", () => {
    expect(compact("a\nb\nc", "a\nB\nc")).toEqual([
      "c1:1 a",
      "r2:_ b",
      "a_:2 B",
      "c3:3 c",
    ]);
  });

  it("represents an insertion as an addition between context lines", () => {
    expect(compact("a\nb\nc", "a\nb\nX\nc")).toEqual([
      "c1:1 a",
      "c2:2 b",
      "a_:3 X",
      "c3:4 c",
    ]);
  });

  it("represents a deletion as a removal between context lines", () => {
    expect(compact("a\nb\nc", "a\nc")).toEqual(["c1:1 a", "r2:_ b", "c3:2 c"]);
  });

  it("keeps old and new line numbers independent across mixed edits", () => {
    const rows = lineDiff(
      "one\ntwo\nthree\nfour",
      "one\nTWO\nthree\nfour\nfive",
    );
    const adds = rows.filter((r) => r.type === "add").map((r) => r.text);
    const removes = rows.filter((r) => r.type === "remove").map((r) => r.text);
    expect(removes).toEqual(["two"]);
    expect(adds).toEqual(["TWO", "five"]);
    // last context/added line carries new line number 5
    expect(rows.at(-1)).toMatchObject({
      type: "add",
      newLine: 5,
      text: "five",
    });
  });
});

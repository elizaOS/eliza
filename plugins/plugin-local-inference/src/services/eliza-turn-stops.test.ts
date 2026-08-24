import { describe, expect, it } from "vitest";
import {
  ELIZA_TURN_STOP_SEQUENCES,
  mergeElizaTurnStopSequences,
} from "./eliza-turn-stops";

describe("mergeElizaTurnStopSequences", () => {
  it("always includes the built-in eliza turn markers", () => {
    expect(mergeElizaTurnStopSequences(undefined)).toEqual([
      ...ELIZA_TURN_STOP_SEQUENCES,
    ]);
  });

  it("merges requested sequences with the built-ins", () => {
    const merged = mergeElizaTurnStopSequences(["<stop>", "<halt>"]);
    expect(merged).toContain("<stop>");
    expect(merged).toContain("<halt>");
    for (const builtin of ELIZA_TURN_STOP_SEQUENCES) {
      expect(merged).toContain(builtin);
    }
  });

  it("deduplicates sequences shared with the built-ins", () => {
    const merged = mergeElizaTurnStopSequences(["<end_of_turn>"]);
    const counts = merged.filter((s) => s === "<end_of_turn>").length;
    expect(counts).toBe(1);
  });

  it("drops empty-string requested stops", () => {
    const merged = mergeElizaTurnStopSequences(["", "<real>"]);
    expect(merged).not.toContain("");
    expect(merged).toContain("<real>");
  });

  it("passes whitespace-only stops through (degenerate but current behavior)", () => {
    // Current filter is `stop.length > 0`, so whitespace-only sequences are
    // NOT dropped. Pinned here so any future change to that contract is
    // deliberate and visible.
    const merged = mergeElizaTurnStopSequences(["   "]);
    expect(merged).toContain("   ");
  });

  it("keeps caller order before built-ins", () => {
    const merged = mergeElizaTurnStopSequences(["<first>", "<second>"]);
    expect(merged.indexOf("<first>")).toBeLessThan(merged.indexOf("<second>"));
    expect(merged.indexOf("<second>")).toBeLessThan(
      merged.indexOf(ELIZA_TURN_STOP_SEQUENCES[0]),
    );
  });

  it("returns a fresh array (no shared mutable state)", () => {
    const a = mergeElizaTurnStopSequences(undefined);
    const b = mergeElizaTurnStopSequences(undefined);
    expect(a).not.toBe(b);
    a.push("mutated");
    expect(b).not.toContain("mutated");
  });
});

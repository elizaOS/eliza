import { describe, expect, it } from "vitest";
import { PhraseAggregator } from "./phrase-aggregator";

function phrases(text: string): string[] {
  const aggregator = new PhraseAggregator({ preferWordBoundaryAtMax: true });
  const out: string[] = [];
  // Word-sized deltas, as the LLM stream sends them.
  for (const delta of text.match(/\S+\s*/g) ?? []) {
    out.push(...aggregator.push(delta));
  }
  const tail = aggregator.flush();
  if (tail) out.push(tail);
  return out;
}

describe("PhraseAggregator decimal numbers", () => {
  it("does not split or drop a decimal number", () => {
    expect(phrases("The total is $3.50 for the order.")).toEqual([
      "The total is $3.50 for the order.",
    ]);
    expect(phrases("Upgrade to Python 3.9")).toEqual(["Upgrade to Python 3.9"]);
  });

  it("still ends a sentence at a period after a number", () => {
    expect(phrases("Step 1. Open it. Step 2. Close it.")).toEqual([
      "Step 1.",
      "Open it.",
      "Step 2.",
      "Close it.",
    ]);
    expect(phrases("Done in 2024.\nNext")).toEqual(["Done in 2024.", "Next"]);
    expect(phrases("I have 3.")).toEqual(["I have 3."]);
  });
});

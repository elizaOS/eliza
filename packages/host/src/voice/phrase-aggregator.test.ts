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

it("emits a final short response or tail exactly once", () => {
  for (const tail of ["A", "7", "好"]) {
    expect(phrases(tail)).toEqual([tail]);
    expect(phrases(`The answer is. ${tail}`)).toEqual(["The answer is.", tail]);
  }
  const aggregator = new PhraseAggregator({ minEmitChars: 8 });
  expect(aggregator.push("okay")).toEqual([]);
  expect(aggregator.flush()).toBe("okay");
  expect(aggregator.emitted).toBe(1);
  expect(aggregator.flush()).toBeNull();
  expect(aggregator.emitted).toBe(1);
  aggregator.push("   ");
  expect(aggregator.flush()).toBeNull();
});

describe("PhraseAggregator short segments", () => {
  it("keeps a short spoken line by joining it to the next phrase", () => {
    const out = phrases("The total comes to:\n5\nThat includes tax.");
    expect(out.join(" ")).toContain("5");
    expect(out.at(-1)).toBe("5\nThat includes tax.");
  });

  it("does not prefix the next phrase with lone punctuation", () => {
    const aggregator = new PhraseAggregator({ minEmitChars: 4 });
    expect(aggregator.push("!\nHello there.")).toEqual(["Hello there."]);
  });

  it("never loses a letter or digit across push and flush", () => {
    const alphabet = [
      "a",
      "Z",
      "7",
      "好",
      ".",
      "!",
      "?",
      "\n",
      " ",
      ":",
      ";",
      "—",
      "3.5",
    ];
    let seed = 42;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const signal = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "");
    for (let round = 0; round < 500; round += 1) {
      const minEmitChars = 1 + next(6);
      const aggregator = new PhraseAggregator({
        minEmitChars,
        maxBufferChars: 8 + next(20),
        preferWordBoundaryAtMax: next(2) === 1,
      });
      let text = "";
      const out: string[] = [];
      for (let i = next(40); i > 0; i -= 1) {
        const delta = Array.from(
          { length: 1 + next(3) },
          () => alphabet[next(alphabet.length)],
        ).join("");
        text += delta;
        out.push(...aggregator.push(delta));
      }
      const tail = aggregator.flush();
      if (tail) out.push(tail);
      expect(signal(out.join(""))).toBe(signal(text));
    }
  });
});

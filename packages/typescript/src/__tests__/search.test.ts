import { describe, expect, it } from "vitest";
import { BM25 } from "../search";

describe("BM25 search", () => {
  it("indexes documents and finds matches", () => {
    const docs = [
      { text: "hello world" },
      { text: "another document" },
      { text: "world of javascript" },
    ];
    const bm = new BM25(docs, { fieldBoosts: { text: 1 } });
    const results = bm.search("world");
    expect(results[0].index).toBe(0);
  });

  it("returns topK results without sorting the full set", () => {
    const docs = [
      { text: "alpha beta beta beta" },
      { text: "alpha beta" },
      { text: "alpha" },
      { text: "gamma" },
    ];
    const bm = new BM25(docs, { fieldBoosts: { text: 1 } });
    const results = bm.search("beta", 1);
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(0);
  });

  it("omits stats when includeStats is false", () => {
    const bm = new BM25([{ text: "hello world" }], {
      fieldBoosts: { text: 1 },
    });
    const tokenizer = bm.tokenizer;
    const result = tokenizer.tokenize("hello world");
    expect(result.stats).toBeUndefined();
    const withStats = tokenizer.tokenize("hello world", true);
    expect(withStats.stats?.originalWordCount).toBe(2);
  });
});

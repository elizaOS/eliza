import { describe, expect, it } from "bun:test";
import { dedupeQuestionMarketRows } from "./questionMarketRows";

describe("dedupeQuestionMarketRows", () => {
  it("keeps one row per questionNumber", () => {
    const rows = [
      { questionNumber: 42, marketId: "market-a" },
      { questionNumber: 42, marketId: "market-b" },
      { questionNumber: 7, marketId: "market-c" },
    ];

    expect(dedupeQuestionMarketRows(rows)).toEqual([
      { questionNumber: 42, marketId: "market-a" },
      { questionNumber: 7, marketId: "market-c" },
    ]);
  });

  it("replaces a null marketId when a later match has a real marketId", () => {
    const rows = [
      { questionNumber: 42, marketId: null, yesShares: "0", noShares: "0" },
      {
        questionNumber: 42,
        marketId: "market-a",
        yesShares: "12",
        noShares: "8",
      },
    ];

    expect(dedupeQuestionMarketRows(rows)).toEqual([
      {
        questionNumber: 42,
        marketId: "market-a",
        yesShares: "12",
        noShares: "8",
      },
    ]);
  });
});

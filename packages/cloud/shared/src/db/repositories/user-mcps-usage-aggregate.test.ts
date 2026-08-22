/** Verifies exact, fail-closed parsing of persisted MCP usage money aggregates. */

import { describe, expect, test } from "bun:test";
import { parseUsageMoneyAggregate } from "./usage-money";

describe("parseUsageMoneyAggregate", () => {
  test("preserves the full NUMERIC decimal instead of rounding through a number", () => {
    expect(parseUsageMoneyAggregate("999999999999.999999", "totalAmountUsd")).toBe(
      "999999999999.999999",
    );
  });

  test("maps an empty aggregate to exact zero", () => {
    expect(parseUsageMoneyAggregate(null, "totalAmountUsd")).toBe("0");
  });

  test.each(["NaN", "Infinity", "-1", "1e3", 0.1])(
    "rejects corrupt or already-lossy aggregate %p",
    (value) => {
      expect(() => parseUsageMoneyAggregate(value, "totalAmountUsd")).toThrow(
        "Stored MCP usage aggregate is corrupt.",
      );
    },
  );
});

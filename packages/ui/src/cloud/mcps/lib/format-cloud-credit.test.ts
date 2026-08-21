/** Locks exact visible MCP cloud-credit formatting, including micro-prices. */

import { describe, expect, test } from "vitest";
import {
  formatCloudCreditUsd,
  formatMcpUsageTotal,
} from "./format-cloud-credit";

describe("formatCloudCreditUsd", () => {
  test.each([
    [1, "$1"],
    [0.0125, "$0.0125"],
    [0.000001, "$0.000001"],
  ])("renders %s as %s", (amount, expected) => {
    expect(formatCloudCreditUsd(amount)).toBe(expected);
  });

  test("fails closed for non-finite values", () => {
    expect(formatCloudCreditUsd(Number.NaN)).toBe("—");
  });

  test("renders the fee-inclusive persisted total instead of the base", () => {
    expect(formatMcpUsageTotal({ totalCloudCreditsCharged: "0.013000" })).toBe(
      "$0.013",
    );
    expect(
      formatMcpUsageTotal({ totalCloudCreditsCharged: "999999999999.999999" }),
    ).toBe("$999,999,999,999.999999");
  });
});

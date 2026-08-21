/** Locks exact visible MCP cloud-credit formatting, including micro-prices. */

import { describe, expect, test } from "vitest";
import { formatCloudCreditUsd } from "./format-cloud-credit";

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
});

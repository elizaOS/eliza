/**
 * Analytics export request and token columns use formatNumber. A count just
 * under one million rounds to the text "1000.0K" instead of "1.0M".
 */
import { expect, test } from "bun:test";
import { formatNumber } from "./export";

test("promotes an export count whose K text rounds to 1000.0", () => {
  expect(formatNumber(999950)).toBe("1.0M");
  expect(formatNumber(1500)).toBe("1.5K");
  expect(formatNumber(999949)).toBe("999.9K");
  expect(formatNumber(2_500_000)).toBe("2.5M");
});

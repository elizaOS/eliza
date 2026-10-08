/**
 * Analytics export cost columns are labeled credits and use the same totals
 * the dashboard prints with toFixed(2). formatCurrency divided by 100, so
 * 1.50 credits exported as 0.02.
 */
import { expect, test } from "bun:test";
import { formatCurrency } from "./export";

test("exports a credit total without dividing by 100", () => {
  expect(formatCurrency(1.5)).toBe("1.50");
  expect(formatCurrency(150)).toBe("150.00");
  expect(formatCurrency(0)).toBe("0.00");
  expect(formatCurrency("nope")).toBe("0.00");
});

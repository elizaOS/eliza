import { expect, test } from "bun:test";
import Decimal from "decimal.js";
import { validatePaymentAmount } from "./crypto";

test("crypto quotes accept whole cents and reject values that cannot settle exactly", () => {
  for (const amount of ["5", "5.01", "1000"])
    expect(validatePaymentAmount(new Decimal(amount)).valid).toBe(true);
  for (const amount of ["5.001", "NaN", "Infinity", "4.99", "1000.01"])
    expect(validatePaymentAmount(new Decimal(amount)).valid).toBe(false);
});

test("each rejected crypto quote carries the reason callers map to an error code", () => {
  for (const [amount, reason] of [
    ["10.005", "not_whole_cents"],
    ["NaN", "not_whole_cents"],
    ["Infinity", "not_whole_cents"],
    ["-Infinity", "not_whole_cents"],
    ["4.99", "below_minimum"],
    ["1000.01", "above_maximum"],
  ] as const) {
    expect(validatePaymentAmount(new Decimal(amount))).toMatchObject({ valid: false, reason });
  }
  expect(validatePaymentAmount(new Decimal("5.01"))).toEqual({ valid: true });
});

import { expect, test } from "bun:test";
import Decimal from "decimal.js";
import { validatePaymentAmount } from "./crypto";

test("crypto quotes accept whole cents and reject values that cannot settle exactly", () => {
  for (const amount of ["5", "5.01", "1000"])
    expect(validatePaymentAmount(new Decimal(amount)).valid).toBe(true);
  for (const amount of ["5.001", "NaN", "Infinity", "4.99", "1000.01"])
    expect(validatePaymentAmount(new Decimal(amount)).valid).toBe(false);
});

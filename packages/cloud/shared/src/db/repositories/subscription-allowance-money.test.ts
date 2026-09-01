/** Exercises exact money and expiry boundaries used by allowance funding writes. */
import { describe, expect, test } from "bun:test";
import { isAllowanceExpired } from "./subscription-allowance";
import { microsToMoney, moneyToMicros } from "./subscription-funding-reservations";

describe("subscription allowance exact money", () => {
  test("round-trips the full numeric(16,6) range without Number coercion", () => {
    expect(moneyToMicros("0.000001", "amount")).toBe(1n);
    expect(String(microsToMoney(1n))).toBe("0.000001");

    const maximum = 9_999_999_999_999_999n;
    expect(moneyToMicros("9999999999.999999", "amount")).toBe(maximum);
    expect(String(microsToMoney(maximum))).toBe("9999999999.999999");
  });

  test.each([
    "0",
    "1",
    "1.0",
    "01.000000",
    ".000001",
    "1.0000000",
    "1e-6",
    "+1.000000",
    "-1.000000",
    "10000000000.000000",
    "NaN",
  ])("rejects noncanonical or out-of-range value %s", (value) => {
    expect(() => moneyToMicros(value, "amount")).toThrow();
  });

  test("rejects negative and overflowing micro-unit values", () => {
    expect(() => microsToMoney(-1n)).toThrow();
    expect(() => microsToMoney(10_000_000_000_000_000n)).toThrow();
  });
});

describe("subscription allowance expiry", () => {
  const expiresAt = new Date("2026-09-01T00:00:00.000Z");

  test("treats the exact expiry instant as expired", () => {
    expect(isAllowanceExpired(new Date(expiresAt.getTime() - 1), expiresAt)).toBe(false);
    expect(isAllowanceExpired(new Date(expiresAt), expiresAt)).toBe(true);
    expect(isAllowanceExpired(new Date(expiresAt.getTime() + 1), expiresAt)).toBe(true);
  });
});

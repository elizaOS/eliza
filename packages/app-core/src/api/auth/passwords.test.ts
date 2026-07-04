/**
 * Tests the password-strength guard enforced at the auth sign-up/reset boundary:
 * `assertPasswordStrong` acceptance, and the too-short / missing-letter /
 * missing-digit-or-symbol rejections plus the typed `WeakPasswordError.reason`.
 * Pure-function assertions, no server harness.
 */
import { describe, expect, it } from "vitest";
import {
  assertPasswordStrong,
  PASSWORD_MIN_LENGTH,
  WeakPasswordError,
} from "./passwords";

/**
 * Tests for the password-strength guard (#8801 / #9943). assertPasswordStrong is
 * the auth boundary that enforces a minimum strength on sign-up/reset; weakening
 * it silently is a real risk, and it was untested.
 */
describe("assertPasswordStrong", () => {
  it("accepts length + a letter + a digit OR a symbol", () => {
    expect(() => assertPasswordStrong("abcdefgh1234")).not.toThrow();
    expect(() => assertPasswordStrong("MyP@sswordXY")).not.toThrow(); // symbol satisfies the requirement
  });

  it("rejects a too-short password", () => {
    expect(() =>
      assertPasswordStrong("aB3".padEnd(PASSWORD_MIN_LENGTH - 1, "a")),
    ).toThrow(/too_short/);
  });

  it("rejects a password with no letter", () => {
    expect(() => assertPasswordStrong("1234567890!@")).toThrow(
      /missing_letter/,
    );
  });

  it("rejects a password with no digit or symbol", () => {
    expect(() => assertPasswordStrong("abcdefghijkl")).toThrow(
      /missing_digit_or_symbol/,
    );
  });

  it("surfaces the failure reason on a WeakPasswordError", () => {
    try {
      assertPasswordStrong("short");
      throw new Error("expected assertPasswordStrong to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WeakPasswordError);
      expect((e as WeakPasswordError).reason).toBe("too_short");
    }
  });
});

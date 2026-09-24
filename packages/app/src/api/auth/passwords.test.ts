/**
 * Tests the password-strength guard enforced at the auth sign-up/reset boundary:
 * `assertPasswordStrong` acceptance, and the too-short / missing-letter /
 * missing-digit-or-symbol rejections plus the typed `WeakPasswordError.reason`.
 * Password strength is pure; Argon2 calls use a mocked native boundary so the
 * suite also verifies parameter and argument forwarding without loading an
 * architecture-specific binary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { hashMock, verifyMock } = vi.hoisted(() => ({
  hashMock: vi.fn(),
  verifyMock: vi.fn(),
}));

vi.mock("@node-rs/argon2", () => ({
  hash: hashMock,
  verify: verifyMock,
}));

import {
  ARGON2_PARAMS,
  assertPasswordStrong,
  hashPassword,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
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

describe("password hashing boundary", () => {
  beforeEach(() => {
    hashMock.mockReset();
    verifyMock.mockReset();
  });

  it("loads Argon2 on demand and forwards the configured parameters", async () => {
    hashMock.mockResolvedValue("encoded-hash");

    await expect(hashPassword("a strong password 123")).resolves.toBe(
      "encoded-hash",
    );
    expect(hashMock).toHaveBeenCalledWith(
      "a strong password 123",
      ARGON2_PARAMS,
    );
  });

  it("forwards the encoded hash before the plain-text password", async () => {
    verifyMock.mockResolvedValue(true);

    await expect(
      verifyPassword("a strong password 123", "encoded-hash"),
    ).resolves.toBe(true);
    expect(verifyMock).toHaveBeenCalledWith(
      "encoded-hash",
      "a strong password 123",
    );
  });
});

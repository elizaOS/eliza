import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hash: vi.fn(async (p: string) => `argon2(${p})`),
  verify: vi.fn(async (h: string, p: string) => h === `argon2(${p})`),
}));

vi.mock("@node-rs/argon2", () => ({
  hash: mocks.hash,
  verify: mocks.verify,
}));

import {
  assertPasswordStrong,
  hashPassword,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
  WeakPasswordError,
} from "./passwords.ts";

describe("assertPasswordStrong", () => {
  it("rejects short passwords", () => {
    expect(() => assertPasswordStrong("short1A!")).toThrow(WeakPasswordError);
    try {
      assertPasswordStrong("x".repeat(PASSWORD_MIN_LENGTH - 1) + "A1!");
    } catch (e) {
      expect((e as WeakPasswordError).reason).toBe("too_short");
    }
  });

  it("rejects passwords without letters", () => {
    try {
      assertPasswordStrong("1234567890!@#");
    } catch (e) {
      expect((e as WeakPasswordError).reason).toBe("missing_letter");
    }
  });

  it("rejects passwords without digits or symbols", () => {
    try {
      assertPasswordStrong("onlylettersaaaa");
    } catch (e) {
      expect((e as WeakPasswordError).reason).toBe("missing_digit_or_symbol");
    }
  });

  it("accepts a strong password", () => {
    expect(() => assertPasswordStrong("correct-horse-9!")).not.toThrow();
  });

  it("rejects non-string input", () => {
    expect(() => assertPasswordStrong(12345 as never)).toThrow(
      WeakPasswordError,
    );
  });
});

describe("password hashing", () => {
  it("hash then verify round-trips", async () => {
    const hashed = await hashPassword("correct-horse-9!");
    expect(hashed).toBeTruthy();
    expect(await verifyPassword("correct-horse-9!", hashed)).toBe(true);
    expect(await verifyPassword("wrong-password!", hashed)).toBe(false);
  });

  it("propagates argon2 errors (fail-closed)", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("invalid hash format"));
    await expect(
      verifyPassword("x".repeat(12), "not-a-valid-hash"),
    ).rejects.toThrow("invalid hash format");
  });
});

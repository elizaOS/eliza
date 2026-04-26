import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAMS,
  assertPasswordStrong,
  hashPassword,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
  WeakPasswordError,
} from "./passwords";

describe("passwords", () => {
  it("hashPassword returns argon2id encoded string", async () => {
    const plain = "correct horse battery staple 1!";
    const hash = await hashPassword(plain);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    // OWASP-aligned params encoded into the hash; verify that the params
    // we declared land in the encoded prefix (m=19456, t=2, p=1).
    expect(hash).toMatch(/m=19456,t=2,p=1/);
    expect(ARGON2_PARAMS.timeCost).toBe(2);
  });

  it("verifyPassword returns true for the correct password", async () => {
    const plain = "anothergoodpassword99!";
    const hash = await hashPassword(plain);
    expect(await verifyPassword(plain, hash)).toBe(true);
  });

  it("verifyPassword returns false for the wrong password", async () => {
    const plain = "anothergoodpassword99!";
    const hash = await hashPassword(plain);
    expect(await verifyPassword("not-the-right-one!", hash)).toBe(false);
  });

  it("verifyPassword throws on malformed hash (caller decides policy)", async () => {
    await expect(
      verifyPassword("anything", "not-a-real-hash"),
    ).rejects.toThrow();
  });

  it("assertPasswordStrong refuses passwords shorter than the floor", () => {
    expect(() => assertPasswordStrong("short1!")).toThrow(WeakPasswordError);
    expect(PASSWORD_MIN_LENGTH).toBe(12);
  });

  it("assertPasswordStrong refuses passwords without letters", () => {
    expect(() => assertPasswordStrong("123456789012345!")).toThrow(
      WeakPasswordError,
    );
  });

  it("assertPasswordStrong refuses passwords without digits or symbols", () => {
    expect(() => assertPasswordStrong("abcdefghijklmnopqr")).toThrow(
      WeakPasswordError,
    );
  });

  it("assertPasswordStrong accepts a 12+ char mixed password", () => {
    expect(() => assertPasswordStrong("notbad password 1")).not.toThrow();
    expect(() => assertPasswordStrong("hello-world99")).not.toThrow();
  });

  it("WeakPasswordError exposes the failure reason", () => {
    try {
      assertPasswordStrong("short1!");
    } catch (err) {
      expect(err).toBeInstanceOf(WeakPasswordError);
      expect((err as WeakPasswordError).reason).toBe("too_short");
    }
  });
});

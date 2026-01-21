import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEV_SESSION_COOKIE, isAuthEnabled } from "../lib/auth-mode";

describe("DEV_SESSION_COOKIE", () => {
  it("has correct cookie name", () => {
    expect(DEV_SESSION_COOKIE).toBe("soulmates-dev-session");
  });

  it("is a non-empty string", () => {
    expect(typeof DEV_SESSION_COOKIE).toBe("string");
    expect(DEV_SESSION_COOKIE.length).toBeGreaterThan(0);
  });
});

describe("isAuthEnabled", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns true when NEXTAUTH_SECRET is set", () => {
    process.env.NEXTAUTH_SECRET = "my-secret-key";
    expect(isAuthEnabled()).toBe(true);
  });

  it("returns true when NEXTAUTH_SECRET is any non-empty string", () => {
    process.env.NEXTAUTH_SECRET = "x";
    expect(isAuthEnabled()).toBe(true);
  });

  it("returns false when NEXTAUTH_SECRET is not set", () => {
    delete process.env.NEXTAUTH_SECRET;
    expect(isAuthEnabled()).toBe(false);
  });

  it("returns false when NEXTAUTH_SECRET is empty string", () => {
    process.env.NEXTAUTH_SECRET = "";
    expect(isAuthEnabled()).toBe(false);
  });

  it("returns false when NEXTAUTH_SECRET is whitespace only", () => {
    process.env.NEXTAUTH_SECRET = "   ";
    expect(isAuthEnabled()).toBe(false);
  });

  it("trims whitespace from NEXTAUTH_SECRET", () => {
    process.env.NEXTAUTH_SECRET = "  secret  ";
    expect(isAuthEnabled()).toBe(true);
  });
});

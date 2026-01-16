import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSaltCache, getSalt } from "../settings";

describe("getSalt - production enforcement", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearSaltCache();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    clearSaltCache();
  });

  it("should throw in production when SECRET_SALT is default and override not set", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SECRET_SALT;
    delete process.env.ELIZA_ALLOW_DEFAULT_SECRET_SALT;

    expect(() => getSalt()).toThrow(/SECRET_SALT must be set/);
  });

  it("should allow default in production when override is explicitly set", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SECRET_SALT;
    process.env.ELIZA_ALLOW_DEFAULT_SECRET_SALT = "true";

    expect(getSalt()).toBe("secretsalt");
  });
});

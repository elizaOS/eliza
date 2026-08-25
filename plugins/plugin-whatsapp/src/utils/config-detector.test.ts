import { describe, expect, it } from "vitest";
import { detectAuthMethod } from "./config-detector.ts";

describe("detectAuthMethod", () => {
  it("prefers an explicit baileys authMethod over present cloud credentials", () => {
    expect(
      detectAuthMethod({
        authMethod: "baileys",
        accessToken: "tok",
        phoneNumberId: "123",
      })
    ).toBe("baileys");
  });

  it("prefers an explicit cloudapi authMethod over an authDir", () => {
    expect(detectAuthMethod({ authMethod: "cloudapi", authDir: "/data/auth" })).toBe("cloudapi");
  });

  it("rejects an unknown explicit authMethod (fail closed, no silent fallback)", () => {
    expect(() => detectAuthMethod({ authMethod: "matrix" })).toThrow(
      'Invalid authMethod: "matrix"'
    );
  });

  it("rejects a non-string explicit authMethod", () => {
    expect(() => detectAuthMethod({ authMethod: 42 })).toThrow('Invalid authMethod: "42"');
  });

  it("rejects a null explicit authMethod instead of falling back to detection", () => {
    expect(() => detectAuthMethod({ authMethod: null })).toThrow('Invalid authMethod: "null"');
  });

  it("selects baileys when authDir is present and truthy", () => {
    expect(detectAuthMethod({ authDir: "/data/auth" })).toBe("baileys");
  });

  it("does not treat an empty authDir as a Baileys signal", () => {
    expect(() => detectAuthMethod({ authDir: "" })).toThrow("Cannot detect auth method");
  });

  it("selects cloudapi when accessToken and phoneNumberId are both present", () => {
    expect(detectAuthMethod({ accessToken: "tok", phoneNumberId: "123" })).toBe("cloudapi");
  });

  it("throws when accessToken is present without phoneNumberId (partial cloud config)", () => {
    expect(() => detectAuthMethod({ accessToken: "tok" })).toThrow("Cannot detect auth method");
  });

  it("throws when phoneNumberId is present without accessToken (partial cloud config)", () => {
    expect(() => detectAuthMethod({ phoneNumberId: "123" })).toThrow("Cannot detect auth method");
  });

  it("throws when no auth signal is present at all", () => {
    expect(() => detectAuthMethod({})).toThrow("Cannot detect auth method");
  });
});

import { describe, expect, it } from "vitest";
import { detectAuthMethod } from "./config-detector";

describe("detectAuthMethod", () => {
  it("honors an explicit known authMethod", () => {
    expect(detectAuthMethod({ authMethod: "baileys" })).toBe("baileys");
    expect(detectAuthMethod({ authMethod: "cloudapi" })).toBe("cloudapi");
  });

  it("rejects unknown explicit authMethod values instead of guessing", () => {
    expect(() => detectAuthMethod({ authMethod: "matrix" })).toThrow(
      /Invalid authMethod: "matrix"/
    );
    expect(() => detectAuthMethod({ authMethod: "" })).toThrow(/Invalid authMethod/);
    expect(() => detectAuthMethod({ authMethod: " " })).toThrow(/Invalid authMethod/);
    expect(() => detectAuthMethod({ authMethod: "BAILEYS" })).toThrow(/Invalid authMethod/);
  });

  it("prefers baileys when an authDir is present even alongside cloud fields", () => {
    expect(
      detectAuthMethod({
        authDir: "/data/whatsapp",
        accessToken: "tok",
        phoneNumberId: "123",
      })
    ).toBe("baileys");
  });

  it("chooses baileys when authDir is present", () => {
    expect(detectAuthMethod({ authDir: "/data/whatsapp" })).toBe("baileys");
  });

  it("chooses cloudapi when accessToken and phoneNumberId are present", () => {
    expect(detectAuthMethod({ accessToken: "tok", phoneNumberId: "123" })).toBe("cloudapi");
  });

  it("fails closed when neither transport has usable credentials", () => {
    expect(() => detectAuthMethod({})).toThrow(/Cannot detect auth method/);
    expect(() => detectAuthMethod({ authDir: "" })).toThrow(/Cannot detect auth method/);
    expect(() => detectAuthMethod({ authDir: 0 })).toThrow(/Cannot detect auth method/);
  });

  it("fails closed on empty-string cloud credentials instead of selecting a broken transport", () => {
    // Empty accessToken would select cloudapi and then fail downstream at
    // auth time with a confusing error; it must be rejected here.
    expect(() => detectAuthMethod({ accessToken: "", phoneNumberId: "123" })).toThrow(
      /Cannot detect auth method/
    );
    expect(() => detectAuthMethod({ accessToken: "tok", phoneNumberId: "" })).toThrow(
      /Cannot detect auth method/
    );
    expect(() => detectAuthMethod({ accessToken: "", phoneNumberId: "" })).toThrow(
      /Cannot detect auth method/
    );
  });

  it("requires both cloudapi credentials together", () => {
    expect(() => detectAuthMethod({ accessToken: "tok" })).toThrow(/Cannot detect auth method/);
    expect(() => detectAuthMethod({ phoneNumberId: "123" })).toThrow(/Cannot detect auth method/);
  });
});

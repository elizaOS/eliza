import { describe, expect, it } from "vitest";
import { base64UrlEncode, createCodeChallenge } from "../auth-providers/pkce";

describe("pkce helpers", () => {
  it("base64UrlEncode should be url-safe and unpadded", () => {
    const out = base64UrlEncode(Buffer.from("hello world"));
    expect(out).not.toContain("+");
    expect(out).not.toContain("/");
    expect(out).not.toContain("=");
  });

  it("createCodeChallenge should match known vector", () => {
    // RFC 7636 example (verifier => challenge)
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(createCodeChallenge(verifier)).toBe(expected);
  });
});

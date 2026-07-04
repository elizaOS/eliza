/**
 * Unit coverage for JWT payload decode and expiry math. Pure functions over
 * synthetic tokens, no signature verification.
 */
import { describe, expect, it } from "vitest";
import { decodeJwtPayload, jwtExpiryMs } from "./jwt";

/** Build a JWT-shaped string with the given payload object (signature is junk). */
function makeToken(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.sig`;
}

/** Standard-then-url base64 encode (mirrors a real JWT segment, no padding). */
function base64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("decodeJwtPayload", () => {
  it("decodes a well-formed token's payload", () => {
    const token = makeToken({
      userId: "u_123",
      email: "a@b.com",
      address: "0xabc",
      exp: 1234567890,
    });
    expect(decodeJwtPayload(token)).toEqual({
      userId: "u_123",
      email: "a@b.com",
      address: "0xabc",
      exp: 1234567890,
    });
  });

  it("decodes base64url payloads containing - and _ chars", () => {
    // Pick a payload whose base64 contains both + and / (→ - and _ after url-encode).
    const payload = { sub: "ÿÿÿ?>?>", exp: 42 };
    const token = makeToken(payload);
    expect(token.split(".")[1]).toMatch(/[-_]/);
    expect(decodeJwtPayload(token)).toEqual(payload);
  });

  it.each([
    ["empty string", ""],
    ["wrong segment count", "a.b"],
    ["too many segments", "a.b.c.d"],
    ["non-base64 payload", "a.!!!.c"],
    ["payload is not JSON", `a.${base64url("not json")}.c`],
  ])("returns null for %s", (_label, token) => {
    expect(decodeJwtPayload(token)).toBeNull();
  });
});

describe("jwtExpiryMs", () => {
  it("returns exp in milliseconds", () => {
    expect(jwtExpiryMs(makeToken({ exp: 1_000 }))).toBe(1_000_000);
  });

  it("returns null when exp is absent", () => {
    expect(jwtExpiryMs(makeToken({ userId: "u" }))).toBeNull();
  });

  it("returns null when exp is not a number", () => {
    expect(jwtExpiryMs(makeToken({ exp: "soon" }))).toBeNull();
  });

  it("returns null for a malformed token", () => {
    expect(jwtExpiryMs("garbage")).toBeNull();
  });
});

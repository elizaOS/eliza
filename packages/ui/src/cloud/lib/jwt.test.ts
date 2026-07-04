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

/**
 * Standard-then-url base64 encode of the UTF-8 bytes (mirrors a real JWT
 * segment, no padding). Real issuers encode UTF-8 JSON (RFC 7519 §3), so the
 * bytes are produced via TextEncoder — a bare `btoa(json)` would emit latin1
 * bytes no real token contains.
 */
function base64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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

  it("decodes non-ASCII UTF-8 claims without mojibake", () => {
    // Real tokens carry UTF-8 JSON; decoding the atob byte string directly
    // used to yield "josÃ©@example.com".
    const payload = { email: "josé@example.com", sub: "u1", exp: 42 };
    expect(decodeJwtPayload(makeToken(payload))).toEqual(payload);
  });

  it("decodes claims outside latin1 (CJK, emoji)", () => {
    const payload = { email: "太郎@example.com", sub: "🙂", exp: 42 };
    expect(decodeJwtPayload(makeToken(payload))).toEqual(payload);
  });

  it.each([
    ["empty string", ""],
    ["wrong segment count", "a.b"],
    ["too many segments", "a.b.c.d"],
    ["non-base64 payload", "a.!!!.c"],
    ["payload is not JSON", `a.${base64url("not json")}.c`],
    // 0xFF alone is not valid UTF-8 — the strict decode maps it to null
    // rather than a fabricated payload.
    ["payload bytes are not UTF-8", `a.${btoa('{"sub":"ÿ"}')}.c`],
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

/** Unit tests for the PKCE helpers (code verifier/challenge, state, base64url), checked against `node:crypto` directly. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  createCodeChallenge,
  createCodeVerifier,
  createState,
} from "./pkce";

/**
 * PKCE (RFC 7636) for the X OAuth flow. base64url output must be URL-safe and
 * unpadded; the code_verifier must land in the 43-128 char range; the
 * code_challenge must be the base64url of SHA-256(verifier) (the server
 * recomputes this — a mismatch breaks the token exchange); and verifier/state
 * must be unique per call (CSRF + interception defense).
 */

describe("base64UrlEncode", () => {
  it("produces URL-safe, unpadded output", () => {
    const encoded = base64UrlEncode(Buffer.from([0xfb, 0xff, 0xbf]));
    expect(encoded).not.toMatch(/[+/=]/);
    // round-trips back to the original bytes.
    expect(Buffer.from(encoded, "base64url")).toEqual(
      Buffer.from([0xfb, 0xff, 0xbf]),
    );
  });
});

describe("createCodeVerifier", () => {
  it("is within RFC 7636's 43-128 char range and unique per call", () => {
    const a = createCodeVerifier();
    const b = createCodeVerifier();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[+/=]/);
  });
});

describe("createCodeChallenge", () => {
  it("is base64url(SHA-256(verifier)) — matches an independent computation", () => {
    const verifier = "test-verifier-value";
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(createCodeChallenge(verifier)).toBe(expected);
  });

  it("is deterministic for the same verifier, different for another", () => {
    expect(createCodeChallenge("abc")).toBe(createCodeChallenge("abc"));
    expect(createCodeChallenge("abc")).not.toBe(createCodeChallenge("abd"));
  });
});

describe("createState", () => {
  it("is unique per call and URL-safe", () => {
    expect(createState()).not.toBe(createState());
    expect(createState()).not.toMatch(/[+/=]/);
  });
});

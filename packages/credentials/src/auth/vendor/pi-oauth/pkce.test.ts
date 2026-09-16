/**
 * Behavioral coverage for PKCE verifier and S256 challenge generation.
 *
 * Drives the real Web Crypto path in pkce.ts: 32-byte entropy, base64url
 * encoding without padding, and SHA-256 challenge derivation. No crypto
 * or fetch mocks; the S256 check uses Node's independent base64url encoder
 * rather than the production btoa/replace helper.
 */

import { describe, expect, it } from "vitest";
import { generatePKCE } from "./pkce.ts";

/** RFC 7636 unpadded base64url alphabet (no `+`, `/`, `=`, `.`, or `~`). */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * 32 random bytes encode to 43 unpadded base64url characters (256 bits / 6,
 * then the leftover 2 bits occupy one more character; standard base64 would
 * emit a trailing `=` which this encoder strips).
 */
const PKCE_BYTE_LENGTH = 32;
const UNPADDED_BASE64URL_LEN = 43;

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString("base64url");
}

describe("generatePKCE", () => {
  it("returns string verifier and challenge keys and nothing else", async () => {
    const pair = await generatePKCE();
    expect(Object.keys(pair).sort()).toEqual(["challenge", "verifier"]);
    expect(typeof pair.verifier).toBe("string");
    expect(typeof pair.challenge).toBe("string");
  });

  it("encodes a 32-byte verifier as 43 unpadded base64url characters", async () => {
    const { verifier } = await generatePKCE();
    expect(verifier).toMatch(BASE64URL);
    expect(verifier).toHaveLength(UNPADDED_BASE64URL_LEN);
    expect(verifier).not.toContain("+");
    expect(verifier).not.toContain("/");
    expect(verifier).not.toContain("=");
  });

  it("encodes the SHA-256 digest as a 43-character base64url challenge", async () => {
    const { challenge } = await generatePKCE();
    expect(challenge).toMatch(BASE64URL);
    expect(challenge).toHaveLength(UNPADDED_BASE64URL_LEN);
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
    expect(challenge).not.toContain("=");
  });

  it("derives the challenge as S256 of the verifier via Node base64url", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(challenge).toBe(await s256Challenge(verifier));
  });

  it("recomputes the same challenge from the same verifier", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(await s256Challenge(verifier)).toBe(challenge);
    expect(await s256Challenge(verifier)).toBe(challenge);
  });

  it("does not use the verifier string as the challenge", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(challenge).not.toBe(verifier);
  });

  it("emits distinct verifiers and challenges across sequential calls", async () => {
    const first = await generatePKCE();
    const second = await generatePKCE();
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).not.toBe(second.challenge);
  });

  it("emits unique verifiers across concurrent calls", async () => {
    const pairs = await Promise.all(
      Array.from({ length: PKCE_BYTE_LENGTH }, () => generatePKCE()),
    );
    const verifiers = pairs.map((pair) => pair.verifier);
    expect(new Set(verifiers).size).toBe(PKCE_BYTE_LENGTH);
    const challenges = pairs.map((pair) => pair.challenge);
    expect(new Set(challenges).size).toBe(PKCE_BYTE_LENGTH);
  });
});

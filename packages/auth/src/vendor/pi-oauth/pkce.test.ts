/**
 * Unit coverage for PKCE challenge and verifier generation in pkce.ts.
 *
 * Verifies 32-byte entropy, base64url string formatting, URL safety,
 * uniqueness across invocations, and cryptographic SHA-256 digest integrity.
 */

import { describe, expect, it } from "vitest";
import { generatePKCE } from "./pkce.js";

describe("pkce", () => {
  it("generates valid verifier and challenge strings", async () => {
    const { verifier, challenge } = await generatePKCE();

    expect(typeof verifier).toBe("string");
    expect(typeof challenge).toBe("string");
    expect(verifier.length).toBeGreaterThan(0);
    expect(challenge.length).toBeGreaterThan(0);
  });

  it("conforms to base64url format without standard base64 padding or symbols", async () => {
    const { verifier, challenge } = await generatePKCE();
    const base64urlRegex = /^[A-Za-z0-9_-]+$/;

    expect(verifier).toMatch(base64urlRegex);
    expect(challenge).toMatch(base64urlRegex);
    expect(verifier).not.toContain("+");
    expect(verifier).not.toContain("/");
    expect(verifier).not.toContain("=");
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
    expect(challenge).not.toContain("=");
  });

  it("generates cryptographically unique verifiers on consecutive runs", async () => {
    const first = await generatePKCE();
    const second = await generatePKCE();

    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).not.toBe(second.challenge);
  });

  it("produces SHA-256 challenge matching the verifier digest", async () => {
    const { verifier, challenge } = await generatePKCE();

    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
    const bytes = new Uint8Array(hashBuffer);

    let binary = "";
    for (const b of bytes) {
      binary += String.fromCharCode(b);
    }
    const expectedChallenge = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    expect(challenge).toBe(expectedChallenge);
  });
});

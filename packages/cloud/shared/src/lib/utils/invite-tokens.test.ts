// Exercises invite tokens behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import { generateInviteToken, hashInviteToken, verifyInviteToken } from "./invite-tokens";

/**
 * Tests for the invite-token security primitives (#8801 / #9943). These were
 * untested: generation must be unique + unguessable, the stored value must be a
 * hash (never the raw token), and verification must accept only the exact
 * token/hash pair.
 */
describe("invite tokens", () => {
  test("generateInviteToken returns a unique 64-char hex string", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  test("hashInviteToken is a deterministic SHA-256 hex (known-answer)", () => {
    expect(hashInviteToken("token-abc")).toBe(hashInviteToken("token-abc"));
    expect(hashInviteToken("token-abc")).toMatch(/^[0-9a-f]{64}$/);
    // NIST SHA-256("abc") — proves it is really SHA-256, not some other digest.
    expect(hashInviteToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("distinct tokens hash differently", () => {
    expect(hashInviteToken("one")).not.toBe(hashInviteToken("two"));
  });

  test("verifyInviteToken accepts the exact pair and rejects mismatches", () => {
    const token = generateInviteToken();
    const hash = hashInviteToken(token);
    expect(verifyInviteToken(token, hash)).toBe(true);
    expect(verifyInviteToken("wrong-token", hash)).toBe(false);
    expect(verifyInviteToken(token, hashInviteToken("other"))).toBe(false);
  });
});

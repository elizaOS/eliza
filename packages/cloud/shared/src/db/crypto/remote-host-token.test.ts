/**
 * Unit test contract for remote host bearer token generation and canonical digest hashing.
 *
 * Covers:
 * - Token shape (rhost_v1_<43 base64url chars>, 256 bits of entropy, uniqueness).
 * - Digest shape + determinism (sha256:<64 lowercase hex chars>, repeatable).
 * - Fail-closed rejection of malformed tokens (invalid length, non-base64url, wrong prefix, empty).
 */
import { describe, expect, test } from "bun:test";

import { generateRemoteHostToken, hashRemoteHostToken } from "./remote-host-token";

describe("generateRemoteHostToken", () => {
  test("emits a valid rhost_v1_ token format with exactly 43 base64url characters", () => {
    const token = generateRemoteHostToken();
    expect(token).toMatch(/^rhost_v1_[A-Za-z0-9_-]{43}$/);
    expect(token.length).toBe(52); // "rhost_v1_".length (9) + 43
  });

  test("produces unique tokens across calls (entropy verification)", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      tokens.add(generateRemoteHostToken());
    }
    expect(tokens.size).toBe(50);
  });
});

describe("hashRemoteHostToken", () => {
  test("computes canonical sha256: prefixed lowercase hex digest", async () => {
    const token = generateRemoteHostToken();
    const digest = await hashRemoteHostToken(token);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digest.length).toBe(71); // "sha256:".length (7) + 64
  });

  test("produces deterministic digests for the same token", async () => {
    const token = generateRemoteHostToken();
    const digest1 = await hashRemoteHostToken(token);
    const digest2 = await hashRemoteHostToken(token);
    expect(digest1).toBe(digest2);
  });

  test("different tokens yield different digests", async () => {
    const token1 = generateRemoteHostToken();
    const token2 = generateRemoteHostToken();
    const digest1 = await hashRemoteHostToken(token1);
    const digest2 = await hashRemoteHostToken(token2);
    expect(digest1).not.toBe(digest2);
  });

  test("rejects malformed tokens fail-closed with TypeError", async () => {
    // Missing prefix
    const rawEntropy = "A".repeat(43);
    expect(hashRemoteHostToken(rawEntropy)).rejects.toThrow(TypeError);

    // Wrong prefix version
    expect(hashRemoteHostToken(`rhost_v2_${rawEntropy}`)).rejects.toThrow(TypeError);

    // Invalid length (short)
    expect(hashRemoteHostToken("rhost_v1_abc")).rejects.toThrow(TypeError);

    // Invalid length (long - 44 chars)
    expect(hashRemoteHostToken(`rhost_v1_${"A".repeat(44)}`)).rejects.toThrow(TypeError);

    // Invalid characters (padding leaked or invalid symbols)
    expect(hashRemoteHostToken(`rhost_v1_${"A".repeat(42)}=`)).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken(`rhost_v1_${"A".repeat(42)}!`)).rejects.toThrow(TypeError);

    // Empty string
    expect(hashRemoteHostToken("")).rejects.toThrow(TypeError);
  });
});

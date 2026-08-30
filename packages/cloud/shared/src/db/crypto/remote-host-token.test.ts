/**
 * Unit test contract for remote host bearer token generation and canonical digest hashing.
 *
 * Covers:
 * - Token shape (rhost_v1_<43 base64url chars>, 256 bits of entropy, uniqueness).
 * - Digest shape + determinism (sha256:<64 lowercase hex chars>, repeatable).
 * - Known-answer vector pinning full prefixed token hashing.
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

  test("produces unique tokens across calls (smoke collision check)", () => {
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

  test("hashes the full prefixed token (known-answer vector)", async () => {
    const token = `rhost_v1_${"A".repeat(43)}`;
    await expect(hashRemoteHostToken(token)).resolves.toBe(
      "sha256:72542723dd2d38b0dd3552523d0faf14ae59064641747859a8f62229522554b4",
    );
  });

  test("different tokens yield different digests", async () => {
    const token1 = generateRemoteHostToken();
    const token2 = generateRemoteHostToken();
    const digest1 = await hashRemoteHostToken(token1);
    const digest2 = await hashRemoteHostToken(token2);
    expect(digest1).not.toBe(digest2);
  });

  describe("rejects malformed tokens fail-closed with TypeError", () => {
    const malformedCases: [string, string][] = [
      ["missing prefix", "A".repeat(43)],
      ["wrong prefix version", `rhost_v2_${"A".repeat(43)}`],
      ["uppercase prefix", `RHOST_v1_${"A".repeat(43)}`],
      ["short length", "rhost_v1_abc"],
      ["long length (44 chars)", `rhost_v1_${"A".repeat(44)}`],
      ["base64 padding '=' leaked", `rhost_v1_${"A".repeat(42)}=`],
      ["invalid punctuation '!'", `rhost_v1_${"A".repeat(42)}!`],
      ["standard base64 '+' char", `rhost_v1_${"A".repeat(42)}+`],
      ["standard base64 '/' char", `rhost_v1_${"A".repeat(42)}/`],
      ["empty string", ""],
    ];

    test.each(malformedCases)("%s", async (_, input) => {
      await expect(hashRemoteHostToken(input)).rejects.toThrow(TypeError);
    });
  });
});

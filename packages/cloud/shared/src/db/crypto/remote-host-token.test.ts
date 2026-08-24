/**
 * Tests for remote-host token generation, structural validation, and hashing.
 *
 * Verifies high-entropy bearer token format (rhost_v1_ prefix followed by 43
 * base64url characters), negative validation boundaries (wrong prefix with
 * matching length, forbidden characters, overlength and underlength tokens),
 * deterministic SHA-256 digest computation against known test vectors, and the
 * invariant that only the SHA-256 digest is persisted while the plaintext token
 * is generated once.
 *
 * Runs deterministically against WebCrypto without external mocks or database.
 */

import { describe, expect, it } from "vitest";
import { generateRemoteHostToken, hashRemoteHostToken } from "./remote-host-token";

describe("generateRemoteHostToken", () => {
  it("produces high-entropy bearer token with rhost_v1_ prefix and 43 unpadded base64url characters", () => {
    const token = generateRemoteHostToken();
    expect(token.startsWith("rhost_v1_")).toBe(true);
    expect(token.length).toBe(52); // "rhost_v1_".length (9) + 43
    expect(/^rhost_v1_[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
  });

  it("successive calls produce unique high-entropy tokens", () => {
    const tokens = new Set<string>();
    const iterations = 50;
    for (let i = 0; i < iterations; i++) {
      const tok = generateRemoteHostToken();
      expect(/^rhost_v1_[A-Za-z0-9_-]{43}$/.test(tok)).toBe(true);
      tokens.add(tok);
    }
    expect(tokens.size).toBe(iterations);
  });
});

describe("hashRemoteHostToken - known SHA-256 test vectors", () => {
  it("computes deterministic SHA-256 digest matching known test vector 1", async () => {
    const token = "rhost_v1_0123456789abcdefghijklmnopqrstuvwxyz-_ABCDE";
    expect(token.length).toBe(52);
    const digest = await hashRemoteHostToken(token);
    expect(digest).toBe("sha256:ba04f099cb1fce1ae367020e7cc05408a37354534dd2fcc7a874fa13d2e03d33");
  });

  it("computes deterministic SHA-256 digest matching known test vector 2", async () => {
    const token = `rhost_v1_${"0".repeat(43)}`;
    expect(token.length).toBe(52);
    const digest = await hashRemoteHostToken(token);
    expect(digest).toBe("sha256:82ef688282d0b569ef87ff3ce7cfedad3af12c5bb8f29bdab755369ebb2750bb");
  });

  it("computes deterministic SHA-256 digest matching known test vector 3", async () => {
    const token = `rhost_v1_${"A".repeat(43)}`;
    expect(token.length).toBe(52);
    const digest = await hashRemoteHostToken(token);
    expect(digest).toBe("sha256:72542723dd2d38b0dd3552523d0faf14ae59064641747859a8f62229522554b4");
  });
});

describe("hashRemoteHostToken - negative validation boundaries", () => {
  const validSuffix = "0123456789abcdefghijklmnopqrstuvwxyz-_ABCDE"; // 43 chars

  it("rejects correct-length tokens with wrong prefix", async () => {
    const wrongPrefixes = [
      "rhost_v2_",
      "shost_v1_",
      "wrong_v1_",
      "rhost_v0_",
      "RHOST_V1_",
      "rhost_v1.",
      "rhost-v1_",
      "phost_v1_",
    ];
    for (const prefix of wrongPrefixes) {
      const invalidToken = `${prefix}${validSuffix}`;
      expect(invalidToken.length).toBe(52);
      await expect(hashRemoteHostToken(invalidToken)).rejects.toThrow(/malformed/);
    }
  });

  it("rejects tokens containing forbidden characters", async () => {
    // Base64 '+' and '/' are forbidden in base64url; '=' padding is forbidden; special symbols / whitespace are forbidden
    const forbiddenChars = [
      "+",
      "/",
      "=",
      "!",
      "@",
      "#",
      "$",
      "%",
      "^",
      "&",
      "*",
      "(",
      ")",
      " ",
      "\t",
      "\n",
      ".",
      ":",
      ";",
      "?",
      "~",
      "{",
      "}",
    ];
    for (const char of forbiddenChars) {
      // Append forbidden char at end (maintaining length 52)
      const invalidEnd = `rhost_v1_${"a".repeat(42)}${char}`;
      expect(invalidEnd.length).toBe(52);
      await expect(hashRemoteHostToken(invalidEnd)).rejects.toThrow(/malformed/);

      // Embed forbidden char in middle (maintaining length 52)
      const invalidMid = `rhost_v1_${"a".repeat(20)}${char}${"b".repeat(22)}`;
      expect(invalidMid.length).toBe(52);
      await expect(hashRemoteHostToken(invalidMid)).rejects.toThrow(/malformed/);
    }
  });

  it("rejects overlength tokens", async () => {
    const overlengthCounts = [44, 45, 50, 100];
    for (const count of overlengthCounts) {
      const overlongToken = `rhost_v1_${"a".repeat(count)}`;
      expect(overlongToken.length).toBe(9 + count);
      await expect(hashRemoteHostToken(overlongToken)).rejects.toThrow(/malformed/);
    }
  });

  it("rejects underlength, empty, or truncated tokens", async () => {
    const underlengthTokens = [
      "",
      "bad",
      "rhost_v1_",
      "rhost_v1_short",
      `rhost_v1_${"a".repeat(42)}`,
      `rhost_v1_${"a".repeat(1)}`,
    ];
    for (const token of underlengthTokens) {
      await expect(hashRemoteHostToken(token)).rejects.toThrow(/malformed/);
    }
  });
});

describe("credential contract: digest-only persistence and one-time plaintext", () => {
  it("formats digest as sha256:<64 hex> and does not contain plaintext token", async () => {
    const token = generateRemoteHostToken();
    const digest = await hashRemoteHostToken(token);
    expect(token.startsWith("rhost_v1_")).toBe(true);
    expect(digest.startsWith("sha256:")).toBe(true);
    expect(digest.length).toBe("sha256:".length + 64);
    expect(/^sha256:[a-f0-9]{64}$/.test(digest)).toBe(true);
    // Plaintext bearer credential is never contained in stored digest
    expect(digest).not.toContain(token);
    // Digest format itself cannot be passed back as a valid bearer token
    await expect(hashRemoteHostToken(digest)).rejects.toThrow(/malformed/);
  });

  it("produces deterministic digests for the same token and distinct digests for different tokens", async () => {
    const tokenA = generateRemoteHostToken();
    const tokenB = generateRemoteHostToken();
    expect(tokenA).not.toBe(tokenB);

    const digestA1 = await hashRemoteHostToken(tokenA);
    const digestA2 = await hashRemoteHostToken(tokenA);
    const digestB = await hashRemoteHostToken(tokenB);

    expect(digestA1).toBe(digestA2);
    expect(digestA1).not.toBe(digestB);
  });
});

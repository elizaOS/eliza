/**
 * Pins the mint/hash contract of the remote-host bearer credential. The
 * plaintext token is returned once at enrollment (`remote/hosts/route.ts`) and
 * every later lookup authenticates through the persisted `sha256:` digest
 * (`remote-hosts.ts`, `remote-sessions-store.ts`), so a shape or determinism
 * regression here silently locks out every enrolled remote host after upgrade.
 *
 * Drives the real exported mint/hash pair over real WebCrypto — no stubbed
 * subtle crypto, no database.
 */
import { describe, expect, test } from "bun:test";

import { generateRemoteHostToken, hashRemoteHostToken } from "./remote-host-token";

const TOKEN_PATTERN = /^rhost_v1_[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

describe("generateRemoteHostToken", () => {
  test("mints the versioned 43-character base64url shape", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(TOKEN_PATTERN.test(generateRemoteHostToken())).toBe(true);
    }
  });

  test("does not leak base64 padding into the token", () => {
    for (let i = 0; i < 20; i += 1) {
      const token = generateRemoteHostToken();
      expect(token).not.toContain("=");
      expect(token).not.toContain("+");
      expect(token).not.toContain("/");
    }
  });

  test("mints distinct tokens across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(generateRemoteHostToken());
    }
    expect(seen.size).toBe(100);
  });

  test("every decoded byte position varies across mints", () => {
    // Decode base64url body back to 32 raw bytes and verify that every
    // position carries at least two distinct values across a large sample.
    // A truncation or prefix-only mutation (e.g. 32→4 random bytes) would
    // leave positions 4–31 invariant and fail this assertion.
    const seen = Array.from({ length: 32 }, () => new Set<number>());
    for (let i = 0; i < 256; i += 1) {
      const b64 = generateRemoteHostToken()
        .slice("rhost_v1_".length)
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(44, "=");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      expect(bytes.length).toBe(32);
      bytes.forEach((b, idx) => seen[idx].add(b));
    }
    seen.forEach((s) => expect(s.size).toBeGreaterThan(1));
  });
});

describe("hashRemoteHostToken", () => {
  test("emits the canonical sha256 hex digest shape", async () => {
    const token = generateRemoteHostToken();
    const digest = await hashRemoteHostToken(token);
    expect(DIGEST_PATTERN.test(digest)).toBe(true);
  });

  test("is deterministic for the same token", async () => {
    const token = generateRemoteHostToken();
    expect(await hashRemoteHostToken(token)).toBe(await hashRemoteHostToken(token));
  });

  test("differs for distinct tokens", async () => {
    const first = await hashRemoteHostToken(generateRemoteHostToken());
    const second = await hashRemoteHostToken(generateRemoteHostToken());
    expect(first).not.toBe(second);
  });

  test("digest hex is lowercase, matching persisted-row lookups", async () => {
    const digest = await hashRemoteHostToken(generateRemoteHostToken());
    const hex = digest.slice("sha256:".length);
    expect(hex).toBe(hex.toLowerCase());
    expect(hex).not.toBe(hex.toUpperCase());
  });

  test("matches a hand-computed SHA-256 of a fixed token", async () => {
    // Fixed 43-char base64url body so the digest is stable across runs.
    const token = "rhost_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const digest = await hashRemoteHostToken(token);
    expect(digest).toBe("sha256:72542723dd2d38b0dd3552523d0faf14ae59064641747859a8f62229522554b4");
  });
});

describe("hashRemoteHostToken fail-closed rejection", () => {
  test("rejects an empty token", async () => {
    expect(hashRemoteHostToken("")).rejects.toThrow(TypeError);
  });

  test("rejects a token with a wrong-length body", async () => {
    const short = "rhost_v1_" + "A".repeat(42);
    const long = "rhost_v1_" + "A".repeat(44);
    expect(hashRemoteHostToken(short)).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken(long)).rejects.toThrow(TypeError);
  });

  test("rejects a token with the wrong version prefix", async () => {
    expect(hashRemoteHostToken("rhost_v2_" + "A".repeat(43))).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken("host_v1_" + "A".repeat(43))).rejects.toThrow(TypeError);
  });

  test("rejects a token outside the base64url alphabet", async () => {
    // '+' and '/' are legal base64 but not base64url; padding and spaces too.
    expect(hashRemoteHostToken("rhost_v1_" + "+".repeat(43))).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken("rhost_v1_" + "/".repeat(43))).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken("rhost_v1_" + "=".repeat(43))).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken("rhost_v1_" + " ".repeat(43))).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken("rhost_v1_" + "A".repeat(42) + "!")).rejects.toThrow(TypeError);
  });
});

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

  test("draws all 32 entropy bytes from the source and encodes each one", () => {
    // Pin the entropy-source contract: the mint must request exactly 32 fresh
    // bytes from crypto.getRandomValues and every requested byte must reach
    // the token body. A mutation that randomizes only a few bytes and tiles
    // them across the array (a 32-bit-entropy credential) requests only those
    // few bytes, so this assertion goes red where the per-position variation
    // check above stays green.
    const original = crypto.getRandomValues.bind(crypto);
    let requested: Uint8Array<ArrayBuffer> | null = null;
    const spy = ((array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
      requested = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      return original(array);
    }) as typeof crypto.getRandomValues;
    crypto.getRandomValues = spy;
    try {
      const b64 = generateRemoteHostToken()
        .slice("rhost_v1_".length)
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(44, "=");
      const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      expect(requested).not.toBeNull();
      expect(requested!.byteLength).toBe(32);
      // The token body must be exactly the bytes the entropy source supplied,
      // not a prefix, a re-tiled derivative, or a fixed constant.
      expect(decoded).toEqual(requested!);
    } finally {
      crypto.getRandomValues = original;
    }
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

  test("matches a hand-computed SHA-256 of a full-charset token", async () => {
    // The body covers upper/lowercase, digits, and the '-'/'_' base64url
    // alphabet, so the digest also pins hash-input encoding for every valid
    // character class (e.g. a mutation that folds '-' into '_' before hashing
    // changes this vector but leaves the all-'A' one above unchanged).
    const token = "rhost_v1_ABCDEFGHIJKLMNOabcdefghijklmno0123456789-_P";
    const digest = await hashRemoteHostToken(token);
    expect(digest).toBe("sha256:2e9e3daf21e8f76ed4a47f1bfcf9cf803e7e1bb292eee369e686f28bf90787be");
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

  test("rejects tokens with surrounding whitespace or control characters", async () => {
    // A pasted token may carry a trailing newline or leading whitespace;
    // those must fail closed rather than hash to a digest that matches no
    // stored row. The strict end anchor must reject each of these.
    const token = "rhost_v1_" + "A".repeat(43);
    expect(hashRemoteHostToken(token + "\n")).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken("\n" + token)).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken(token + "\r")).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken(token + "\t")).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken(token + " ")).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken(" " + token)).rejects.toThrow(TypeError);
    expect(hashRemoteHostToken(token + "\u0000")).rejects.toThrow(TypeError);
  });
});

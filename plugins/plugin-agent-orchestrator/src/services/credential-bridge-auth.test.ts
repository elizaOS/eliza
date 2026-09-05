/**
 * Unit tests for credential-bridge-auth: validates token generation, SHA-256
 * hashing, and timing-safe token verification for the loopback credential bridge.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_BRIDGE_TOKEN_ENV,
  CREDENTIAL_BRIDGE_TOKEN_HASH_METADATA,
  createCredentialBridgeToken,
  hashCredentialBridgeToken,
  matchesCredentialBridgeToken,
} from "./credential-bridge-auth.ts";

describe("credential-bridge-auth", () => {
  it("exports standard environment and metadata key constants", () => {
    expect(CREDENTIAL_BRIDGE_TOKEN_ENV).toBe("ELIZA_CREDENTIAL_BRIDGE_TOKEN");
    expect(CREDENTIAL_BRIDGE_TOKEN_HASH_METADATA).toBe(
      "credentialBridgeTokenHash",
    );
  });

  describe("createCredentialBridgeToken", () => {
    it("generates a random base64url token and matching SHA-256 hash", () => {
      const first = createCredentialBridgeToken();
      expect(typeof first.token).toBe("string");
      expect(first.token.length).toBeGreaterThanOrEqual(40);
      expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.hash).toBe(hashCredentialBridgeToken(first.token));

      const second = createCredentialBridgeToken();
      expect(second.token).not.toBe(first.token);
      expect(second.hash).not.toBe(first.hash);
    });
  });

  describe("hashCredentialBridgeToken", () => {
    it("computes deterministic SHA-256 hex digest", () => {
      const testToken = "test-bearer-token-12345";
      const expected = createHash("sha256")
        .update(testToken, "utf8")
        .digest("hex");
      expect(hashCredentialBridgeToken(testToken)).toBe(expected);
      expect(hashCredentialBridgeToken(testToken)).toBe(
        hashCredentialBridgeToken(testToken),
      );
    });
  });

  describe("matchesCredentialBridgeToken", () => {
    it("returns true when token matches expected hash", () => {
      const { token, hash } = createCredentialBridgeToken();
      expect(matchesCredentialBridgeToken(token, hash)).toBe(true);
    });

    it("accepts uppercase and mixed-case valid hex hash strings", () => {
      const { token, hash } = createCredentialBridgeToken();
      expect(matchesCredentialBridgeToken(token, hash.toUpperCase())).toBe(
        true,
      );
      const mixedCase = hash
        .split("")
        .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
        .join("");
      expect(matchesCredentialBridgeToken(token, mixedCase)).toBe(true);
    });

    it("rejects a hash that matches only on a prefix", () => {
      const { token, hash } = createCredentialBridgeToken();
      const nearMiss = `${hash.slice(0, 63)}${hash.endsWith("0") ? "1" : "0"}`;
      expect(matchesCredentialBridgeToken(token, nearMiss)).toBe(false);
    });

    it("rejects a well-formed digest carrying trailing junk", () => {
      const { token, hash } = createCredentialBridgeToken();
      expect(matchesCredentialBridgeToken(token, `${hash}zz`)).toBe(false);
    });

    it("returns false for mismatched token", () => {
      const { hash } = createCredentialBridgeToken();
      expect(matchesCredentialBridgeToken("wrong-token", hash)).toBe(false);
    });

    it("returns false for non-string expectedHash inputs", () => {
      expect(matchesCredentialBridgeToken("token", null)).toBe(false);
      expect(matchesCredentialBridgeToken("token", undefined)).toBe(false);
      expect(matchesCredentialBridgeToken("token", 12345)).toBe(false);
      expect(matchesCredentialBridgeToken("token", { hash: "val" })).toBe(
        false,
      );
    });

    it("returns false for invalid hash formats and lengths", () => {
      expect(matchesCredentialBridgeToken("token", "")).toBe(false);
      // 63 characters (too short)
      expect(matchesCredentialBridgeToken("token", "a".repeat(63))).toBe(false);
      // 65 characters (too long)
      expect(matchesCredentialBridgeToken("token", "a".repeat(65))).toBe(false);
      // 64 characters with non-hex character
      expect(matchesCredentialBridgeToken("token", `${"a".repeat(63)}g`)).toBe(
        false,
      );
    });
  });
});

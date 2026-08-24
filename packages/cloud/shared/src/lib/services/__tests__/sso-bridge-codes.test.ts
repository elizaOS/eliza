/**
 * Unit tests for SSO bridge codes constants and predicates in
 * packages/cloud/shared/src/lib/services/sso-bridge-codes.ts.
 */
import { describe, expect, it } from "vitest";
import {
  looksLikeSsoBridgeChallenge,
  looksLikeSsoBridgeCode,
  SSO_BRIDGE_CODE_TTL_SECONDS,
  SSO_BRIDGE_LOGOUT_MARKER_TTL_SECONDS,
} from "../sso-bridge-codes.ts";

describe("sso-bridge-codes", () => {
  describe("TTL constants", () => {
    it("exports canonical 60-second code TTL and 1-hour logout marker TTL", () => {
      expect(SSO_BRIDGE_CODE_TTL_SECONDS).toBe(60);
      expect(SSO_BRIDGE_LOGOUT_MARKER_TTL_SECONDS).toBe(3600);
    });
  });

  describe("looksLikeSsoBridgeCode", () => {
    const validHex64 = "a".repeat(64);
    const validCode = `esso_${validHex64}`;

    it("returns true for well-formed SSO bridge code with esso_ prefix and 64-char lowercase hex", () => {
      expect(looksLikeSsoBridgeCode(validCode)).toBe(true);
      expect(
        looksLikeSsoBridgeCode(
          "esso_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ),
      ).toBe(true);
    });

    it("returns false for non-string, null, or undefined inputs", () => {
      expect(looksLikeSsoBridgeCode(null)).toBe(false);
      expect(looksLikeSsoBridgeCode(undefined)).toBe(false);
      expect(looksLikeSsoBridgeCode(123 as unknown as string)).toBe(false);
      expect(looksLikeSsoBridgeCode({} as unknown as string)).toBe(false);
    });

    it("returns false for missing or invalid prefix", () => {
      expect(looksLikeSsoBridgeCode(validHex64)).toBe(false);
      expect(looksLikeSsoBridgeCode(`sso_${validHex64}`)).toBe(false);
      expect(looksLikeSsoBridgeCode(`ESSO_${validHex64}`)).toBe(false);
    });

    it("returns false for uppercase hex or invalid length", () => {
      expect(looksLikeSsoBridgeCode(`esso_${"A".repeat(64)}`)).toBe(false);
      expect(looksLikeSsoBridgeCode(`esso_${"a".repeat(63)}`)).toBe(false);
      expect(looksLikeSsoBridgeCode(`esso_${"a".repeat(65)}`)).toBe(false);
      expect(looksLikeSsoBridgeCode(`esso_${"g".repeat(64)}`)).toBe(false);
    });
  });

  describe("looksLikeSsoBridgeChallenge", () => {
    const validHex64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    it("returns true for 64-char lowercase hex string", () => {
      expect(looksLikeSsoBridgeChallenge(validHex64)).toBe(true);
      expect(looksLikeSsoBridgeChallenge("f".repeat(64))).toBe(true);
    });

    it("returns false for non-string, null, or undefined inputs", () => {
      expect(looksLikeSsoBridgeChallenge(null)).toBe(false);
      expect(looksLikeSsoBridgeChallenge(undefined)).toBe(false);
      expect(looksLikeSsoBridgeChallenge(0 as unknown as string)).toBe(false);
    });

    it("returns false for invalid length or non-hex characters", () => {
      expect(looksLikeSsoBridgeChallenge("f".repeat(63))).toBe(false);
      expect(looksLikeSsoBridgeChallenge("f".repeat(65))).toBe(false);
      expect(looksLikeSsoBridgeChallenge("F".repeat(64))).toBe(false);
      expect(looksLikeSsoBridgeChallenge("z".repeat(64))).toBe(false);
      expect(looksLikeSsoBridgeChallenge(` ${validHex64}`)).toBe(false);
    });
  });
});

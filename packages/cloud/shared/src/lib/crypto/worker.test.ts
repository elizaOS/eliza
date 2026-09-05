/**
 * Locks worker-safe crypto helpers to standard byte, Unicode, encoding, hash,
 * and unequal-length vectors without relying on Node-only crypto APIs.
 */

import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  constantTimeEqualBytes,
  constantTimeEqualUtf8,
  sha256Base64Url,
  sha256Hex,
  stringToBase64Url,
  utf8Bytes,
} from "./worker";

describe("worker crypto primitives", () => {
  it("matches SHA-256 hex and base64url standard vectors", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Base64Url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });

  it("round-trips bytes and UTF-8 through unpadded base64url", () => {
    const bytes = new Uint8Array([0, 255, 1, 254]);
    expect(bytesToBase64Url(bytes)).toBe("AP8B_g");
    expect(base64UrlToBytes("AP8B_g")).toEqual(bytes);
    expect(stringToBase64Url("café")).toBe("Y2Fmw6k");
    expect(bytesToHex(utf8Bytes("é"))).toBe("c3a9");
  });

  it("compares full byte and UTF-8 inputs including length mismatches", () => {
    expect(constantTimeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqualBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
    expect(constantTimeEqualUtf8("café", "café")).toBe(true);
    expect(constantTimeEqualUtf8("café", "cafe")).toBe(false);
    expect(constantTimeEqualUtf8("secret", "secret-padding")).toBe(false);
  });
});

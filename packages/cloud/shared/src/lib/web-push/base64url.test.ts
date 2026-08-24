import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, stringToBase64Url } from "./base64url.js";

describe("base64url", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(base64UrlToBytes(encoded)).toEqual(bytes);
  });

  it("encodes empty", () => {
    expect(bytesToBase64Url(new Uint8Array([]))).toBe("");
    expect(base64UrlToBytes("")).toEqual(new Uint8Array([]));
  });

  it("encodes string to base64url", () => {
    const encoded = stringToBase64Url("hello");
    expect(typeof encoded).toBe("string");
    const decoded = new TextDecoder().decode(base64UrlToBytes(encoded));
    expect(decoded).toBe("hello");
  });

  it("handles padded input", () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const b64 = bytesToBase64Url(bytes);
    expect(base64UrlToBytes(b64)).toEqual(bytes);
  });
});

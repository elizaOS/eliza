/**
 * Coverage for OIDC crypto helpers.
 */
import { describe, expect, it } from "vitest";

import { base64UrlEncode, createOpaqueHex, sha256Base64Url, sha256Hex } from "./crypto.js";

describe("createOpaqueHex", () => {
  it("returns 64 lowercase hex chars", () => {
    const hex = createOpaqueHex();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different values", () => {
    expect(createOpaqueHex()).not.toBe(createOpaqueHex());
  });
});

describe("sha256Hex", () => {
  it("hashes empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes hello", async () => {
    expect(await sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("base64UrlEncode", () => {
  it("encodes known bytes", () => {
    expect(base64UrlEncode(new Uint8Array([0, 1, 2]))).toBe("AAEC");
  });

  it("strips padding and uses url-safe chars", () => {
    const bytes = new Uint8Array([255, 255]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("round-trips empty", () => {
    expect(base64UrlEncode(new Uint8Array([]))).toBe("");
  });
});

describe("sha256Base64Url", () => {
  it("is base64url of sha256", async () => {
    const out = await sha256Base64Url("hello");
    expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(out).not.toContain("=");
    expect(out).toBe("LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ");
  });
});

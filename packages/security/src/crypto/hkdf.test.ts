import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hkdfSha256 } from "./hkdf.js";

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function expandReference(
  ikm: Uint8Array,
  length: number,
  info = new Uint8Array(0),
  salt = new Uint8Array(0),
): Uint8Array {
  const effectiveSalt = salt.length > 0 ? salt : new Uint8Array(32);
  const prk = createHmac("sha256", effectiveSalt).update(ikm).digest();
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(chunks).length < length; counter += 1) {
    previous = createHmac("sha256", prk)
      .update(previous)
      .update(info)
      .update(Uint8Array.of(counter))
      .digest();
    chunks.push(previous);
  }
  return new Uint8Array(Buffer.concat(chunks).subarray(0, length));
}

describe("hkdfSha256", () => {
  it("matches an independent RFC 5869 expand/extract reference", () => {
    const ikm = Buffer.from("input keying material");
    const salt = Buffer.from("salt");
    const info = Buffer.from("context");

    const derived = hkdfSha256(ikm, 42, info, salt);

    expect(hex(derived)).toBe(hex(expandReference(ikm, 42, info, salt)));
  });

  it("uses empty salt and info by default and returns the requested length", () => {
    const derived = hkdfSha256(Buffer.from("ikm"), 17);

    expect(derived).toHaveLength(17);
    expect(hex(derived)).toBe(hex(expandReference(Buffer.from("ikm"), 17)));
  });

  it("changes output when salt or info changes", () => {
    const ikm = Buffer.from("ikm");
    const base = hkdfSha256(ikm, 32, Buffer.from("info-a"), Buffer.from("salt-a"));

    expect(hex(hkdfSha256(ikm, 32, Buffer.from("info-b"), Buffer.from("salt-a")))).not.toBe(
      hex(base),
    );
    expect(hex(hkdfSha256(ikm, 32, Buffer.from("info-a"), Buffer.from("salt-b")))).not.toBe(
      hex(base),
    );
  });

  it("rejects invalid output lengths", () => {
    expect(() => hkdfSha256(Buffer.from("ikm"), 0)).toThrow("hkdf length out of range: 0");
    expect(() => hkdfSha256(Buffer.from("ikm"), 255 * 32 + 1)).toThrow(
      `hkdf length out of range: ${255 * 32 + 1}`,
    );
  });
});

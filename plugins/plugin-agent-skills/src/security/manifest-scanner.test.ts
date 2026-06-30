import { describe, expect, it } from "vitest";
import { buildManifestEntriesFromMemory } from "./manifest-scanner";

/**
 * Tests for the in-memory skill-manifest builder (#8801 / #9943). The manifest
 * feeds the security scanner / integrity check, so the per-file size must be the
 * UTF-8 BYTE length (not the character count) — otherwise non-ASCII files report
 * a wrong size. It was untested.
 */
describe("buildManifestEntriesFromMemory", () => {
  it("returns an empty manifest for no files", () => {
    expect(buildManifestEntriesFromMemory(new Map())).toEqual([]);
  });

  it("measures text size in UTF-8 bytes, not characters", () => {
    const files = new Map([
      ["a.txt", { content: "hello", isText: true }], // 5 ASCII bytes
      ["u.txt", { content: "café", isText: true }], // é = 2 bytes -> 5
      ["e.txt", { content: "🎉", isText: true }], // 1 char, 4 bytes
    ]);
    const size = Object.fromEntries(
      buildManifestEntriesFromMemory(files).map((e) => [e.relativePath, e.sizeBytes]),
    );
    expect(size["a.txt"]).toBe(5);
    expect(size["u.txt"]).toBe(5);
    expect(size["e.txt"]).toBe(4);
  });

  it("uses byteLength for binary content and preserves the path", () => {
    const files = new Map([
      ["b.bin", { content: new Uint8Array([1, 2, 3, 4, 5, 6, 7]), isText: false }],
    ]);
    const [entry] = buildManifestEntriesFromMemory(files);
    expect(entry.sizeBytes).toBe(7);
    expect(entry.relativePath).toBe("b.bin");
  });

  it("marks every entry as a non-symlink", () => {
    const files = new Map([["x", { content: "y", isText: true }]]);
    expect(buildManifestEntriesFromMemory(files).every((e) => e.isSymlink === false)).toBe(true);
  });
});

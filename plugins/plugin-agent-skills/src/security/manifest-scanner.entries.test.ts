/**
 * Covers buildManifestEntriesFromMemory pure helper.
 * Converts in-memory file maps to manifest entries with sizeBytes.
 */

import { describe, expect, it } from "vitest";

import { buildManifestEntriesFromMemory } from "./manifest-scanner.ts";

describe("buildManifestEntriesFromMemory", () => {
  it("returns empty for empty map", () => {
    expect(buildManifestEntriesFromMemory(new Map())).toEqual([]);
  });

  it("converts string content to sizeBytes via UTF-8 byte length", () => {
    const files = new Map([["a.txt", { content: "hello", isText: true }]]);
    const entries = buildManifestEntriesFromMemory(files);
    expect(entries).toHaveLength(1);
    expect(entries[0].relativePath).toBe("a.txt");
    expect(entries[0].sizeBytes).toBe(5);
    expect(entries[0].isSymlink).toBe(false);
  });

  it("handles Uint8Array content", () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    const files = new Map([["b.bin", { content: buf, isText: false }]]);
    const entries = buildManifestEntriesFromMemory(files);
    expect(entries[0].sizeBytes).toBe(4);
  });

  it("handles multi-byte UTF-8 string correctly", () => {
    const files = new Map([["c.txt", { content: "é", isText: true }]]); // 2 bytes in UTF-8
    const entries = buildManifestEntriesFromMemory(files);
    expect(entries[0].sizeBytes).toBe(2);
  });

  it("handles multiple files", () => {
    const files = new Map([
      ["a.txt", { content: "hi", isText: true }],
      ["b.bin", { content: new Uint8Array([1, 2]), isText: false }],
    ]);
    const entries = buildManifestEntriesFromMemory(files);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.relativePath).sort()).toEqual(["a.txt", "b.bin"]);
  });

  it("preserves isSymlink false for all entries", () => {
    const files = new Map([
      ["x", { content: "y", isText: true }],
      ["z", { content: new Uint8Array(0), isText: true }],
    ]);
    const entries = buildManifestEntriesFromMemory(files);
    for (const e of entries) expect(e.isSymlink).toBe(false);
  });

  it("handles empty string and empty buffer", () => {
    const files = new Map([
      ["empty.txt", { content: "", isText: true }],
      ["empty.bin", { content: new Uint8Array(0), isText: false }],
    ]);
    const entries = buildManifestEntriesFromMemory(files);
    expect(entries.find((e) => e.relativePath === "empty.txt")?.sizeBytes).toBe(0);
    expect(entries.find((e) => e.relativePath === "empty.bin")?.sizeBytes).toBe(0);
  });
});

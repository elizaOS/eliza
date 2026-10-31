import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DiskStore } from "./disk-store.ts";
import type { ToolCacheEntry } from "./types.ts";

const KEY = `ab${"c".repeat(62)}`;

function entry(): ToolCacheEntry {
  return {
    key: KEY,
    toolName: "web_search",
    toolVersion: "1",
    cachedAt: 1,
    expiresAt: 9_999_999_999_999,
    output: { ok: true },
  };
}

function fileFor(root: string): string {
  return path.join(root, KEY.slice(0, 2), `${KEY}.json`);
}

describe("DiskStore.read with a corrupt entry", () => {
  it("returns the entry for a valid file", () => {
    const store = new DiskStore(
      mkdtempSync(path.join(tmpdir(), "disk-store-")),
      (value) => value,
    );
    store.write(entry());
    expect(store.read(KEY)?.toolName).toBe("web_search");
  });

  it("returns undefined and evicts a truncated file instead of throwing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "disk-store-"));
    const store = new DiskStore(root, (value) => value);
    store.write(entry());
    writeFileSync(fileFor(root), `{"key":"${KEY}","toolName":"web_sea`, "utf8");
    expect(store.read(KEY)).toBeUndefined();
    expect(existsSync(fileFor(root))).toBe(false);
  });

  it("returns undefined and evicts a non-JSON file instead of throwing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "disk-store-"));
    const store = new DiskStore(root, (value) => value);
    store.write(entry());
    writeFileSync(fileFor(root), "not-json{{{", "utf8");
    expect(store.read(KEY)).toBeUndefined();
    expect(existsSync(fileFor(root))).toBe(false);
  });

  it("returns undefined for a non-object entry instead of throwing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "disk-store-"));
    const store = new DiskStore(root, (value) => value);
    store.write(entry());
    writeFileSync(fileFor(root), "42", "utf8");
    expect(store.read(KEY)).toBeUndefined();
  });
});

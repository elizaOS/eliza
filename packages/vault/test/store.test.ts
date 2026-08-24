/**
 * Behavioral coverage for the legacy JSON vault store used by one-shot
 * migration. Exercises real filesystem reads and writes in a per-test temp
 * directory: ENOENT handling, atomic 0600 writes, orphaned-tmp cleanup on
 * failed renames, round-trips across all three entry kinds, and every
 * StoreFormatError rejection shape readStore can produce.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readStore,
  removeEntry,
  type StoreData,
  setEntry,
  writeStore,
} from "../src/store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "vault-store-test-"));
  tempDirs.push(dir);
  return dir;
}

function sampleStore(): StoreData {
  return {
    version: 1,
    entries: {
      api_key: { kind: "value", value: "abc123", lastModified: 100 },
      token: { kind: "secret", ciphertext: "v1:n:t:c", lastModified: 200 },
      op: {
        kind: "reference",
        source: "1password",
        path: "op://Vault/Item/Field",
        lastModified: 300,
      },
    },
  };
}

describe("readStore", () => {
  it("returns an empty version-1 store for a missing file", async () => {
    const dir = await makeTempDir();
    const store = await readStore(join(dir, "vault.json"));
    expect(store).toEqual({ version: 1, entries: {} });
  });

  it("round-trips value, secret, and reference entries", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    const written = sampleStore();
    await writeStore(path, written);
    expect(await readStore(path)).toEqual(written);
  });

  it("persists the store with file mode 0600", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await writeStore(path, sampleStore());
    const stat = await fs.stat(path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("rethrows non-ENOENT read errors instead of returning an empty store", async () => {
    const dir = await makeTempDir();
    const dirPath = join(dir, "vault.json");
    await fs.mkdir(dirPath);
    await expect(readStore(dirPath)).rejects.toThrow();
  });

  it("rejects unparseable JSON with a parse-error format failure", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(path, "{not json", "utf8");
    await expect(readStore(path)).rejects.toThrow(/vault store: parse error:/);
  });

  it("rejects a non-object root", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(path, "[1,2]", "utf8");
    await expect(readStore(path)).rejects.toThrow(
      "vault store: root must be an object",
    );
  });

  it("rejects a missing or non-numeric version", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(path, JSON.stringify({ entries: {} }), "utf8");
    await expect(readStore(path)).rejects.toThrow(
      "vault store: version must be a number",
    );
  });

  it("rejects a store version newer than supported", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(
      path,
      JSON.stringify({ version: 2, entries: {} }),
      "utf8",
    );
    await expect(readStore(path)).rejects.toThrow(/newer than supported/);
  });

  it("rejects a missing or non-object entries record", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(path, JSON.stringify({ version: 1 }), "utf8");
    await expect(readStore(path)).rejects.toThrow(
      "vault store: entries must be an object",
    );
  });

  it("rejects entries of unknown kind", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: { x: { kind: "mystery", lastModified: 1 } },
      }),
      "utf8",
    );
    await expect(readStore(path)).rejects.toThrow(/unknown kind/);
  });

  it("rejects secret entries without ciphertext", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: { x: { kind: "secret", lastModified: 1 } },
      }),
      "utf8",
    );
    await expect(readStore(path)).rejects.toThrow(/missing ciphertext/);
  });

  it("rejects reference entries from unsupported sources", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: {
          x: {
            kind: "reference",
            source: "bitwarden",
            path: "p",
            lastModified: 1,
          },
        },
      }),
      "utf8",
    );
    await expect(readStore(path)).rejects.toThrow(/invalid reference source/);
  });

  it("rejects reference entries without a path", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: {
          x: { kind: "reference", source: "protonpass", lastModified: 1 },
        },
      }),
      "utf8",
    );
    await expect(readStore(path)).rejects.toThrow(/missing reference path/);
  });

  it("rejects value entries whose payload is not a string", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: { x: { kind: "value", value: 42, lastModified: 1 } },
      }),
      "utf8",
    );
    await expect(readStore(path)).rejects.toThrow(/value must be a string/);
  });

  it("rejects entries whose lastModified is not a number", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "vault.json");
    await fs.writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: { x: { kind: "value", value: "v" } },
      }),
      "utf8",
    );
    await expect(readStore(path)).rejects.toThrow(
      /lastModified must be a number/,
    );
  });
});

describe("writeStore failures", () => {
  it("rethrows and leaves no orphaned tmp file when the rename fails", async () => {
    const dir = await makeTempDir();
    // Renaming the tmp file onto this non-empty directory fails, forcing the
    // cleanup-and-rethrow branch without mocking anything.
    const target = join(dir, "occupied");
    await fs.mkdir(target);
    await fs.writeFile(join(target, "blocker"), "x", "utf8");
    await expect(writeStore(target, sampleStore())).rejects.toThrow();
    const leftovers = (await fs.readdir(dir)).filter((name) =>
      name.includes(".tmp."),
    );
    expect(leftovers).toEqual([]);
  });
});

describe("setEntry", () => {
  it("adds an entry immutably while preserving the version", () => {
    const before: StoreData = { version: 1, entries: {} };
    const after = setEntry(before, "k", {
      kind: "value",
      value: "v",
      lastModified: 1,
    });
    expect(after.version).toBe(1);
    expect(after.entries.k).toEqual({
      kind: "value",
      value: "v",
      lastModified: 1,
    });
    expect(Object.keys(before.entries)).toEqual([]);
  });

  it("overwrites an existing key without touching other keys", () => {
    const before = sampleStore();
    const after = setEntry(before, "api_key", {
      kind: "value",
      value: "rotated",
      lastModified: 999,
    });
    expect(after.entries.api_key).toEqual({
      kind: "value",
      value: "rotated",
      lastModified: 999,
    });
    expect(after.entries.token).toBe(before.entries.token);
    expect(before.entries.api_key).toEqual({
      kind: "value",
      value: "abc123",
      lastModified: 100,
    });
  });
});

describe("removeEntry", () => {
  it("drops a present key immutably while preserving the version", () => {
    const before = sampleStore();
    const after = removeEntry(before, "token");
    expect(after.entries.token).toBeUndefined();
    expect(after.version).toBe(1);
    expect(before.entries.token).toBeDefined();
  });

  it("returns the identical store when removing a missing key", () => {
    const before = sampleStore();
    expect(removeEntry(before, "does-not-exist")).toBe(before);
  });
});

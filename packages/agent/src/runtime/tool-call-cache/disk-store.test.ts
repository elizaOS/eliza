/**
 * Unit coverage for DiskStore, the on-disk tier of the tool-call cache.
 *
 * Drives the real class against a temp directory: layout (`<root>/<sha-prefix>/<key>.json`),
 * missing and present reads, key-mismatch rejection, redactor application,
 * degraded-write eviction, delete/clear of missing paths, and overwrite.
 * No production module is mocked.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiskStore } from "./disk-store.ts";
import {
  REDACT_BOUNDED_SENTINEL,
  REDACT_BUDGET_SENTINEL,
  REDACT_CYCLE_SENTINEL,
  REDACT_DEPTH_SENTINEL,
} from "./redact.ts";
import type { PrivacyRedactor, ToolCacheEntry } from "./types.ts";

const passthroughRedact: PrivacyRedactor = (value) => value;

const KEY_AB = `ab${"0".repeat(62)}`;
const KEY_AB_SIBLING = `ab${"1".repeat(62)}`;
const KEY_CD = `cd${"2".repeat(62)}`;

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "disk-store-test-"));
});

afterEach(() => {
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

function entry(
  key: string,
  extras: {
    toolName?: string;
    toolVersion?: string;
    cachedAt?: number;
    expiresAt?: number;
    output?: ToolCacheEntry["output"];
  } = {},
): ToolCacheEntry {
  const toolName = extras.toolName;
  const toolVersion = extras.toolVersion;
  const cachedAt = extras.cachedAt;
  const expiresAt = extras.expiresAt;
  const output = extras.output;
  return {
    key,
    toolName: toolName === undefined ? "web_search" : toolName,
    toolVersion: toolVersion === undefined ? "1" : toolVersion,
    cachedAt: cachedAt === undefined ? 1_000 : cachedAt,
    expiresAt: expiresAt === undefined ? 2_000 : expiresAt,
    output: output === undefined ? { ok: true } : output,
  };
}

function fileFor(root: string, key: string): string {
  return path.join(root, key.slice(0, 2), `${key}.json`);
}

function storeWith(redact: PrivacyRedactor = passthroughRedact): DiskStore {
  return new DiskStore(tempRoot, redact);
}

describe("DiskStore.read", () => {
  it("returns undefined when the file is missing", () => {
    const store = storeWith();
    expect(store.read(KEY_AB)).toBeUndefined();
    expect(existsSync(fileFor(tempRoot, KEY_AB))).toBe(false);
  });

  it("returns the persisted entry after a successful write", () => {
    const store = storeWith();
    const written = entry(KEY_AB, {
      toolName: "web_fetch",
      toolVersion: "3",
      cachedAt: 10,
      expiresAt: 20,
      output: { body: "hello" },
    });
    store.write(written);
    expect(store.read(KEY_AB)).toEqual(written);
  });

  it("returns undefined when the stored key does not match the lookup key", () => {
    const store = storeWith();
    store.write(entry(KEY_AB, { output: "kept" }));
    const file = fileFor(tempRoot, KEY_AB);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ToolCacheEntry;
    writeFileSync(file, JSON.stringify({ ...parsed, key: KEY_CD }), "utf8");
    expect(store.read(KEY_AB)).toBeUndefined();
    expect(existsSync(file)).toBe(true);
  });

  it("throws when the on-disk row is not JSON", () => {
    const store = storeWith();
    const file = fileFor(tempRoot, KEY_AB);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "not-json{", "utf8");
    expect(() => store.read(KEY_AB)).toThrow();
  });

  it("does not alias the on-disk row through the returned object", () => {
    const store = storeWith();
    store.write(entry(KEY_AB, { output: { n: 1 } }));
    const first = store.read(KEY_AB);
    expect(first).toBeDefined();
    if (
      first === undefined ||
      typeof first.output !== "object" ||
      first.output === null
    ) {
      throw new Error("expected object output");
    }
    (first.output as { n: number }).n = 99;
    expect(store.read(KEY_AB)).toEqual(entry(KEY_AB, { output: { n: 1 } }));
  });
});

describe("DiskStore.write", () => {
  it("creates the two-character prefix directory and the key json file", () => {
    const store = storeWith();
    store.write(entry(KEY_AB));
    const file = fileFor(tempRoot, KEY_AB);
    expect(file).toBe(path.join(tempRoot, "ab", `${KEY_AB}.json`));
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as ToolCacheEntry;
    expect(onDisk).toEqual(entry(KEY_AB));
  });

  it("places keys that share a prefix in the same directory", () => {
    const store = storeWith();
    store.write(entry(KEY_AB, { output: "a" }));
    store.write(entry(KEY_AB_SIBLING, { output: "b" }));
    expect(path.dirname(fileFor(tempRoot, KEY_AB))).toBe(
      path.dirname(fileFor(tempRoot, KEY_AB_SIBLING)),
    );
    expect(store.read(KEY_AB)?.output).toBe("a");
    expect(store.read(KEY_AB_SIBLING)?.output).toBe("b");
  });

  it("keeps distinct prefixes in distinct directories", () => {
    const store = storeWith();
    store.write(entry(KEY_AB));
    store.write(entry(KEY_CD));
    expect(path.dirname(fileFor(tempRoot, KEY_AB))).not.toBe(
      path.dirname(fileFor(tempRoot, KEY_CD)),
    );
    expect(existsSync(path.join(tempRoot, "ab"))).toBe(true);
    expect(existsSync(path.join(tempRoot, "cd"))).toBe(true);
  });

  it("overwrites an existing row for the same key", () => {
    const store = storeWith();
    store.write(entry(KEY_AB, { output: "first", toolVersion: "1" }));
    store.write(entry(KEY_AB, { output: "second", toolVersion: "2" }));
    expect(store.read(KEY_AB)).toEqual(
      entry(KEY_AB, { output: "second", toolVersion: "2" }),
    );
  });

  it("applies the privacy redactor to output before serialising", () => {
    const redact: PrivacyRedactor = (value) => {
      if (typeof value === "string")
        return value.replaceAll("SECRET", "<REDACTED>");
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(record)) {
          const field = record[key];
          out[key] =
            typeof field === "string"
              ? field.replaceAll("SECRET", "<REDACTED>")
              : field;
        }
        return out;
      }
      return value;
    };
    const store = storeWith(redact);
    store.write(entry(KEY_AB, { output: { body: "contains SECRET data" } }));
    const onDisk = JSON.parse(
      readFileSync(fileFor(tempRoot, KEY_AB), "utf8"),
    ) as ToolCacheEntry;
    expect(onDisk.output).toEqual({ body: "contains <REDACTED> data" });
    expect(store.read(KEY_AB)?.output).toEqual({
      body: "contains <REDACTED> data",
    });
  });

  it("does not mutate the caller entry when redacting", () => {
    const redact: PrivacyRedactor = (value) =>
      typeof value === "string" ? "redacted" : value;
    const store = storeWith(redact);
    const written = entry(KEY_AB, { output: "plain" });
    store.write(written);
    expect(written.output).toBe("plain");
    expect(store.read(KEY_AB)?.output).toBe("redacted");
  });

  it("does not persist a write whose redacted output is a cycle sentinel", () => {
    const store = storeWith(() => REDACT_CYCLE_SENTINEL);
    store.write(entry(KEY_AB, { output: "ok" }));
    expect(existsSync(fileFor(tempRoot, KEY_AB))).toBe(false);
    expect(store.read(KEY_AB)).toBeUndefined();
  });

  it("does not persist a write whose redacted output is a depth sentinel", () => {
    const store = storeWith(() => REDACT_DEPTH_SENTINEL);
    store.write(entry(KEY_AB, { output: "ok" }));
    expect(store.read(KEY_AB)).toBeUndefined();
  });

  it("does not persist a write whose redacted output is a budget sentinel", () => {
    const store = storeWith(() => REDACT_BUDGET_SENTINEL);
    store.write(entry(KEY_AB, { output: "ok" }));
    expect(store.read(KEY_AB)).toBeUndefined();
  });

  it("does not persist a write whose redacted output is a prior-head bounded sentinel", () => {
    const store = storeWith(() => REDACT_BOUNDED_SENTINEL);
    store.write(entry(KEY_AB, { output: "ok" }));
    expect(store.read(KEY_AB)).toBeUndefined();
  });

  it("treats a nested degradation sentinel as uncacheable", () => {
    const store = storeWith(() => ({ child: { leaf: REDACT_CYCLE_SENTINEL } }));
    store.write(entry(KEY_AB, { output: { child: { leaf: "ok" } } }));
    expect(existsSync(fileFor(tempRoot, KEY_AB))).toBe(false);
  });

  it("does not persist a cyclic redacted value", () => {
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    const store = storeWith(() => cyclic);
    store.write(entry(KEY_AB, { output: { ok: true } }));
    expect(existsSync(fileFor(tempRoot, KEY_AB))).toBe(false);
    expect(store.read(KEY_AB)).toBeUndefined();
  });

  it("evicts a prior successful row when a later write is degraded", () => {
    const store = new DiskStore(tempRoot, (value) => value);
    store.write(entry(KEY_AB, { output: { ok: "t1" } }));
    const file = fileFor(tempRoot, KEY_AB);
    expect(existsSync(file)).toBe(true);

    const degraded = new DiskStore(tempRoot, () => REDACT_DEPTH_SENTINEL);
    degraded.write(entry(KEY_AB, { output: { ok: "t2" } }));
    expect(existsSync(file)).toBe(false);
    expect(store.read(KEY_AB)).toBeUndefined();
  });

  it("lays a single-character key under a one-character prefix", () => {
    const store = storeWith();
    store.write(entry("a", { output: 1 }));
    expect(existsSync(path.join(tempRoot, "a", "a.json"))).toBe(true);
    expect(store.read("a")?.output).toBe(1);
  });

  it("stores an empty key as .json directly under the root", () => {
    const store = storeWith();
    store.write(entry("", { output: "empty" }));
    expect(existsSync(path.join(tempRoot, ".json"))).toBe(true);
    expect(store.read("")?.output).toBe("empty");
  });

  it("persists primitive and array outputs", () => {
    const store = storeWith();
    store.write(entry(KEY_AB, { output: null }));
    expect(store.read(KEY_AB)?.output).toBeNull();
    store.write(entry(KEY_AB, { output: 0 }));
    expect(store.read(KEY_AB)?.output).toBe(0);
    store.write(entry(KEY_AB, { output: false }));
    expect(store.read(KEY_AB)?.output).toBe(false);
    store.write(entry(KEY_AB, { output: ["x", { y: 1 }] }));
    expect(store.read(KEY_AB)?.output).toEqual(["x", { y: 1 }]);
  });
});

describe("DiskStore.delete", () => {
  it("removes an existing row and leaves siblings in the same prefix", () => {
    const store = storeWith();
    store.write(entry(KEY_AB, { output: "keep-me-not" }));
    store.write(entry(KEY_AB_SIBLING, { output: "sibling" }));
    store.delete(KEY_AB);
    expect(store.read(KEY_AB)).toBeUndefined();
    expect(existsSync(fileFor(tempRoot, KEY_AB))).toBe(false);
    expect(store.read(KEY_AB_SIBLING)?.output).toBe("sibling");
  });

  it("is a no-op when the row is missing", () => {
    const store = storeWith();
    expect(() => store.delete(KEY_AB)).not.toThrow();
    expect(store.read(KEY_AB)).toBeUndefined();
  });

  it("is a no-op when the root directory does not exist", () => {
    rmSync(tempRoot, { recursive: true, force: true });
    const store = storeWith();
    expect(() => store.delete(KEY_AB)).not.toThrow();
  });
});

describe("DiskStore.clear", () => {
  it("removes the entire store root including every prefix", () => {
    const store = storeWith();
    store.write(entry(KEY_AB));
    store.write(entry(KEY_CD));
    store.clear();
    expect(existsSync(tempRoot)).toBe(false);
    expect(store.read(KEY_AB)).toBeUndefined();
    expect(store.read(KEY_CD)).toBeUndefined();
  });

  it("is a no-op when the root does not exist", () => {
    rmSync(tempRoot, { recursive: true, force: true });
    const store = storeWith();
    expect(() => store.clear()).not.toThrow();
    expect(existsSync(tempRoot)).toBe(false);
  });

  it("allows a later write after clearing", () => {
    const store = storeWith();
    store.write(entry(KEY_AB, { output: "old" }));
    store.clear();
    store.write(entry(KEY_AB, { output: "new" }));
    expect(store.read(KEY_AB)?.output).toBe("new");
  });
});

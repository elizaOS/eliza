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
  readdirSync,
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

  it("returns undefined and evicts when the stored key does not match the lookup key", () => {
    const store = storeWith();
    store.write(entry(KEY_AB, { output: "kept" }));
    const file = fileFor(tempRoot, KEY_AB);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ToolCacheEntry;
    writeFileSync(file, JSON.stringify({ ...parsed, key: KEY_CD }), "utf8");
    expect(store.read(KEY_AB)).toBeUndefined();
    // Previously the row was declined but left in place, so the mismatch was
    // re-detected on every future lookup and the key could never repopulate.
    expect(existsSync(file)).toBe(false);
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

  // --- rows this process did not write -------------------------------------
  // A row on disk may be truncated by a crash, left by an older layout, or
  // edited in the state directory. Each case must read as a miss AND evict the
  // file: the read path is called synchronously before the tool executor, so a
  // throw here fails the tool call outright, and a row it merely declines
  // without removing keeps failing that key on every future call.

  function writeRaw(key: string, bytes: string): string {
    const file = fileFor(tempRoot, key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes, "utf8");
    return file;
  }

  const MALFORMED: ReadonlyArray<readonly [string, string]> = [
    [
      "truncated mid-object (an interrupted write)",
      '{"key":"x","output":{"a":1',
    ],
    ["empty file", ""],
    ["not JSON at all", "<html>nope</html>"],
    ["valid JSON but null", "null"],
    ["valid JSON but an array", "[]"],
    ["valid JSON but a bare number", "123"],
  ];

  for (const [label, bytes] of MALFORMED) {
    it(`reads as a miss and evicts the file: ${label}`, () => {
      const file = writeRaw(KEY_AB, bytes);
      const store = storeWith();
      expect(() => store.read(KEY_AB)).not.toThrow();
      expect(store.read(KEY_AB)).toBeUndefined();
      expect(existsSync(file)).toBe(false);
    });
  }

  const NONCONFORMING: ReadonlyArray<
    readonly [string, Record<string, unknown>]
  > = [
    [
      "no expiresAt (would compare `undefined <= now` and never expire)",
      { toolName: "web_search", toolVersion: "1", cachedAt: 1, output: 1 },
    ],
    [
      "expiresAt is a string",
      {
        toolName: "web_search",
        toolVersion: "1",
        cachedAt: 1,
        expiresAt: "2000",
        output: 1,
      },
    ],
    [
      "expiresAt is NaN",
      {
        toolName: "web_search",
        toolVersion: "1",
        cachedAt: 1,
        expiresAt: Number.NaN,
        output: 1,
      },
    ],
    [
      "no cachedAt",
      { toolName: "web_search", toolVersion: "1", expiresAt: 2, output: 1 },
    ],
    [
      "no toolVersion (version invalidation could not fire)",
      { toolName: "web_search", cachedAt: 1, expiresAt: 2, output: 1 },
    ],
    [
      "toolVersion is a number",
      {
        toolName: "web_search",
        toolVersion: 1,
        cachedAt: 1,
        expiresAt: 2,
        output: 1,
      },
    ],
    ["no toolName", { toolVersion: "1", cachedAt: 1, expiresAt: 2, output: 1 }],
    [
      "no output at all",
      { toolName: "web_search", toolVersion: "1", cachedAt: 1, expiresAt: 2 },
    ],
  ];

  for (const [label, row] of NONCONFORMING) {
    it(`reads as a miss and evicts the file: ${label}`, () => {
      const file = writeRaw(KEY_AB, JSON.stringify({ key: KEY_AB, ...row }));
      const store = storeWith();
      expect(store.read(KEY_AB)).toBeUndefined();
      expect(existsSync(file)).toBe(false);
    });
  }

  it("reads as a miss when the row path is not a regular file", () => {
    // `readFileSync` raises EISDIR here and the eviction that follows cannot
    // remove a directory with a non-recursive `rmSync`, so both the read and
    // its own repair step have to absorb a failure.
    const file = fileFor(tempRoot, KEY_AB);
    mkdirSync(file, { recursive: true });
    writeFileSync(path.join(file, "occupied"), "x", "utf8");
    const store = storeWith();
    expect(() => store.read(KEY_AB)).not.toThrow();
    expect(store.read(KEY_AB)).toBeUndefined();
  });

  // Liveness control for the two tables above. Without it every "reads as a
  // miss" assertion would still pass if the validator rejected everything.
  const FALSY_OUTPUTS: ReadonlyArray<
    readonly [string, ToolCacheEntry["output"]]
  > = [
    ["null", null],
    ["zero", 0],
    ["false", false],
    ["empty string", ""],
    ["empty array", []],
    ["empty object", {}],
  ];

  for (const [label, output] of FALSY_OUTPUTS) {
    it(`still serves a conforming row whose output is ${label}`, () => {
      const store = storeWith();
      const written = entry(KEY_AB, { output });
      store.write(written);
      expect(store.read(KEY_AB)).toEqual(written);
      expect(existsSync(fileFor(tempRoot, KEY_AB))).toBe(true);
    });
  }
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

  // Writes publish atomically so a crash cannot leave the truncated row the
  // read path above has to defend against.
  it("leaves no temp file behind after a successful write", () => {
    const store = storeWith();
    store.write(entry(KEY_AB));
    const dir = path.dirname(fileFor(tempRoot, KEY_AB));
    expect(readdirSync(dir)).toEqual([`${KEY_AB}.json`]);
  });

  it("swallows a publish failure and cleans up its temp file", () => {
    const store = storeWith();
    // Make the destination un-renameable-onto in a way that survives on both
    // Linux and macOS: a directory sitting where the row file belongs. The
    // serialisation and temp write both succeed, so this exercises exactly the
    // window a crash would land in — after the bytes exist, before they are
    // published — and nothing may be left behind in it.
    const file = fileFor(tempRoot, KEY_AB);
    mkdirSync(file, { recursive: true });
    writeFileSync(path.join(file, "occupied"), "x", "utf8");

    // `write` runs inside `ToolCallCache.run`'s `.then`, after the tool has
    // already produced a result, so a raised fs error would discard a
    // successful tool call. Failing to cache must stay invisible to the caller.
    expect(() => store.write(entry(KEY_AB))).not.toThrow();

    const dir = path.dirname(file);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
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

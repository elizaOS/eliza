/**
 * Strict-validation tests for the persisted manifest shard/head envelope.
 * Deterministic unit suite: every case feeds untrusted-shaped JSON into the
 * validators and asserts typed rejection; no repo harness is mocked.
 */
import { describe, expect, it } from "vitest";
import type { CompactionContentEntry } from "./content-manifest";
import {
  ContentManifestIntegrityError,
  validateManifestHead,
  validateManifestShard,
} from "./content-manifest-shards";

const CREATED = "2026-08-27T00:00:00.000Z";

function entry(index: number): CompactionContentEntry {
  return {
    reference: { kind: "file", ref: `ref-${index}` },
    reason: "tool:FILE",
    rangesUsed: [{ unit: "byte", start: 0, end: 10 }],
    lastUsedAt: CREATED,
    retained: true,
  };
}

function shard(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ledgerId: "agent:trajectory:t1",
    sequence: 0,
    entries: [entry(0), entry(1)],
    entryCount: 2,
    byteLength: 512,
    entriesSha256: "a".repeat(64),
    chainSha256: "c".repeat(64),
    createdAt: CREATED,
    ...overrides,
  };
}

function head(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ledgerId: "agent:trajectory:t1",
    headSequence: 0,
    shardGeneration: "g0a1b2c3d4e5f6071",
    shardCount: 2,
    totalEntries: 4,
    totalRanges: 4,
    ledgerSha256: "b".repeat(64),
    revision: 3,
    updatedAt: CREATED,
    ...overrides,
  };
}

describe("validateManifestShard", () => {
  it("accepts a well-formed shard and reconstructs it canonically", () => {
    const value = shard();
    const validated = validateManifestShard(value);
    expect(validated.entryCount).toBe(2);
    expect(validated.prevSha256).toBeUndefined();
  });

  it("rejects unknown fields", () => {
    expect(() => validateManifestShard(shard({ extra: 1 }))).toThrow(
      ContentManifestIntegrityError,
    );
  });

  it("rejects an unsupported schema version", () => {
    expect(() => validateManifestShard(shard({ schemaVersion: 2 }))).toThrow(
      /unsupported/,
    );
  });

  it("rejects a sequence-0 shard carrying a chain link", () => {
    expect(() =>
      validateManifestShard(shard({ prevSha256: "c".repeat(64) })),
    ).toThrow(/prevSha256/);
  });

  it("rejects a non-zero shard without a chain link", () => {
    expect(() => validateManifestShard(shard({ sequence: 1 }))).toThrow(
      /prevSha256/,
    );
  });

  it("rejects nextSequence that is not sequence + 1", () => {
    expect(() => validateManifestShard(shard({ nextSequence: 3 }))).toThrow(
      /sequence \+ 1/,
    );
  });

  it("rejects entryCount that disagrees with entries length", () => {
    expect(() => validateManifestShard(shard({ entryCount: 3 }))).toThrow(
      /entryCount/,
    );
  });

  it("rejects malformed sha256 digests", () => {
    expect(() =>
      validateManifestShard(shard({ entriesSha256: "xyz" })),
    ).toThrow(/sha256/);
  });

  it("rejects a malformed createdAt timestamp", () => {
    expect(() =>
      validateManifestShard(shard({ createdAt: "2026-08-27" })),
    ).toThrow(/ISO-8601/);
  });

  it("rejects malformed entries through the frozen manifest validator", () => {
    expect(() =>
      validateManifestShard(
        shard({
          entries: [{ reference: { kind: "file" }, reason: "x" }],
          entryCount: 1,
        }),
      ),
    ).toThrow(/Invalid progressive content contract|manifest shard/);
  });

  it("rejects ledgerId with characters outside the opaque pattern", () => {
    expect(() =>
      validateManifestShard(shard({ ledgerId: "has space" })),
    ).toThrow(/ledgerId/);
  });
});

describe("validateManifestHead", () => {
  it("accepts a well-formed head", () => {
    expect(validateManifestHead(head()).revision).toBe(3);
  });

  it("rejects unknown fields", () => {
    expect(() => validateManifestHead(head({ nope: true }))).toThrow(
      ContentManifestIntegrityError,
    );
  });

  it("rejects a non-zero headSequence", () => {
    expect(() => validateManifestHead(head({ headSequence: 1 }))).toThrow(
      /first shard/,
    );
  });

  it("rejects an empty head with non-zero totals", () => {
    expect(() =>
      validateManifestHead(
        head({ shardCount: 0, totalEntries: 1, totalRanges: 0 }),
      ),
    ).toThrow(/zeroed/);
  });

  it("rejects shardCount above the traversal bound", () => {
    expect(() => validateManifestHead(head({ shardCount: 1025 }))).toThrow(
      /traversal bound/,
    );
  });

  it("rejects a negative revision", () => {
    expect(() => validateManifestHead(head({ revision: -1 }))).toThrow(
      /revision/,
    );
  });
});

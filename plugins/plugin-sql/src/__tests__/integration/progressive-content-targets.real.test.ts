/**
 * Exercises the SQL-owned progressive-content targets against real disk-backed
 * PGlite, including bounded manifest-last ingestion, authorization, adapter
 * reconstruction over the same data directory, exact paging, and cleanup.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runProgressiveContentTargetConformance } from "@elizaos/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createProgressiveSqlTargetFactory } from "../../testing/progressive-content-sql-targets";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await fs.rm(root, { recursive: true });
});

function corpusBytes(family: "document" | "memory" | "email") {
  const bytes = Buffer.alloc(96 * 1024, 0x61);
  const canaries = [
    { label: "beginning", text: `BEGIN-${family}-世界`, byteStart: 0 },
    { label: "boundary", text: `BOUNDARY-${family}-🧪`, byteStart: 65_520 },
    { label: "middle", text: `MIDDLE-${family}-世界`, byteStart: 72 * 1024 },
    { label: "end", text: `END-${family}-🧪`, byteStart: bytes.byteLength - 32 },
  ].map((canary) => ({
    ...canary,
    byteEnd: canary.byteStart + Buffer.byteLength(canary.text),
  }));
  for (const canary of canaries) bytes.write(canary.text, canary.byteStart);
  return { bytes, canaries };
}

describe("PGlite progressive-content target factories", () => {
  for (const family of ["document", "memory", "email"] as const) {
    it(`runs ${family} through native SQL paging and disk restart`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `sql-${family}-target-`));
      roots.push(root);
      const { bytes, canaries } = corpusBytes(family);
      const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
      let readCalls = 0;
      let maxReadBytes = 0;
      const factory = await createProgressiveSqlTargetFactory({ dataRoot: root, family });
      const target = await factory.create({
        object: {
          id: `${family}-sql-corpus-object`,
          family,
          byteLength: bytes.byteLength,
          sourceSha256,
          sourceRevision: sourceSha256,
          format: "unicode-text",
          authorizationScope: `${family}-authorized-room`,
          canaries,
        },
        source: {
          byteLength: bytes.byteLength,
          async read(offset, maximum = 64 * 1024) {
            const page = bytes.subarray(offset, offset + maximum);
            readCalls += 1;
            maxReadBytes = Math.max(maxReadBytes, page.byteLength);
            return page;
          },
        },
      });
      const result = await runProgressiveContentTargetConformance({
        manifestSha256: "a".repeat(64),
        adapterId: factory.adapterId,
        target,
        performanceCeilings: { maxRssGrowthBytes: 256 * 1024 * 1024 },
      });
      expect(result.report).toMatchObject({
        status: "passed",
        restartVerified: true,
        concurrencyVerified: true,
        repeatedPageVerified: true,
        cleanupVerified: true,
        postCleanupProbeVerified: true,
        reassembledSha256: sourceSha256,
      });
      expect(target.realization).toMatchObject({
        sourceRevision: sourceSha256,
        authorizationMode: "principal",
        restartScope: "resolver",
      });
      expect(readCalls).toBe(2);
      expect(maxReadBytes).toBeLessThanOrEqual(64 * 1024);
      expect(result.receipts.every(({ status }) => status === "passed")).toBe(true);
      expect(
        result.receipts.find(({ phase }) => phase === "realized")?.after.databaseRows
      ).toBeGreaterThan(1);
      expect(await fs.readdir(root)).toEqual([]);
    }, 120_000);
  }

  it("rolls back staged rows when the manifest-last parent commit fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sql-target-rollback-"));
    roots.push(root);
    const { bytes, canaries } = corpusBytes("memory");
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const commitFailure = Object.assign(new Error("injected parent commit failure"), {
      code: "CONTENT_PARENT_COMMIT_FAILED",
    });
    const factory = await createProgressiveSqlTargetFactory({
      dataRoot: root,
      family: "memory",
      injectBeforeParentCommit: async () => {
        throw commitFailure;
      },
    });
    await expect(
      factory.create({
        object: {
          id: "memory-sql-rollback-object",
          family: "memory",
          byteLength: bytes.byteLength,
          sourceSha256,
          sourceRevision: sourceSha256,
          format: "unicode-text",
          authorizationScope: "memory-rollback-room",
          canaries,
        },
        source: {
          byteLength: bytes.byteLength,
          async read(offset, maximum = 64 * 1024) {
            return bytes.subarray(offset, offset + maximum);
          },
        },
      })
    ).rejects.toMatchObject({ code: "CONTENT_PARENT_COMMIT_FAILED" });
    expect(await fs.readdir(root)).toEqual([]);
  }, 120_000);

  it("rejects invalid UTF-8 without publishing a parent or staged row", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sql-target-invalid-utf8-"));
    roots.push(root);
    const bytes = Buffer.alloc(4_096, 0x61);
    bytes[127] = 0xff;
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    let sourceBytesRead = 0;
    const factory = await createProgressiveSqlTargetFactory({
      dataRoot: root,
      family: "email",
    });
    await expect(
      factory.create({
        object: {
          id: "email-sql-invalid-utf8-object",
          family: "email",
          byteLength: bytes.byteLength,
          sourceSha256,
          sourceRevision: sourceSha256,
          format: "invalid-utf8",
          authorizationScope: "email-invalid-room",
          canaries: [],
        },
        source: {
          byteLength: bytes.byteLength,
          async read(offset, maximum = 64 * 1024) {
            const page = bytes.subarray(offset, offset + maximum);
            sourceBytesRead += page.byteLength;
            return page;
          },
        },
      })
    ).rejects.toMatchObject({ code: "CONTENT_INVALID_UTF8" });
    expect(sourceBytesRead).toBe(bytes.byteLength);
    expect(await fs.readdir(root)).toEqual([]);
  }, 120_000);

  it("rejects declared binary content before reading or creating storage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sql-target-binary-"));
    roots.push(root);
    const bytes = Buffer.from([0, 0xff, 1, 2]);
    let reads = 0;
    const factory = await createProgressiveSqlTargetFactory({
      dataRoot: root,
      family: "memory",
    });
    await expect(
      factory.create({
        object: {
          id: "memory-sql-binary-object",
          family: "memory",
          byteLength: bytes.byteLength,
          sourceSha256: createHash("sha256").update(bytes).digest("hex"),
          sourceRevision: "binary-source-revision",
          format: "binary",
          authorizationScope: "memory-binary-room",
          canaries: [],
        },
        source: {
          byteLength: bytes.byteLength,
          async read() {
            reads += 1;
            return bytes;
          },
        },
      })
    ).rejects.toMatchObject({ code: "CONTENT_BINARY_UNSUPPORTED" });
    expect(reads).toBe(0);
    expect(await fs.readdir(root)).toEqual([]);
  }, 120_000);
});

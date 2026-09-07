/** Runs the shared lifecycle and byte oracle through the package-owned production FILE target. */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runProgressiveContentTargetConformance } from "@elizaos/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createProgressiveFileTargetFactory } from "../testing/progressive-content-file-target.js";

describe("READ progressive-content conformance", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) {
      await fs.rm(root, { recursive: true });
    }
  });

  it("proves bounded realization, same-target access, restart, and cleanup", async () => {
    const targetRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "coding-file-target-"),
    );
    roots.push(targetRoot);
    const pattern = Buffer.from("世界🙂ABCDEF", "utf8");
    const bytes = Buffer.allocUnsafe(1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = pattern[index % pattern.length] ?? 0x41;
    }
    const canaries = [
      { label: "beginning", text: "B世界🙂ABCDE", byteStart: 0 },
      { label: "boundary", text: "D世界🙂ABCDE", byteStart: 65_536 },
      { label: "middle", text: "M世界🙂ABCDE", byteStart: 512 * 1024 },
      { label: "end", text: "E世界🙂ABCDE", byteStart: bytes.length - 16 },
    ].map((canary) => ({ ...canary, byteEnd: canary.byteStart + 16 }));
    for (const canary of canaries) bytes.write(canary.text, canary.byteStart);
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    let sourceReadCalls = 0;
    let sourceMaxRead = 0;
    const factory = await createProgressiveFileTargetFactory({
      targetRoot,
      agentId: "file-target-agent",
    });
    const target = await factory.create({
      object: {
        id: "coding-file-corpus-object",
        family: "file",
        byteLength: bytes.byteLength,
        sourceSha256,
        sourceRevision: sourceSha256,
        format: "unicode-text",
        authorizationScope: "file-target-room",
        canaries,
      },
      source: {
        byteLength: bytes.byteLength,
        async read(offset, maxBytes = 64 * 1024) {
          const page = bytes.subarray(offset, offset + maxBytes);
          sourceReadCalls += 1;
          sourceMaxRead = Math.max(sourceMaxRead, page.byteLength);
          return page;
        },
      },
    });
    expect(target.realization.sourceRevision).toBe(sourceSha256);
    expect(target.object.revision).not.toBe("");
    const result = await runProgressiveContentTargetConformance({
      manifestSha256: "a".repeat(64),
      adapterId: factory.adapterId,
      target,
      performanceCeilings: {
        maxRowsPerPage: 1,
        maxReadAmplification: 1.1,
        maxRssGrowthBytes: 192 * 1024 * 1024,
      },
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
    expect(sourceReadCalls).toBe(16);
    expect(sourceMaxRead).toBeLessThanOrEqual(64 * 1024);
    expect(result.receipts.every(({ status }) => status === "passed")).toBe(
      true,
    );
    expect(
      result.receipts.find(({ phase }) => phase === "authorization")?.probe
        .errorCode,
    ).toBe("CONTENT_ACCESS_DENIED");
    expect(
      result.receipts.find(({ phase }) => phase === "isolation")?.probe
        .errorCode,
    ).toBe("CONTENT_NOT_FOUND");
    expect(await fs.readdir(targetRoot)).toEqual([".blocked"]);
  });

  it.each([
    ["binary", Buffer.from([0, 0xff, 1]), "CONTENT_BINARY_UNSUPPORTED", 0],
    [
      "invalid-utf8",
      Buffer.from([0x61, 0xff, 0x62]),
      "CONTENT_INVALID_UTF8",
      1,
    ],
  ] as const)(
    "rejects %s without retaining a target file",
    async (format, bytes, code, expectedReads) => {
      const targetRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "coding-file-rejection-"),
      );
      roots.push(targetRoot);
      let reads = 0;
      const factory = await createProgressiveFileTargetFactory({
        targetRoot,
        agentId: "file-rejection-agent",
      });
      await expect(
        factory.create({
          object: {
            id: `coding-file-${format}-object`,
            family: "file",
            byteLength: bytes.byteLength,
            sourceSha256: createHash("sha256").update(bytes).digest("hex"),
            sourceRevision: `${format}-revision`,
            format,
            authorizationScope: "file-rejection-room",
            canaries: [],
          },
          source: {
            byteLength: bytes.byteLength,
            async read() {
              reads += 1;
              return bytes;
            },
          },
        }),
      ).rejects.toMatchObject({ code });
      expect(reads).toBe(expectedReads);
      expect(await fs.readdir(targetRoot)).toEqual([".blocked"]);
    },
  );
});

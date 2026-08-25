/** Tests the source-neutral target harness with deterministic byte-backed factories. */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildReadView } from "@elizaos/core";
import {
  PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
  type ProgressiveContentTargetFactory,
  progressiveContentReferenceKind,
} from "@elizaos/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateProgressiveContentCorpus,
  type ProgressiveContentFamily,
} from "./progressive-content.ts";
import { runProgressiveContentTargetHarness } from "./progressive-content-target-harness.ts";

class HarnessTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await rm(root, { recursive: true });
  }
});

function factory(
  family: ProgressiveContentFamily,
): ProgressiveContentTargetFactory {
  const stores = {
    file: "filesystem",
    document: "document-store",
    memory: "memory-store",
    email: "message-store",
    attachment: "content-addressed-media",
    "tool-output": "filesystem",
  } as const;
  return {
    schemaVersion: PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
    family,
    adapterId: `deterministic-${family}-target`,
    authoritativeStore: stores[family],
    productionMethod: `${family}.deterministic-byte-target`,
    binaryPolicy: "native-bytes",
    async create({ object, source }) {
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < source.byteLength; ) {
        const page = await source.read(offset, 4_096);
        chunks.push(page);
        offset += page.byteLength;
      }
      const bytes = Buffer.concat(chunks);
      const revision = `native:${createHash("sha256").update(bytes).digest("hex")}`;
      const kind = progressiveContentReferenceKind(family);
      let present = true;
      let generation = 1;
      const reference = {
        kind,
        ref: `${kind}:opaque:${object.id}`,
        revision,
        resumability: "restart-safe" as const,
      };
      return {
        family,
        object: {
          id: object.id,
          family: kind,
          byteLength: object.byteLength,
          sourceSha256: object.sourceSha256,
          revision,
          authorizationScope: object.authorizationScope,
          canaries: object.canaries,
        },
        realization: {
          reference,
          sourceRevision: object.sourceRevision,
          authorizationMode: "principal",
          restartScope: "process",
          authorizationScopeDigest: createHash("sha256")
            .update(object.authorizationScope)
            .digest("hex"),
          cleanupIdentity: `cleanup:${object.id}`,
          resolverBindingSha256: object.sourceSha256,
        },
        async read({ access, offset, limit, expectedRevision }) {
          if (!present || access === "isolated")
            throw new HarnessTargetError("CONTENT_NOT_FOUND");
          if (access === "unauthorized")
            throw new HarnessTargetError("CONTENT_ACCESS_DENIED");
          if (expectedRevision && expectedRevision !== revision)
            throw new HarnessTargetError("CONTENT_STALE_REVISION");
          const page = bytes.subarray(offset, offset + limit);
          const end = offset + page.byteLength;
          return {
            bytes: page,
            view: buildReadView({
              reference,
              slice: {
                range: {
                  unit: "byte",
                  start: offset,
                  end,
                  total: bytes.length,
                },
                hasPrevious: offset > 0,
                hasMore: end < bytes.length,
                ...(end < bytes.length ? { nextOffset: end } : {}),
                revision,
                completeness:
                  end < bytes.length ? "partial-recoverable" : "complete",
                sliceSha256: createHash("sha256").update(page).digest("hex"),
              },
            }),
            sourceWork: {
              readCalls: 1,
              bytesRead: page.byteLength,
              rowsRead: 1,
              parentScans: 0,
            },
          };
        },
        async restart() {
          generation += 1;
        },
        async inspect() {
          return {
            resolverGeneration: `${family}:${generation}`,
            present,
            ownedBytes: present ? bytes.byteLength : 0,
            databaseRows: present ? 1 : 0,
            temporaryArtifacts: 0,
            walBytes: 0,
          };
        },
        async cleanup() {
          present = false;
        },
      };
    },
  };
}

describe("progressive content target harness", () => {
  it("derives all evidence layers from the same six-family targets", async () => {
    const corpusRoot = await mkdtemp(
      path.join(tmpdir(), "progressive-target-harness-"),
    );
    roots.push(corpusRoot);
    const manifest = await generateProgressiveContentCorpus({
      outDir: corpusRoot,
      rootSeed: "target-harness",
      generatorRevision: "target-harness-test",
      profile: "micro",
    });
    const families: ProgressiveContentFamily[] = [
      "file",
      "document",
      "memory",
      "email",
      "attachment",
      "tool-output",
    ];
    const report = await runProgressiveContentTargetHarness({
      corpusRoot,
      manifest,
      factories: families.map(factory),
    });
    expect(report.status).toBe("passed");
    expect(report.entries).toHaveLength(manifest.objects.length);
    expect(report.entries.every(({ status }) => status === "verified")).toBe(
      true,
    );
    for (const entry of report.entries) {
      expect(entry.sourceWork.bytesRead).toBe(entry.sourceBytes);
      expect(entry.sourceRevision).toBe(entry.sourceSha256);
      expect(entry.nativeRevision).toMatch(/^native:[a-f0-9]{64}$/u);
      expect(entry.conformance?.reassembledSha256).toBe(entry.sourceSha256);
      expect(entry.receipts?.every(({ status }) => status === "passed")).toBe(
        true,
      );
    }
  }, 60_000);

  it("counts a bounded declared binary rejection as verified coverage", async () => {
    const corpusRoot = await mkdtemp(
      path.join(tmpdir(), "progressive-target-rejection-"),
    );
    roots.push(corpusRoot);
    const generated = await generateProgressiveContentCorpus({
      outDir: corpusRoot,
      rootSeed: "target-harness-rejection",
      generatorRevision: "target-harness-test",
      profile: "micro",
    });
    const document = generated.objects.find(
      ({ family }) => family === "document",
    );
    if (!document) throw new Error("generated corpus lacks a document");
    const rejectingDocument = {
      ...factory("document"),
      binaryPolicy: "typed-rejection" as const,
      async create() {
        throw new HarnessTargetError("CONTENT_BINARY_UNSUPPORTED");
      },
    };
    const families: ProgressiveContentFamily[] = [
      "file",
      "document",
      "memory",
      "email",
      "attachment",
      "tool-output",
    ];
    const report = await runProgressiveContentTargetHarness({
      corpusRoot,
      manifest: {
        ...generated,
        objects: [{ ...document, format: "binary" }],
      },
      factories: families.map((family) =>
        family === "document" ? rejectingDocument : factory(family),
      ),
    });
    expect(report.status).toBe("passed");
    expect(report.entries).toEqual([
      expect.objectContaining({
        status: "typed-rejected",
        code: "CONTENT_BINARY_UNSUPPORTED",
        rejectionCode: "CONTENT_BINARY_UNSUPPORTED",
      }),
    ]);
  });

  it("fails a typed-rejection factory that returns the wrong code", async () => {
    const corpusRoot = await mkdtemp(
      path.join(tmpdir(), "progressive-target-wrong-rejection-"),
    );
    roots.push(corpusRoot);
    const generated = await generateProgressiveContentCorpus({
      outDir: corpusRoot,
      rootSeed: "target-harness-wrong-rejection",
      generatorRevision: "target-harness-test",
      profile: "micro",
    });
    const document = generated.objects.find(
      ({ family }) => family === "document",
    );
    if (!document) throw new Error("generated corpus lacks a document");
    const rejectingDocument = {
      ...factory("document"),
      binaryPolicy: "typed-rejection" as const,
      async create() {
        throw new HarnessTargetError("CONTENT_INVALID_UTF8");
      },
    };
    const report = await runProgressiveContentTargetHarness({
      corpusRoot,
      manifest: {
        ...generated,
        objects: [{ ...document, format: "binary" }],
      },
      factories: [
        factory("file"),
        rejectingDocument,
        factory("memory"),
        factory("email"),
        factory("attachment"),
        factory("tool-output"),
      ],
    });
    expect(report.status).toBe("failed");
    expect(report.entries[0]).toMatchObject({
      status: "failed",
      code: "CONTENT_INVALID_UTF8",
    });
  });
});

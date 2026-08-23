/** Proves evidence validation reads artifact bytes and rejects semantic or cryptographic false success. */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildContentContextResult,
  CONTENT_CONTEXT_REQUIRED_ARTIFACTS,
  CONTENT_CONTEXT_RESULT_SCHEMA_VERSION,
  type ContentContextRequiredArtifact,
  validateContentContextResult,
} from "./progressive-content-evidence.ts";

const manifestSha = "b".repeat(64);

function evidence() {
  const objects = [
    "file",
    "document",
    "memory",
    "email",
    "attachment",
    "tool-output",
  ].flatMap((family) =>
    [1024 * 1024, 10 * 1024 * 1024].map((byteLength) => ({
      id: `${family}-${byteLength}`,
      family,
      byteLength,
      sourceSha256: "c".repeat(64),
      revision: `revision-${family}-${byteLength}`,
      authorizationScope: `scope-${family}`,
    })),
  );
  const values: Record<ContentContextRequiredArtifact, unknown> = {
    "corpus-manifest.json": {
      manifestSha256: manifestSha,
      objects,
    },
    "native-realization-ledger.json": {
      corpusManifestSha256: manifestSha,
      entries: objects.map((object) => ({
        status: "verified",
        objectId: object.id,
        family: object.family,
        sourceSha256: object.sourceSha256,
        sourceBytes: object.byteLength,
        revision: object.revision,
        authorizationScope: object.authorizationScope,
        sourceWork: {
          bytesRead: object.byteLength,
          maxReadBytes: 64 * 1024,
        },
      })),
    },
    "conformance.json": {
      reports: [
        {
          status: "passed",
          restartVerified: true,
          concurrencyVerified: true,
          repeatedPageVerified: true,
          cleanupVerified: true,
          postCleanupProbeVerified: true,
          performance: {
            maxPageLatencyMs: 2,
            rssGrowthBytes: 1024,
            readAmplification: 1,
            readCallsPerPageMax: 1,
            rowsPerPageMax: 1,
            ceilings: {
              maxPageLatencyMs: 100,
              maxRssGrowthBytes: 1024 * 1024,
              maxReadAmplification: 2,
              maxReadCallsPerPage: 2,
              maxRowsPerPage: 8,
            },
          },
        },
      ],
    },
    "mutant-kills.json": {
      status: "passed",
      required: 1,
      executed: 1,
      killed: 1,
      killRate: 1,
      results: [{ status: "killed", failureVectors: ["source-work"] }],
    },
    "source-work.json": {
      samples: [
        {
          rowsRead: 1,
          parentScans: 0,
          bytesRead: 1024,
          bytesReturned: 1024,
        },
      ],
    },
    "benchmark.json": {
      cases: [1024 * 1024, 10 * 1024 * 1024].map((sourceBytes) => ({
        sourceBytes,
        observed: {
          maxPageLatencyMs: 2,
          rssGrowthBytes: 1024,
          databaseGrowthBytes: 1024,
          readAmplification: 1,
        },
        ceilings: {
          maxPageLatencyMs: 100,
          rssGrowthBytes: 1024 * 1024,
          databaseGrowthBytes: sourceBytes * 2,
          readAmplification: 2,
        },
      })),
    },
    "cleanup.json": {
      status: "passed",
      restartVerified: true,
      authorizationVerified: true,
      probes: [{ absent: true }],
    },
  };
  const bytes = {} as Record<ContentContextRequiredArtifact, Uint8Array>;
  for (const name of CONTENT_CONTEXT_REQUIRED_ARTIFACTS) {
    bytes[name] = Buffer.from(JSON.stringify(values[name]));
  }
  const result = {
    schemaVersion: CONTENT_CONTEXT_RESULT_SCHEMA_VERSION,
    commit: "a".repeat(40),
    corpusManifestSha256: manifestSha,
    generatorRevision: "test-revision",
    status: "passed" as const,
    artifacts: CONTENT_CONTEXT_REQUIRED_ARTIFACTS.map((name) => ({
      name,
      sha256: createHash("sha256").update(bytes[name]).digest("hex"),
      bytes: bytes[name].byteLength,
    })),
  };
  return { result, bytes };
}

function replaceArtifact(
  original: ReturnType<typeof evidence>,
  name: ContentContextRequiredArtifact,
  value: unknown,
) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    result: {
      ...original.result,
      artifacts: original.result.artifacts.map((artifact) =>
        artifact.name === name
          ? {
              ...artifact,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              bytes: bytes.byteLength,
            }
          : artifact,
      ),
    },
    bytes: { ...original.bytes, [name]: bytes },
  };
}

describe("content-context result", () => {
  it("builds a producer result from the exact validated artifact bytes", () => {
    const { result, bytes } = evidence();
    expect(
      buildContentContextResult({
        commit: result.commit,
        corpusManifestSha256: result.corpusManifestSha256,
        generatorRevision: result.generatorRevision,
        artifactBytes: bytes,
      }),
    ).toEqual(result);
  });

  it("accepts cryptographically bound semantic proof", () => {
    const { result, bytes } = evidence();
    expect(validateContentContextResult(result, bytes)).toEqual(result);
  });

  it("rejects changed bytes even when every artifact remains named", () => {
    const { result, bytes } = evidence();
    expect(() =>
      validateContentContextResult(result, {
        ...bytes,
        "cleanup.json": Buffer.from("{}"),
      }),
    ).toThrow(/bytes differ/u);
  });

  it("rejects rehashed but semantically false cleanup success", () => {
    const changed = replaceArtifact(evidence(), "cleanup.json", {
      status: "passed",
      restartVerified: true,
      authorizationVerified: true,
      probes: [{ absent: false }],
    });
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/semantically invalid/u);
  });

  it("rejects rehashed mutant claims with no executable kill vector", () => {
    const changed = replaceArtifact(evidence(), "mutant-kills.json", {
      status: "passed",
      required: 1,
      executed: 1,
      killed: 1,
      killRate: 1,
      results: [{ status: "killed", failureVectors: [] }],
    });
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/semantic/u);
  });

  it("rejects aggregate scale coverage that omits one family's 10 MiB case", () => {
    const original = evidence();
    const manifest = JSON.parse(
      new TextDecoder().decode(original.bytes["corpus-manifest.json"]),
    ) as { objects: Array<{ family: string; byteLength: number }> };
    manifest.objects = manifest.objects.filter(
      (object) =>
        object.family !== "attachment" ||
        object.byteLength !== 10 * 1024 * 1024,
    );
    const changed = replaceArtifact(original, "corpus-manifest.json", manifest);
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/attachment missing 10485760 byte scale/u);
  });

  it("rejects a realization ledger that is not identity-bound to every object", () => {
    const original = evidence();
    const ledger = JSON.parse(
      new TextDecoder().decode(
        original.bytes["native-realization-ledger.json"],
      ),
    ) as { entries: unknown[] };
    ledger.entries.pop();
    const changed = replaceArtifact(
      original,
      "native-realization-ledger.json",
      ledger,
    );
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/does not cover every corpus object/u);
  });
});

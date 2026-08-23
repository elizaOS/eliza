/**
 * Exercises the strict content-context producer against real files and atomic
 * publication while keeping bundle creation outside the producer boundary.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseContentContextArgs,
  publishContentContextEvidence,
  resolveContentContextPaths,
} from "../run-content-context.mjs";

const repoRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../..",
);
const cleanup: string[] = [];
afterEach(async () => {
  for (const target of cleanup.splice(0)) {
    await rm(target, { recursive: true, force: true });
  }
});

function evidenceValues() {
  const manifestSha256 = "b".repeat(64);
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
  return {
    "corpus-manifest.json": {
      manifestSha256,
      generatorRevision: "producer-test-v1",
      objects,
    },
    "native-realization-ledger.json": {
      corpusManifestSha256: manifestSha256,
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
            maxPageLatencyMs: 1,
            rssGrowthBytes: 1,
            readAmplification: 1,
            readCallsPerPageMax: 1,
            rowsPerPageMax: 1,
            ceilings: {
              maxPageLatencyMs: 100,
              maxRssGrowthBytes: 1024,
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
        { rowsRead: 1, parentScans: 0, bytesRead: 1024, bytesReturned: 1024 },
      ],
    },
    "benchmark.json": {
      cases: [1024 * 1024, 10 * 1024 * 1024].map((sourceBytes) => ({
        sourceBytes,
        observed: {
          maxPageLatencyMs: 1,
          rssGrowthBytes: 1,
          databaseGrowthBytes: 1,
          readAmplification: 1,
        },
        ceilings: {
          maxPageLatencyMs: 100,
          rssGrowthBytes: 1024,
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
}

describe("run-content-context", () => {
  it("requires an assigned canonical run root", () => {
    expect(() =>
      resolveContentContextPaths({ source: "x", runRoot: "x" }),
    ).toThrow(/reports\/content-context/u);
    expect(
      parseContentContextArgs(["--source=a", "--run-root=b"]),
    ).toMatchObject({
      source: "a",
      runRoot: "b",
    });
  });

  it("validates exact bytes and atomically publishes a completeness manifest", async () => {
    const source = await mkdtemp(
      path.join(os.tmpdir(), "content-context-source-"),
    );
    cleanup.push(source);
    for (const [name, value] of Object.entries(evidenceValues())) {
      await writeFile(path.join(source, name), JSON.stringify(value), {
        mode: 0o600,
      });
    }
    const runId = `producer-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runRoot = path.join(repoRoot, "reports", "content-context", runId);
    cleanup.push(runRoot);
    await mkdir(path.dirname(runRoot), { recursive: true });

    const published = await publishContentContextEvidence({
      source,
      runRoot,
      commit: "a".repeat(40),
    });
    expect(published.result.status).toBe("passed");
    const completeness = JSON.parse(
      await readFile(path.join(runRoot, "completeness-manifest.json"), "utf8"),
    );
    expect(completeness).toMatchObject({
      schemaVersion: "elizaos.content-context.completeness.v1",
      commit: "a".repeat(40),
      status: "passed",
    });
    expect(completeness.requiredArtifacts).toContain("benchmark.json");
  });
});

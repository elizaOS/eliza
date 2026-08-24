/**
 * Exercises the strict content-context producer against real files and atomic
 * publication while keeping bundle creation outside the producer boundary.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBundle } from "../../evidence/src/bundle.ts";
import {
  captureSiloSnapshot,
  ingestAllSilos,
} from "../../evidence/src/ingest.ts";
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
const steadyResourceSample = {
  rssBytes: 100 * 1024 * 1024,
  heapUsedBytes: 40 * 1024 * 1024,
  externalBytes: 8 * 1024 * 1024,
  arrayBuffersBytes: 4 * 1024 * 1024,
  fileDescriptors: 12,
  temporaryArtifacts: 0,
  databaseRows: 0,
  walBytes: 0,
};

function validSoakEvidence(commit: string, corpusManifestSha256: string) {
  return {
    status: "passed",
    commit,
    corpusManifestSha256,
    durationMs: 6 * 60 * 60 * 1_000,
    operations: 100_000,
    sampleEveryOperations: 1_000,
    warmupOperations: 10_000,
    positiveLeakControlDetected: true,
    batches: 1_000,
    failures: [],
    resourceSamples: Array.from({ length: 101 }, (_, index) => ({
      operation: index * 1_000,
      elapsedMs: index * 216_000,
      sample: steadyResourceSample,
    })),
    resourceDrift: { status: "passed", failures: [] },
    positiveLeakControlSamples: [
      steadyResourceSample,
      {
        ...steadyResourceSample,
        rssBytes: steadyResourceSample.rssBytes + 32 * 1024 * 1024,
      },
    ],
    positiveLeakControlDrift: {
      status: "failed",
      failures: ["rss leak detected"],
    },
  };
}

function validLiveTrajectories(commit: string, corpusManifestSha256: string) {
  return Array.from({ length: 5 }, (_, repetition) =>
    ["file", "document", "memory", "email", "attachment", "tool-output"].map(
      (family) =>
        JSON.stringify({
          repetition,
          family,
          status: "passed",
          commit,
          corpusManifestSha256,
          providerQualified: true,
          provider: "openai",
          model: "gpt-5.4",
          continuationDiscovered: true,
          lateEvidenceRecovered: true,
          exactAnswer: true,
          answerLeakageDetected: false,
          canaryLeakageDetected: false,
          toolCalls: 2,
          noProgressReads: 0,
          latencyMs: 100,
          inputTokens: 1_000,
          outputTokens: 100,
          costUsd: 0.01,
          controllerDecision: "qualified",
          observerEvidenceSha256: "d".repeat(64),
          trajectorySha256: "e".repeat(64),
        }),
    ),
  )
    .flat()
    .join("\n");
}

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
      reports: objects.map((object) => ({
        objectId: object.id,
        status: "passed",
        reassembledSha256: object.sourceSha256,
        pages: Math.ceil(object.byteLength / (64 * 1024)),
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
      })),
    },
    "mutant-kills.json": {
      status: "passed",
      required: 9,
      executed: 9,
      killed: 9,
      killRate: 1,
      results: Array.from({ length: 9 }, () => ({
        status: "killed",
        failureVectors: ["source-work"],
      })),
    },
    "source-work.json": {
      samples: objects.map((object) => ({
        objectId: object.id,
        rowsRead: 1,
        parentScans: 0,
        bytesRead: 1024,
        bytesReturned: 1024,
      })),
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
      probes: objects.map((object) => ({ objectId: object.id, absent: true })),
    },
    "page-ledger.jsonl": objects
      .flatMap((object) =>
        Array.from(
          { length: Math.ceil(object.byteLength / (64 * 1024)) },
          (_, page) =>
            JSON.stringify({
              objectId: object.id,
              revision: object.revision,
              sliceSha256: "d".repeat(64),
              range: {
                start: page * 64 * 1024,
                end: Math.min(object.byteLength, (page + 1) * 64 * 1024),
              },
              bytesRead: Math.min(
                64 * 1024,
                object.byteLength - page * 64 * 1024,
              ),
              ...(page === Math.ceil(object.byteLength / (64 * 1024)) - 1
                ? { reassembledSha256: object.sourceSha256 }
                : {}),
            }),
        ),
      )
      .join("\n"),
    "prompt-tokens.json": {
      cases: [
        {
          finalSerialized: true,
          withinBudget: true,
          inputTokens: 100,
          outputReserveTokens: 100,
          contextWindowTokens: 1_000,
        },
      ],
    },
    "faults.json": {
      status: "passed",
      required: 6,
      executed: 6,
      catalog: [
        "unauthorized",
        "revoked-authorization",
        "stale-revision",
        "missing-source",
        "tampered-reference",
        "concurrent-cleanup",
      ],
      results: [
        "unauthorized",
        "revoked-authorization",
        "stale-revision",
        "missing-source",
        "tampered-reference",
        "concurrent-cleanup",
      ].map((id) => ({ id, status: "passed" })),
    },
    "stress.json": {
      status: "passed",
      reports: objects.map((object) => ({
        objectId: object.id,
        status: "passed",
        cases: [1, 8, 32, 64].map((concurrency) => ({
          concurrency,
          operations: 1,
          status: "passed",
          failures: [],
          sourceWork: {
            parentScans: 0,
            bytesRead: 1,
            readCalls: 1,
            rowsRead: 1,
          },
        })),
      })),
    },
    "soak.json": validSoakEvidence("a".repeat(40), manifestSha256),
    "postgres.json": {
      status: "passed",
      backend: "postgres",
      commit: "a".repeat(40),
      corpusManifestSha256: manifestSha256,
      version: "17.1",
      command: "postgres-real-integration",
      families: [
        "file",
        "document",
        "memory",
        "email",
        "attachment",
        "tool-output",
      ],
      sharedVectorsPassed: true,
    },
    "scenario.json": {
      status: "passed",
      deterministic: true,
      productionActions: true,
      strictFixtures: true,
      lateEvidenceFamilies: [
        "file",
        "document",
        "memory",
        "email",
        "attachment",
        "tool-output",
      ],
    },
    "scenario-native.jsonl": `${JSON.stringify({
      format: "eliza_native_v1",
      scenarioStatus: "passed",
      stepType: "planner",
      privacyAttestation: { passed: true },
      response: { text: "", toolCalls: [{ toolName: "FILE", input: {} }] },
    })}\n${JSON.stringify({
      format: "eliza_native_v1",
      scenarioStatus: "passed",
      stepType: "evaluator",
      privacyAttestation: { passed: true },
      response: {
        text: JSON.stringify({
          success: true,
          decision: "FINISH",
          messageToUser: "Done.",
        }),
      },
    })}\n`,
    "trajectories.jsonl": validLiveTrajectories("a".repeat(40), manifestSha256),
    "e2e.json": {
      status: "passed",
      commit: "a".repeat(40),
      corpusManifestSha256: manifestSha256,
      runId: "e2e-real-run",
      artifactPaths: [
        "browser/trace.zip",
        "network/har.json",
        "backend/log.txt",
        "database/rows.json",
      ],
      api: true,
      ui: true,
      inspector: true,
      backend: true,
      browser: true,
      network: true,
      database: true,
      artifacts: true,
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
      await writeFile(
        path.join(source, name),
        typeof value === "string" ? value : JSON.stringify(value),
        {
          mode: 0o600,
        },
      );
    }
    const runId = `producer-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runRoot = path.join(repoRoot, "reports", "content-context", runId);
    cleanup.push(runRoot);
    await mkdir(path.dirname(runRoot), { recursive: true });
    const baseline = captureSiloSnapshot(repoRoot);

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

    const bundleRoot = await mkdtemp(
      path.join(os.tmpdir(), "content-context-bundle-"),
    );
    cleanup.push(bundleRoot);
    const bundle = createBundle({
      rootDir: bundleRoot,
      provenance: {
        commit: "a".repeat(40),
        branch: "test/content-context-producer",
        runner: "local",
        tier: "cpu",
        envFingerprint: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          tier: "cpu",
        },
      },
    });
    const ingested = (await ingestAllSilos(bundle, repoRoot, baseline)).find(
      ({ silo }) => silo === "content-context",
    );
    expect(ingested).toMatchObject({
      status: "ingested",
      artifactCount: 19,
    });
    const { manifest } = await bundle.finalize();
    expect(
      manifest.artifacts.some(({ path: artifactPath }) =>
        artifactPath.endsWith(`/${runId}/completeness-manifest.json`),
      ),
    ).toBe(true);
  });
});

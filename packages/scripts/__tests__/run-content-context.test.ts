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
    "page-ledger.jsonl": objects
      .map((object) =>
        JSON.stringify({
          objectId: object.id,
          revision: object.revision,
          sliceSha256: "d".repeat(64),
          range: { start: 0, end: 1024 },
          bytesRead: 1024,
        }),
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
      required: 2,
      executed: 2,
      results: [{ status: "passed" }, { status: "passed" }],
    },
    "stress.json": {
      status: "passed",
      reports: objects.map((object) => ({
        objectId: object.id,
        cases: [1, 8, 32, 64].map((concurrency) => ({ concurrency })),
      })),
    },
    "soak.json": {
      status: "passed",
      durationMs: 6 * 60 * 60 * 1_000,
      operations: 100_000,
      positiveLeakControlDetected: true,
    },
    "postgres.json": {
      status: "passed",
      backend: "postgres",
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
    "trajectories.jsonl": Array.from({ length: 5 }, (_, repetition) =>
      JSON.stringify({
        repetition,
        status: "passed",
        providerQualified: true,
        provider: "fixture-provider",
        model: "fixture-model",
        answerLeakageDetected: false,
      }),
    ).join("\n"),
    "e2e.json": {
      status: "passed",
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

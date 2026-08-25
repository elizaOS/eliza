/**
 * Exercises the strict content-context producer against real files and atomic
 * publication while keeping bundle creation outside the producer boundary.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROGRESSIVE_CONTENT_FAULT_CASES,
  PROGRESSIVE_CONTENT_FAULT_SCHEMA_VERSION,
  PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS,
} from "../../core/src/testing/progressive-content-faults.ts";
import {
  PROGRESSIVE_CONTENT_MUTANT_REGISTRY_SCHEMA_VERSION,
  PROGRESSIVE_CONTENT_REQUIRED_MUTANTS,
} from "../../core/src/testing/progressive-content-mutants.ts";
import {
  PROGRESSIVE_CONTENT_ANCHOR_TIME,
  PROGRESSIVE_CONTENT_SCHEMA_VERSION,
  progressiveContentManifestDigest,
} from "../../corpus-tools/src/progressive-content.ts";
import {
  CONTENT_CONTEXT_E2E_SCHEMA_VERSION,
  CONTENT_CONTEXT_PERFORMANCE_POLICY,
} from "../../corpus-tools/src/progressive-content-evidence.ts";
import { PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION } from "../../corpus-tools/src/progressive-content-realization.ts";
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
const fixtureE2EArtifactBytes = {
  "e2e-artifacts/backend/server.log": Buffer.from("backend evidence\n"),
  "e2e-artifacts/browser/trace.zip": Buffer.from("browser trace bytes"),
  "e2e-artifacts/network/requests.har": Buffer.from("network evidence\n"),
  "e2e-artifacts/database/rows.json": Buffer.from('{"rows":1}\n'),
} as const;

function fixtureE2EArtifacts() {
  const kinds = [
    "backend-log",
    "browser-trace",
    "network-log",
    "database-state",
  ] as const;
  return Object.entries(fixtureE2EArtifactBytes).map(
    ([artifactPath, bytes], index) => ({
      kind: kinds[index],
      path: artifactPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    }),
  );
}
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
  const families = [
    "file",
    "document",
    "memory",
    "email",
    "attachment",
    "tool-output",
  ];
  return {
    schemaVersion: "elizaos.progressive-content.mixed-soak.v1",
    status: "passed",
    commit,
    corpusManifestSha256,
    clockSource: "system-monotonic",
    evidenceEligible: true,
    durationMs: 6 * 60 * 60 * 1_000,
    operations: 100_000,
    requiredDurationMs: 6 * 60 * 60 * 1_000,
    requiredOperations: 100_000,
    sampleEveryOperations: 1_000,
    warmupOperations: 10_000,
    positiveLeakControlDetected: true,
    positiveLeakControlKind: "retained-array-buffer",
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
    families: families.map((family, index) => {
      const operations = index < 4 ? 16_667 : 16_666;
      const realization = {
        file: ["filesystem", "native-bytes"],
        document: ["document-store", "typed-rejection"],
        memory: ["memory-store", "typed-rejection"],
        email: ["message-store", "typed-rejection"],
        attachment: ["content-addressed-media", "native-bytes"],
        "tool-output": ["filesystem", "native-bytes"],
      }[family];
      return {
        family,
        adapterId: `production-${family}`,
        objectId: `${family}-10485760`,
        authoritativeStore: realization?.[0],
        binaryPolicy: realization?.[1],
        productionMethod: `${family}-native-realization`,
        operations,
        cleanupVerified: true,
        failures: [],
        sourceWork: {
          bytesRead: operations * 64 * 1024,
          readCalls: operations,
          rowsRead: operations,
          parentScans: 0,
        },
      };
    }),
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

function validPostgresEvidence(
  objects: readonly {
    id: string;
    family: string;
    format: string;
    byteLength: number;
    sourceSha256: string;
    revision: string;
    authorizationScope: string;
  }[],
  corpusManifestSha256: string,
) {
  const mappings = [
    ["file", "filesystem", "READ.byteWindow", "native-bytes", false],
    [
      "document",
      "document-store",
      "DatabaseAdapter.readDocumentRange",
      "typed-rejection",
      true,
    ],
    [
      "memory",
      "memory-store",
      "DatabaseAdapter.readMessageContentRange",
      "typed-rejection",
      true,
    ],
    [
      "email",
      "message-store",
      "DatabaseAdapter.readMessageContentRange",
      "typed-rejection",
      true,
    ],
    [
      "attachment",
      "content-addressed-media",
      "media-store.readStoredMediaByteRange",
      "native-bytes",
      false,
    ],
    [
      "tool-output",
      "filesystem",
      "readShellOutputArtifactPage",
      "native-bytes",
      false,
    ],
  ] as const;
  const commit = "a".repeat(40);
  return {
    schemaVersion: "elizaos.content-context.postgres.v3",
    status: "passed",
    backend: "postgres",
    commit,
    corpusManifestSha256,
    server: { version: "PostgreSQL 17.1", versionNum: 170_001 },
    command: {
      executable: "bun",
      argv: [
        "packages/scripts/produce-content-context-postgres.mjs",
        `--commit=${commit}`,
      ],
      cwd: ".",
    },
    performance: {
      durationMs: 1_000,
      peakRssBytes: 128 * 1024 * 1024,
      peakHeapUsedBytes: 64 * 1024 * 1024,
      peakExternalBytes: 16 * 1024 * 1024,
      rssDeltaBytes: 1024,
      heapUsedStartBytes: 32 * 1024 * 1024,
      heapUsedEndBytes: 33 * 1024 * 1024,
      externalStartBytes: 1024,
      externalEndBytes: 2048,
      databaseSizeBytes: 64 * 1024 * 1024,
      totalPostgresRows: 96,
    },
    familyMappings: mappings.map(
      ([
        family,
        authoritativeStore,
        productionMethod,
        binaryPolicy,
        postgresBacked,
      ]) => ({
        family,
        authoritativeStore,
        productionMethod,
        binaryPolicy,
        postgresRows: postgresBacked ? 32 : 0,
      }),
    ),
    sharedVectors: mappings
      .filter((mapping) => mapping[4])
      .map(([family, , productionMethod]) => ({
        family,
        status: "passed",
        productionMethod,
        authorizationDenied: true,
        isolationDenied: true,
        restartVerified: true,
        indexNames: [
          family === "document"
            ? "idx_document_source_byte_seek"
            : "idx_message_content_byte_seek",
        ],
        seekPlan: {
          indexName:
            family === "document"
              ? "idx_document_source_byte_seek"
              : "idx_message_content_byte_seek",
          nodeTypes: ["Limit", "Bitmap Heap Scan", "Bitmap Index Scan"],
          actualRows: 1,
          sharedHitBlocks: 1,
          sharedReadBlocks: 0,
          planningTimeMs: 0.1,
          executionTimeMs: 0.1,
        },
      })),
    objects: objects.map((object) => {
      const postgresBacked =
        mappings.find(([family]) => family === object.family)?.[4] === true;
      const typedRejection =
        postgresBacked &&
        (object.format === "binary" || object.format === "invalid-utf8");
      const pageBytes = 64 * 1024;
      const postgresRows = typedRejection
        ? 0
        : postgresBacked
          ? Math.ceil(object.byteLength / pageBytes)
          : 0;
      return {
        objectId: object.id,
        family: object.family,
        sourceBytes: object.byteLength,
        sourceSha256: object.sourceSha256,
        revision: object.revision,
        authorizationScope: object.authorizationScope,
        disposition: typedRejection
          ? "typed-rejected"
          : postgresBacked
            ? "postgres-text-reassembled"
            : "native-store-reassembled",
        postgresRows,
        reassembledSha256: typedRejection ? null : object.sourceSha256,
        rejectionCode: typedRejection
          ? object.format === "binary"
            ? "CONTENT_BINARY_UNSUPPORTED"
            : "CONTENT_INVALID_UTF8"
          : null,
        storageWrites: postgresRows,
        authorizationVerified: true,
        isolationVerified: true,
        restartVerified: true,
        durationMs: 10,
        sourceWork: {
          pageBytes,
          bytesRead: typedRejection
            ? Math.min(pageBytes, object.byteLength)
            : object.byteLength,
          readCalls: typedRejection
            ? 1
            : Math.ceil(object.byteLength / pageBytes),
          rowsRead:
            postgresBacked && !typedRejection
              ? Math.ceil(object.byteLength / pageBytes)
              : 0,
          parentScans: 0,
          readAmplification: 1,
        },
      };
    }),
    negativeVectors: ["document", "memory", "email"].flatMap((family) =>
      ["binary", "invalid-utf8"].map((format) => ({
        family,
        format,
        status: "passed",
        rejectionCode:
          format === "binary"
            ? "CONTENT_BINARY_UNSUPPORTED"
            : "CONTENT_INVALID_UTF8",
        postgresRows: 0,
        storageWrites: 0,
      })),
    ),
    cleanup: { databaseDropped: true, postDropProbe: "absent" },
  };
}

afterEach(async () => {
  for (const target of cleanup.splice(0)) {
    await rm(target, { recursive: true, force: true });
  }
});

function evidenceValues() {
  const commit = "a".repeat(40);
  const objects = [
    "file",
    "document",
    "memory",
    "email",
    "attachment",
    "tool-output",
  ].flatMap((family) =>
    [1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024].map((byteLength) => ({
      id: `${family}-${byteLength}`,
      family,
      byteLength,
      sourceSha256: "c".repeat(64),
      revision: `revision-${family}-${byteLength}`,
      authorizationScope: `scope-${family}`,
      relativePath: `objects/${family}-${byteLength}.bin`,
      coordinateSystem: "utf8-byte-start-inclusive-end-exclusive",
      canaries: [],
      format:
        family === "memory" && byteLength === 10 * 1024 * 1024
          ? "binary"
          : family === "email" && byteLength === 1024 * 1024
            ? "invalid-utf8"
            : "lf-lines",
    })),
  );
  const expectedRejection = (object: (typeof objects)[number]) => {
    if (!["file", "document", "memory", "email"].includes(object.family)) {
      return undefined;
    }
    if (object.format === "binary") return "CONTENT_BINARY_UNSUPPORTED";
    if (object.format === "invalid-utf8") return "CONTENT_INVALID_UTF8";
    return undefined;
  };
  const verifiedObjects = objects.filter(
    (object) => expectedRejection(object) === undefined,
  );
  const typedRejectedObjects = objects.filter(
    (object) => expectedRejection(object) !== undefined,
  );
  const unsignedManifest = {
    schemaVersion: PROGRESSIVE_CONTENT_SCHEMA_VERSION,
    generatorRevision: commit,
    rootSeed: "producer-test-root-seed",
    anchorTime: PROGRESSIVE_CONTENT_ANCHOR_TIME,
    profile: "scale",
    publication: "private-atomic-manifest-last-v1",
    objects,
    formatFixtures: [],
    logicalBytes: objects.reduce(
      (total, object) => total + object.byteLength,
      0,
    ),
  };
  const manifestSha256 = progressiveContentManifestDigest(unsignedManifest);
  return {
    "corpus-manifest.json": {
      ...unsignedManifest,
      manifestSha256,
    },
    "native-realization-ledger.json": {
      schemaVersion: PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION,
      corpusSchemaVersion: PROGRESSIVE_CONTENT_SCHEMA_VERSION,
      corpusManifestSha256: manifestSha256,
      generatorRevision: commit,
      entries: objects.map((object) => {
        const rejectionCode = expectedRejection(object);
        const common = {
          objectId: object.id,
          family: object.family,
          adapterId: `production-${object.family}`,
          sourceSha256: object.sourceSha256,
          sourceBytes: object.byteLength,
        };
        return rejectionCode
          ? {
              ...common,
              status: "typed-rejected",
              sourceWork: {
                readCalls: 1,
                bytesRead: 64 * 1024,
                maxReadBytes: 64 * 1024,
              },
              rejectionCode,
            }
          : {
              ...common,
              status: "verified",
              reference: {
                kind:
                  object.family === "tool-output"
                    ? "tool-result"
                    : object.family,
                ref: `ref-${object.id}`,
              },
              revision: object.revision,
              authorizationScope: object.authorizationScope,
              cleanupIdentity: `cleanup-${object.id}`,
              resolverBindingSha256: "e".repeat(64),
              sourceWork: {
                readCalls: Math.ceil(object.byteLength / (64 * 1024)),
                bytesRead: object.byteLength,
                maxReadBytes: 64 * 1024,
              },
            };
      }),
      counts: {
        verified: verifiedObjects.length,
        typedRejected: typedRejectedObjects.length,
        unsupported: 0,
        pending: 0,
        failed: 0,
      },
    },
    "conformance.json": {
      reports: verifiedObjects.map((object) => ({
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
            ...CONTENT_CONTEXT_PERFORMANCE_POLICY.conformance,
          },
        },
      })),
    },
    "mutant-kills.json": {
      schemaVersion: PROGRESSIVE_CONTENT_MUTANT_REGISTRY_SCHEMA_VERSION,
      status: "passed",
      required: PROGRESSIVE_CONTENT_REQUIRED_MUTANTS.length,
      executed: PROGRESSIVE_CONTENT_REQUIRED_MUTANTS.length,
      killed: PROGRESSIVE_CONTENT_REQUIRED_MUTANTS.length,
      killRate: 1,
      results: PROGRESSIVE_CONTENT_REQUIRED_MUTANTS.map(
        ({ id, seam, killingVector, executor, killingTestId }) => ({
          id,
          seam,
          killingVector,
          executor,
          killingTestId,
          status: "killed",
          failureVectors: [killingVector],
        }),
      ),
    },
    "source-work.json": {
      samples: objects.map((object) => ({
        objectId: object.id,
        rowsRead: expectedRejection(object) ? 0 : 1,
        parentScans: 0,
        bytesRead: expectedRejection(object) ? 64 * 1024 : 1024,
        bytesReturned: expectedRejection(object) ? 0 : 1024,
      })),
    },
    "benchmark.json": {
      cases: [1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024].map(
        (sourceBytes) => ({
          sourceBytes,
          observed: {
            maxPageLatencyMs: 1,
            rssGrowthBytes: 1,
            databaseGrowthBytes: 1,
            readAmplification: 1,
          },
          ceilings: {
            maxPageLatencyMs:
              CONTENT_CONTEXT_PERFORMANCE_POLICY.benchmark.maxPageLatencyMs,
            rssGrowthBytes:
              CONTENT_CONTEXT_PERFORMANCE_POLICY.benchmark.maxRssGrowthBytes,
            databaseGrowthBytes: sourceBytes * 2,
            readAmplification:
              CONTENT_CONTEXT_PERFORMANCE_POLICY.benchmark.maxReadAmplification,
          },
        }),
      ),
    },
    "cleanup.json": {
      status: "passed",
      restartVerified: true,
      authorizationVerified: true,
      probes: objects.map((object) => ({ objectId: object.id, absent: true })),
    },
    "page-ledger.jsonl": verifiedObjects
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
      schemaVersion: PROGRESSIVE_CONTENT_FAULT_SCHEMA_VERSION,
      status: "passed",
      required: PROGRESSIVE_CONTENT_FAULT_CASES.length,
      executed: PROGRESSIVE_CONTENT_FAULT_CASES.length,
      catalog: PROGRESSIVE_CONTENT_FAULT_CASES.map(([id]) => id),
      results: PROGRESSIVE_CONTENT_FAULT_CASES.map(
        ([id, stage, expectedCode]) => ({
          id,
          stage,
          expectedCode,
          forbiddenEffects: PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS,
          status: "passed",
          observedCode: expectedCode,
          observedEffects: [],
        }),
      ),
    },
    "stress.json": {
      status: "passed",
      reports: verifiedObjects.map((object) => ({
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
    "soak.json": validSoakEvidence(commit, manifestSha256),
    "postgres.json": validPostgresEvidence(objects, manifestSha256),
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
    "trajectories.jsonl": validLiveTrajectories(commit, manifestSha256),
    "e2e.json": {
      schemaVersion: CONTENT_CONTEXT_E2E_SCHEMA_VERSION,
      status: "passed",
      commit,
      corpusManifestSha256: manifestSha256,
      runId: "e2e-real-run",
      checks: {
        api: true,
        ui: true,
        inspector: true,
        backend: true,
        browser: true,
        network: true,
        database: true,
      },
      artifacts: fixtureE2EArtifacts(),
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
    for (const [artifactPath, bytes] of Object.entries(
      fixtureE2EArtifactBytes,
    )) {
      const destination = path.join(source, ...artifactPath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: 0o600 });
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
    expect(completeness.requiredArtifacts).toContain(
      "e2e-artifacts/browser/trace.zip",
    );
    await expect(
      readFile(path.join(runRoot, "e2e-artifacts/browser/trace.zip")),
    ).resolves.toEqual(
      fixtureE2EArtifactBytes["e2e-artifacts/browser/trace.zip"],
    );

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
      artifactCount: 23,
    });
    const { manifest } = await bundle.finalize();
    expect(
      manifest.artifacts.some(({ path: artifactPath }) =>
        artifactPath.endsWith(`/${runId}/completeness-manifest.json`),
      ),
    ).toBe(true);

    await writeFile(
      path.join(source, "e2e-artifacts/backend/server.log"),
      "tampered backend evidence\n",
      { mode: 0o600 },
    );
    const rejectedRunRoot = path.join(
      repoRoot,
      "reports",
      "content-context",
      `producer-reject-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    cleanup.push(rejectedRunRoot);
    await expect(
      publishContentContextEvidence({
        source,
        runRoot: rejectedRunRoot,
        commit: "a".repeat(40),
      }),
    ).rejects.toThrow(/referenced artifact bytes differ/u);
  });
});

/** Proves evidence validation reads artifact bytes and rejects semantic or cryptographic false success. */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
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
} from "./progressive-content.ts";
import {
  buildContentContextResult,
  CONTENT_CONTEXT_E2E_SCHEMA_VERSION,
  CONTENT_CONTEXT_PERFORMANCE_POLICY,
  CONTENT_CONTEXT_REQUIRED_ARTIFACTS,
  CONTENT_CONTEXT_RESULT_SCHEMA_VERSION,
  type ContentContextRequiredArtifact,
  validateContentContextResult as validateContentContextResultBase,
} from "./progressive-content-evidence.ts";
import { PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION } from "./progressive-content-realization.ts";

const fixtureCommit = "a".repeat(40);
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

function validateContentContextResult(
  value: unknown,
  bytes: Parameters<typeof validateContentContextResultBase>[1],
  referencedBytes: Parameters<
    typeof validateContentContextResultBase
  >[2] = fixtureE2EArtifactBytes,
) {
  return validateContentContextResultBase(value, bytes, referencedBytes);
}
const fixtureObjects = [
  "file",
  "document",
  "memory",
  "email",
  "attachment",
  "tool-output",
].flatMap((family) =>
  [1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024].map((byteLength) => {
    const id = `${family}-${byteLength}`;
    return {
      id,
      family,
      byteLength,
      sourceSha256: "c".repeat(64),
      revision: `revision-${family}-${byteLength}`,
      authorizationScope: `scope-${family}`,
      format:
        family === "memory" && byteLength === 10 * 1024 * 1024
          ? "binary"
          : family === "email" && byteLength === 1024 * 1024
            ? "invalid-utf8"
            : "lf-lines",
      relativePath: `objects/${family}/${id}.txt`,
      coordinateSystem: "utf8-byte-start-inclusive-end-exclusive",
      canaries: [],
    };
  }),
);
const unsignedManifest = {
  schemaVersion: PROGRESSIVE_CONTENT_SCHEMA_VERSION,
  generatorRevision: fixtureCommit,
  rootSeed: "content-context:test",
  anchorTime: PROGRESSIVE_CONTENT_ANCHOR_TIME,
  profile: "scale",
  publication: "private-atomic-manifest-last-v1",
  objects: fixtureObjects,
  formatFixtures: [],
  logicalBytes: fixtureObjects.reduce(
    (total, object) => total + object.byteLength,
    0,
  ),
};
const manifestSha = progressiveContentManifestDigest(unsignedManifest);
const fixtureManifest = { ...unsignedManifest, manifestSha256: manifestSha };
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

function expectedFixtureRejection(object: (typeof fixtureObjects)[number]) {
  if (!["file", "document", "memory", "email"].includes(object.family)) {
    return undefined;
  }
  if (object.format === "binary") return "CONTENT_BINARY_UNSUPPORTED";
  if (object.format === "invalid-utf8") return "CONTENT_INVALID_UTF8";
  return undefined;
}

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

function evidence() {
  const objects = fixtureObjects.map((object) => ({ ...object }));
  const verifiedObjects = objects.filter(
    (object) => expectedFixtureRejection(object) === undefined,
  );
  const typedRejectedObjects = objects.filter(
    (object) => expectedFixtureRejection(object) !== undefined,
  );
  const values: Record<ContentContextRequiredArtifact, unknown> = {
    "corpus-manifest.json": {
      ...fixtureManifest,
      objects,
    },
    "native-realization-ledger.json": {
      schemaVersion: PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION,
      corpusSchemaVersion: PROGRESSIVE_CONTENT_SCHEMA_VERSION,
      corpusManifestSha256: manifestSha,
      generatorRevision: fixtureCommit,
      entries: objects.map((object) => {
        const rejectionCode = expectedFixtureRejection(object);
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
              revision: object.revision,
              authorizationScope: object.authorizationScope,
              cleanupIdentity: `cleanup-${object.id}`,
              resolverBindingSha256: "e".repeat(64),
              reference: {
                kind:
                  object.family === "tool-output"
                    ? "tool-result"
                    : object.family,
                ref: `ref-${object.id}`,
              },
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
          maxPageLatencyMs: 2,
          rssGrowthBytes: 1024,
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
        rowsRead: expectedFixtureRejection(object) ? 0 : 1,
        parentScans: 0,
        bytesRead: expectedFixtureRejection(object) ? 64 * 1024 : 1024,
        bytesReturned: expectedFixtureRejection(object) ? 0 : 1024,
      })),
    },
    "benchmark.json": {
      cases: [1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024].map(
        (sourceBytes) => ({
          sourceBytes,
          observed: {
            maxPageLatencyMs: 2,
            rssGrowthBytes: 1024,
            databaseGrowthBytes: 1024,
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
    "soak.json": validSoakEvidence("a".repeat(40), manifestSha),
    "postgres.json": validPostgresEvidence(objects, manifestSha),
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
    "trajectories.jsonl": validLiveTrajectories("a".repeat(40), manifestSha),
    "e2e.json": {
      schemaVersion: CONTENT_CONTEXT_E2E_SCHEMA_VERSION,
      status: "passed",
      commit: "a".repeat(40),
      corpusManifestSha256: manifestSha,
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
  const bytes = {} as Record<ContentContextRequiredArtifact, Uint8Array>;
  for (const name of CONTENT_CONTEXT_REQUIRED_ARTIFACTS) {
    bytes[name] = Buffer.from(
      typeof values[name] === "string"
        ? values[name]
        : JSON.stringify(values[name]),
    );
  }
  const result = {
    schemaVersion: CONTENT_CONTEXT_RESULT_SCHEMA_VERSION,
    commit: fixtureCommit,
    corpusManifestSha256: manifestSha,
    generatorRevision: fixtureCommit,
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
  const bytes = Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  );
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
        referencedArtifactBytes: fixtureE2EArtifactBytes,
      }),
    ).toEqual(result);
  });

  it("accepts cryptographically bound semantic proof", () => {
    const { result, bytes } = evidence();
    expect(validateContentContextResult(result, bytes)).toEqual(result);
  });

  it("rejects unknown result and artifact declaration fields", () => {
    const { result, bytes } = evidence();
    expect(() =>
      validateContentContextResult({ ...result, extra: true }, bytes),
    ).toThrow(/result fields are not exact/u);
    expect(() =>
      validateContentContextResult(
        {
          ...result,
          artifacts: result.artifacts.map((artifact, index) =>
            index === 0 ? { ...artifact, extra: true } : artifact,
          ),
        },
        bytes,
      ),
    ).toThrow(/artifact fields are not exact/u);
  });

  it("rejects extra runtime artifact bytes", () => {
    const { result, bytes } = evidence();
    expect(() =>
      validateContentContextResult(result, {
        ...bytes,
        "invented.json": Buffer.from("{}"),
      } as typeof bytes),
    ).toThrow(/artifact byte fields are not exact/u);
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

  it("rejects invented mutant identities even when every row claims a kill", () => {
    const original = evidence();
    const report = JSON.parse(
      new TextDecoder().decode(original.bytes["mutant-kills.json"]),
    ) as {
      results: Array<Record<string, unknown>>;
    };
    report.results[0] = {
      id: "invented-mutant",
      seam: "invented.seam",
      killingVector: "source-work",
      status: "killed",
      failureVectors: ["source-work"],
    };
    const changed = replaceArtifact(original, "mutant-kills.json", report);
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/mutant report does not prove executable kills/u);
  });

  it("rejects conformance that raises its own performance ceiling", () => {
    const original = evidence();
    const report = JSON.parse(
      new TextDecoder().decode(original.bytes["conformance.json"]),
    ) as {
      reports: Array<{
        performance: {
          maxPageLatencyMs: number;
          ceilings: { maxPageLatencyMs: number };
        };
      }>;
    };
    const first = report.reports[0];
    if (!first) throw new Error("conformance fixture is empty");
    first.performance.maxPageLatencyMs = 5_001;
    first.performance.ceilings.maxPageLatencyMs = 10_000;
    const changed = replaceArtifact(original, "conformance.json", report);
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/conformance performance exceeded a ceiling/u);
  });

  it("rejects benchmark and soak policy selected by the producer", () => {
    const original = evidence();
    const benchmark = JSON.parse(
      new TextDecoder().decode(original.bytes["benchmark.json"]),
    ) as {
      cases: Array<{
        observed: { maxPageLatencyMs: number };
        ceilings: { maxPageLatencyMs: number };
      }>;
    };
    const first = benchmark.cases[0];
    if (!first) throw new Error("benchmark fixture is empty");
    first.observed.maxPageLatencyMs = 5_001;
    first.ceilings.maxPageLatencyMs = 10_000;
    const raised = replaceArtifact(original, "benchmark.json", benchmark);
    expect(() =>
      validateContentContextResult(raised.result, raised.bytes),
    ).toThrow(/benchmark maxPageLatencyMs exceeded ceiling/u);

    const soak = JSON.parse(
      new TextDecoder().decode(original.bytes["soak.json"]),
    ) as { warmupOperations: number };
    soak.warmupOperations = 99_000;
    const hidden = replaceArtifact(original, "soak.json", soak);
    expect(() =>
      validateContentContextResult(hidden.result, hidden.bytes),
    ).toThrow(/soak warmup differs from validator policy/u);
  });

  it.each([
    ["failed scenario", { scenarioStatus: "failed" }],
    ["failed privacy attestation", { privacyAttestation: { passed: false } }],
    ["legacy synthetic event", { format: undefined, type: "tool_call" }],
  ])("rejects a %s in the native scenario export", (_label, override) => {
    const row = {
      format: "eliza_native_v1",
      scenarioStatus: "passed",
      stepType: "planner",
      privacyAttestation: { passed: true },
      response: { text: "", toolCalls: [{ toolName: "FILE", input: {} }] },
      ...override,
    };
    const changed = replaceArtifact(
      evidence(),
      "scenario-native.jsonl",
      `${JSON.stringify(row)}\n${JSON.stringify({
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
    );
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/scenario native export lacks tool and final events/u);
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

  it("rejects forged realization counts and stale generator identity", () => {
    const original = evidence();
    const ledger = JSON.parse(
      new TextDecoder().decode(
        original.bytes["native-realization-ledger.json"],
      ),
    ) as {
      generatorRevision: string;
      counts: { verified: number };
    };
    ledger.generatorRevision = "stale-revision";
    ledger.counts.verified += 1;
    const changed = replaceArtifact(
      original,
      "native-realization-ledger.json",
      ledger,
    );
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/realization ledger schema, revision, or counts are invalid/u);
  });

  it("rejects empty and duplicate exact-coverage collections", () => {
    const original = evidence();
    const emptySourceWork = replaceArtifact(original, "source-work.json", {
      samples: [],
    });
    expect(() =>
      validateContentContextResult(
        emptySourceWork.result,
        emptySourceWork.bytes,
      ),
    ).toThrow(/source-work does not cover every object exactly once/u);

    const conformance = JSON.parse(
      new TextDecoder().decode(original.bytes["conformance.json"]),
    ) as { reports: Array<Record<string, unknown>> };
    conformance.reports[1] = { ...conformance.reports[0] };
    const duplicate = replaceArtifact(
      original,
      "conformance.json",
      conformance,
    );
    expect(() =>
      validateContentContextResult(duplicate.result, duplicate.bytes),
    ).toThrow(
      /conformance does not cover every verified native object exactly once/u,
    );
  });

  it("rejects a typed rejection with the wrong code or a native reference", () => {
    const original = evidence();
    const ledger = JSON.parse(
      new TextDecoder().decode(
        original.bytes["native-realization-ledger.json"],
      ),
    ) as { entries: Array<Record<string, unknown>> };
    const typedEntry = ledger.entries.find(
      ({ status }) => status === "typed-rejected",
    );
    if (!typedEntry) throw new Error("typed fixture entry is absent");
    typedEntry.rejectionCode = "CONTENT_INVALID_UTF8";
    const wrongCode = replaceArtifact(
      original,
      "native-realization-ledger.json",
      ledger,
    );
    expect(() =>
      validateContentContextResult(wrongCode.result, wrongCode.bytes),
    ).toThrow(/native typed rejection is invalid or unbounded/u);

    typedEntry.rejectionCode = "CONTENT_BINARY_UNSUPPORTED";
    typedEntry.reference = { kind: "memory", ref: "forged" };
    const forgedReference = replaceArtifact(
      original,
      "native-realization-ledger.json",
      ledger,
    );
    expect(() =>
      validateContentContextResult(
        forgedReference.result,
        forgedReference.bytes,
      ),
    ).toThrow(/typed-rejected realization entry fields are not exact/u);
  });

  it("rejects a gapless-looking ledger that stops before source EOF", () => {
    const original = evidence();
    const rows = new TextDecoder()
      .decode(original.bytes["page-ledger.jsonl"])
      .trim()
      .split("\n");
    rows.splice(15, 1);
    const partial = replaceArtifact(
      original,
      "page-ledger.jsonl",
      rows.join("\n"),
    );
    expect(() =>
      validateContentContextResult(partial.result, partial.bytes),
    ).toThrow(/page ledger is not a full traversal/u);
  });

  it("rejects forged terminal hashes and range byte counts", () => {
    const original = evidence();
    const rows = new TextDecoder()
      .decode(original.bytes["page-ledger.jsonl"])
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const terminal = rows.find((row) => row.reassembledSha256 !== undefined);
    if (!terminal) throw new Error("page ledger fixture lacks a terminal row");
    terminal.reassembledSha256 = "f".repeat(64);
    const forged = replaceArtifact(
      original,
      "page-ledger.jsonl",
      rows.map((row) => JSON.stringify(row)).join("\n"),
    );
    expect(() =>
      validateContentContextResult(forged.result, forged.bytes),
    ).toThrow(/page ledger is not a full traversal/u);

    const mismatchedRows = new TextDecoder()
      .decode(original.bytes["page-ledger.jsonl"])
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const first = mismatchedRows[0];
    if (!first || typeof first.bytesRead !== "number")
      throw new Error("page ledger fixture is empty");
    first.bytesRead -= 1;
    const mismatched = replaceArtifact(
      original,
      "page-ledger.jsonl",
      mismatchedRows.map((row) => JSON.stringify(row)).join("\n"),
    );
    expect(() =>
      validateContentContextResult(mismatched.result, mismatched.bytes),
    ).toThrow(/page ledger lacks exact bounded native reads/u);
  });

  it("rejects fixture-shaped live evidence and stale run identities", () => {
    const original = evidence();
    const fixtureRows = Array.from({ length: 5 }, (_, repetition) =>
      JSON.stringify({
        repetition,
        status: "passed",
        commit: original.result.commit,
        corpusManifestSha256: manifestSha,
        providerQualified: true,
        provider: "fixture-provider",
        model: "mock-model",
        answerLeakageDetected: false,
      }),
    ).join("\n");
    const fixture = replaceArtifact(
      original,
      "trajectories.jsonl",
      fixtureRows,
    );
    expect(() =>
      validateContentContextResult(fixture.result, fixture.bytes),
    ).toThrow(/five qualified/u);

    const staleE2E = JSON.parse(
      new TextDecoder().decode(original.bytes["e2e.json"]),
    );
    const stale = replaceArtifact(original, "e2e.json", {
      ...staleE2E,
      commit: "f".repeat(40),
      runId: "stale-run",
    });
    expect(() =>
      validateContentContextResult(stale.result, stale.bytes),
    ).toThrow(/inspector E2E/u);
  });

  it.each([
    [
      "non-catalog fault",
      "faults.json" as const,
      {
        status: "passed",
        required: 1,
        executed: 1,
        catalog: ["other"],
        results: [{ id: "other", status: "passed" }],
      },
      /fault matrix/u,
    ],
    [
      "fixture-shaped stress case",
      "stress.json" as const,
      { status: "passed", reports: [] },
      /stress evidence/u,
    ],
    [
      "wrong Postgres family set",
      "postgres.json" as const,
      {
        status: "passed",
        backend: "postgres",
        commit: "a".repeat(40),
        corpusManifestSha256: manifestSha,
        version: "17.1",
        command: "postgres-real-integration",
        families: [
          "file",
          "document",
          "memory",
          "email",
          "attachment",
          "other",
        ],
        sharedVectorsPassed: true,
      },
      /Postgres evidence/u,
    ],
  ])("rejects %s", (_label, artifact, value, pattern) => {
    const changed = replaceArtifact(evidence(), artifact, value);
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(pattern);
  });

  it("rejects fault rows with forged codes or omitted forbidden effects", () => {
    const original = evidence();
    const report = JSON.parse(
      new TextDecoder().decode(original.bytes["faults.json"]),
    ) as {
      results: Array<Record<string, unknown>>;
    };
    report.results[0] = {
      ...report.results[0],
      expectedCode: "FORGED_SUCCESS",
      observedCode: "FORGED_SUCCESS",
      forbiddenEffects: [],
    };
    const changed = replaceArtifact(original, "faults.json", report);
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/fault matrix/u);
  });

  it("rejects Postgres evidence that copies native stores into SQL", () => {
    const original = evidence();
    const postgres = JSON.parse(
      new TextDecoder().decode(original.bytes["postgres.json"]),
    ) as {
      familyMappings: Array<Record<string, unknown>>;
    };
    const file = postgres.familyMappings.find(
      ({ family }) => family === "file",
    );
    if (!file) throw new Error("valid fixture lacks file mapping");
    file.postgresRows = 1;
    const changed = replaceArtifact(original, "postgres.json", postgres);
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/production storage ownership/u);
  });

  it("rejects Postgres evidence with amplified reads or missing typed rejections", () => {
    const original = evidence();
    const amplified = JSON.parse(
      new TextDecoder().decode(original.bytes["postgres.json"]),
    ) as {
      objects: Array<{ sourceWork: { bytesRead: number } }>;
    };
    const firstObject = amplified.objects[0];
    if (!firstObject) throw new Error("valid fixture lacks Postgres objects");
    firstObject.sourceWork.bytesRead = 100 * 1024 * 1024;
    const changedWork = replaceArtifact(original, "postgres.json", amplified);
    expect(() =>
      validateContentContextResult(changedWork.result, changedWork.bytes),
    ).toThrow(/source work is unbounded/u);

    const missingNegative = JSON.parse(
      new TextDecoder().decode(original.bytes["postgres.json"]),
    ) as { negativeVectors: unknown[] };
    missingNegative.negativeVectors.pop();
    const changedNegative = replaceArtifact(
      original,
      "postgres.json",
      missingNegative,
    );
    expect(() =>
      validateContentContextResult(
        changedNegative.result,
        changedNegative.bytes,
      ),
    ).toThrow(/negative vectors are incomplete/u);
  });

  it("rejects Postgres evidence with a fake index, rejection code, or producer command", () => {
    const original = evidence();
    const fakeIndex = JSON.parse(
      new TextDecoder().decode(original.bytes["postgres.json"]),
    ) as { sharedVectors: Array<{ indexNames: string[] }> };
    const firstVector = fakeIndex.sharedVectors[0];
    if (!firstVector) throw new Error("valid fixture lacks shared vectors");
    firstVector.indexNames = ["idx_fixture_only"];
    const changedIndex = replaceArtifact(original, "postgres.json", fakeIndex);
    expect(() =>
      validateContentContextResult(changedIndex.result, changedIndex.bytes),
    ).toThrow(/shared vector is incomplete/u);

    const fakePlan = JSON.parse(
      new TextDecoder().decode(original.bytes["postgres.json"]),
    ) as {
      sharedVectors: Array<{
        seekPlan: { indexName: string; nodeTypes: string[] };
      }>;
    };
    const firstPlan = fakePlan.sharedVectors[0]?.seekPlan;
    if (!firstPlan) throw new Error("valid fixture lacks a Postgres seek plan");
    firstPlan.indexName = "idx_fixture_only";
    firstPlan.nodeTypes = ["Seq Scan"];
    const changedPlan = replaceArtifact(original, "postgres.json", fakePlan);
    expect(() =>
      validateContentContextResult(changedPlan.result, changedPlan.bytes),
    ).toThrow(/indexed seek plan is invalid/u);

    const fakeRejection = JSON.parse(
      new TextDecoder().decode(original.bytes["postgres.json"]),
    ) as { negativeVectors: Array<{ rejectionCode: string }> };
    const firstNegative = fakeRejection.negativeVectors[0];
    if (!firstNegative) throw new Error("valid fixture lacks negative vectors");
    firstNegative.rejectionCode = "FIXTURE_REJECTED";
    const changedRejection = replaceArtifact(
      original,
      "postgres.json",
      fakeRejection,
    );
    expect(() =>
      validateContentContextResult(
        changedRejection.result,
        changedRejection.bytes,
      ),
    ).toThrow(/negative vector is not fail-closed/u);

    const fakeCommand = JSON.parse(
      new TextDecoder().decode(original.bytes["postgres.json"]),
    ) as { command: { argv: string[] } };
    fakeCommand.command.argv[0] = "packages/scripts/fixture.mjs";
    const changedCommand = replaceArtifact(
      original,
      "postgres.json",
      fakeCommand,
    );
    expect(() =>
      validateContentContextResult(changedCommand.result, changedCommand.bytes),
    ).toThrow(/command is not exact/u);
  });

  it("rejects a short soak even when its summary says passed", () => {
    const changed = replaceArtifact(evidence(), "soak.json", {
      ...validSoakEvidence("a".repeat(40), manifestSha),
      durationMs: 60_000,
    });
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/soak evidence/u);
  });

  it("recomputes soak and positive-control drift from the recorded samples", () => {
    const forgedControl = replaceArtifact(evidence(), "soak.json", {
      ...validSoakEvidence("a".repeat(40), manifestSha),
      positiveLeakControlSamples: [steadyResourceSample, steadyResourceSample],
    });
    expect(() =>
      validateContentContextResult(forgedControl.result, forgedControl.bytes),
    ).toThrow(/soak evidence/u);

    const leakingRun = validSoakEvidence("a".repeat(40), manifestSha);
    const forgedRun = replaceArtifact(evidence(), "soak.json", {
      ...leakingRun,
      resourceSamples: leakingRun.resourceSamples.map((point, index) => ({
        ...point,
        sample: {
          ...point.sample,
          rssBytes: point.sample.rssBytes + index * 1024 * 1024,
        },
      })),
    });
    expect(() =>
      validateContentContextResult(forgedRun.result, forgedRun.bytes),
    ).toThrow(/soak evidence/u);
  });

  it.each([
    ["empty", []],
    [
      "partial",
      validSoakEvidence("a".repeat(40), manifestSha).families.slice(0, 5),
    ],
    [
      "duplicate",
      [
        ...validSoakEvidence("a".repeat(40), manifestSha).families.slice(0, 5),
        validSoakEvidence("a".repeat(40), manifestSha).families[0],
      ],
    ],
  ])("rejects %s soak family coverage", (_label, families) => {
    const changed = replaceArtifact(evidence(), "soak.json", {
      ...validSoakEvidence("a".repeat(40), manifestSha),
      families,
    });
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/exact family operations/u);
  });

  it("rejects mismatched operations, fixture adapters, and unverified cleanup", () => {
    const valid = validSoakEvidence("a".repeat(40), manifestSha);
    for (const families of [
      valid.families.map((family, index) =>
        index === 0 ? { ...family, operations: 0 } : family,
      ),
      valid.families.map((family, index) =>
        index === 0 ? { ...family, adapterId: "file-fixture" } : family,
      ),
      valid.families.map((family, index) =>
        index === 0 ? { ...family, cleanupVerified: false } : family,
      ),
    ]) {
      const changed = replaceArtifact(evidence(), "soak.json", {
        ...valid,
        families,
      });
      expect(() =>
        validateContentContextResult(changed.result, changed.bytes),
      ).toThrow(/exact family operations/u);
    }
  });

  it("rejects credentialed trajectories with fewer than five repetitions", () => {
    const changed = replaceArtifact(
      evidence(),
      "trajectories.jsonl",
      Array.from({ length: 4 }, (_, repetition) =>
        JSON.stringify({
          repetition,
          status: "passed",
          providerQualified: true,
          answerLeakageDetected: false,
        }),
      ).join("\n"),
    );
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/five qualified/u);
  });

  it("rejects green UI claims without inspector and database evidence", () => {
    const original = evidence();
    const report = JSON.parse(
      new TextDecoder().decode(original.bytes["e2e.json"]),
    );
    const changed = replaceArtifact(original, "e2e.json", {
      ...report,
      checks: { ...report.checks, inspector: false, database: false },
    });
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/inspector E2E/u);
  });

  it("rejects duplicate JSON keys and mismatched referenced E2E bytes", () => {
    const original = evidence();
    const duplicate = replaceArtifact(
      original,
      "e2e.json",
      '{"status":"passed","status":"passed"}',
    );
    expect(() =>
      validateContentContextResult(duplicate.result, duplicate.bytes),
    ).toThrow(/strict UTF-8 JSON/u);
    expect(() =>
      validateContentContextResult(original.result, original.bytes, {
        ...fixtureE2EArtifactBytes,
        "e2e-artifacts/backend/server.log": Buffer.from("changed"),
      }),
    ).toThrow(/referenced artifact bytes differ/u);
    expect(
      validateContentContextResult(
        original.result,
        original.bytes,
        fixtureE2EArtifactBytes,
      ),
    ).toEqual(original.result);
  });
});

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
    "soak.json": validSoakEvidence("a".repeat(40), manifestSha),
    "postgres.json": {
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
    "trajectories.jsonl": validLiveTrajectories("a".repeat(40), manifestSha),
    "e2e.json": {
      status: "passed",
      commit: "a".repeat(40),
      corpusManifestSha256: manifestSha,
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
    ).toThrow(/conformance does not cover every native object exactly once/u);
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

    const stale = replaceArtifact(original, "e2e.json", {
      status: "passed",
      commit: "f".repeat(40),
      corpusManifestSha256: manifestSha,
      runId: "stale-run",
      artifactPaths: ["a", "b", "c", "d"],
      api: true,
      ui: true,
      inspector: true,
      backend: true,
      browser: true,
      network: true,
      database: true,
      artifacts: true,
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
    const changed = replaceArtifact(evidence(), "e2e.json", {
      status: "passed",
      api: true,
      ui: true,
      inspector: false,
      backend: true,
      browser: true,
      network: true,
      database: false,
      artifacts: true,
    });
    expect(() =>
      validateContentContextResult(changed.result, changed.bytes),
    ).toThrow(/inspector E2E/u);
  });
});

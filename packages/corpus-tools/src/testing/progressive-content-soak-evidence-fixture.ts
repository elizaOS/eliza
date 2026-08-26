/** Builds the exact lifecycle-bearing mixed-soak report used by evidence tests. */

import {
  PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS,
  PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_REJECTIONS,
  PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_SCHEMA_VERSION,
} from "../../../core/src/testing/progressive-content-mixed-soak.ts";

interface ResourceSample {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly arrayBuffersBytes: number;
  readonly fileDescriptors: number;
  readonly temporaryArtifacts: number;
  readonly databaseRows: number;
  readonly walBytes: number;
}

/** Create a deterministic report shaped like the six-hour production output. */
export function createProgressiveContentSoakEvidenceFixture(input: {
  readonly commit: string;
  readonly corpusManifestSha256: string;
  readonly steadyResourceSample: ResourceSample;
}) {
  const families = [
    "file",
    "document",
    "memory",
    "email",
    "attachment",
    "tool-output",
  ] as const;
  const operations = 100_000;
  const sampleEveryOperations = 1_000;
  const batches = operations / sampleEveryOperations;
  const lifecycleResults = Array.from({ length: batches }, (_, index) => {
    const cycle = index + 1;
    return PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS.map((id) => {
      if (id === "restart") {
        const sliceSha256 = (cycle % 16).toString(16).repeat(64);
        return {
          id,
          cycle,
          semantics: "target-transition",
          status: "passed",
          targetFamily: families[index % families.length],
          expectedCode: null,
          observedCode: null,
          beforeGeneration: `generation-${cycle}-before`,
          afterGeneration: `generation-${cycle}-after`,
          beforeSliceSha256: sliceSha256,
          afterSliceSha256: sliceSha256,
          observedEffects: [],
          reason: null,
        };
      }
      const [semantics, expectedCode] =
        PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_REJECTIONS[id];
      return {
        id,
        cycle,
        semantics,
        status: "passed",
        targetFamily: null,
        expectedCode,
        observedCode: expectedCode,
        beforeGeneration: null,
        afterGeneration: null,
        beforeSliceSha256: null,
        afterSliceSha256: null,
        observedEffects: [],
        reason: null,
      };
    });
  }).flat();
  return {
    schemaVersion: "elizaos.progressive-content.mixed-soak.v1",
    status: "passed",
    commit: input.commit,
    corpusManifestSha256: input.corpusManifestSha256,
    clockSource: "system-monotonic",
    evidenceEligible: true,
    durationMs: 6 * 60 * 60 * 1_000,
    operations,
    requiredDurationMs: 6 * 60 * 60 * 1_000,
    requiredOperations: operations,
    sampleEveryOperations,
    warmupOperations: 10_000,
    positiveLeakControlDetected: true,
    positiveLeakControlKind: "retained-array-buffer",
    batches,
    failures: [],
    lifecycle: {
      schemaVersion: PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_SCHEMA_VERSION,
      status: "passed",
      required: PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS,
      completedCycles: batches,
      results: lifecycleResults,
    },
    resourceSamples: Array.from({ length: batches + 1 }, (_, index) => ({
      operation: index * sampleEveryOperations,
      elapsedMs: index * 216_000,
      sample: input.steadyResourceSample,
    })),
    resourceDrift: { status: "passed", failures: [] },
    positiveLeakControlSamples: [
      input.steadyResourceSample,
      {
        ...input.steadyResourceSample,
        rssBytes: input.steadyResourceSample.rssBytes + 32 * 1024 * 1024,
      },
    ],
    positiveLeakControlDrift: {
      status: "failed",
      failures: ["rss leak detected"],
    },
    families: families.map((family, index) => {
      const familyOperations = index < 4 ? 16_667 : 16_666;
      const realization = {
        file: ["filesystem", "typed-rejection"],
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
        authoritativeStore: realization[0],
        binaryPolicy: realization[1],
        productionMethod: `${family}-native-realization`,
        operations: familyOperations,
        cleanupVerified: true,
        failures: [],
        sourceWork: {
          bytesRead: familyOperations * 64 * 1024,
          readCalls: familyOperations,
          rowsRead: familyOperations,
          parentScans: 0,
        },
      };
    }),
  };
}

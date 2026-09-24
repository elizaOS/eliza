/** Builds one receipt-backed PostgreSQL v4 report for validator and publisher tests. */

import {
  CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS,
  CONTENT_CONTEXT_POSTGRES_SCHEMA_VERSION,
} from "../progressive-content-postgres-evidence.ts";

interface FixtureObject {
  readonly id: string;
  readonly family: string;
  readonly format: string;
  readonly byteLength: number;
  readonly sourceSha256: string;
  readonly revision: string;
  readonly authorizationScope: string;
}

function snapshot(input: {
  readonly generation: string;
  readonly present: boolean;
  readonly ownedBytes: number;
  readonly databaseRows: number;
}) {
  return {
    resolverGeneration: input.generation,
    present: input.present,
    ownedBytes: input.ownedBytes,
    databaseRows: input.databaseRows,
    temporaryArtifacts: 0,
    walBytes: 0,
  };
}

function receipts(object: FixtureObject, postgresBacked: boolean) {
  const binding = object.sourceSha256;
  const ownedBytes = object.byteLength;
  const databaseRows = postgresBacked
    ? Math.max(1, Math.ceil(object.byteLength / (64 * 1024)))
    : 0;
  const present = (generation: string) =>
    snapshot({ generation, present: true, ownedBytes, databaseRows });
  const absent = snapshot({
    generation: "generation-2",
    present: false,
    ownedBytes: 0,
    databaseRows: 0,
  });
  const common = {
    schemaVersion: "elizaos.progressive-content.target-receipt.v1",
    targetBindingSha256: binding,
    status: "passed",
  } as const;
  return [
    {
      ...common,
      phase: "realized",
      restartScope: "resolver",
      before: present("generation-1"),
      after: present("generation-1"),
      probe: { access: "authorized", offset: 0, limit: 1 },
    },
    {
      ...common,
      phase: "authorization",
      before: present("generation-1"),
      after: present("generation-1"),
      probe: {
        access: "unauthorized",
        offset: 0,
        limit: 1,
        errorCode: "CONTENT_ACCESS_DENIED",
      },
    },
    {
      ...common,
      phase: "isolation",
      before: present("generation-1"),
      after: present("generation-1"),
      probe: {
        access: "isolated",
        offset: 0,
        limit: 1,
        errorCode: "CONTENT_ACCESS_DENIED",
      },
    },
    {
      ...common,
      phase: "restart",
      restartScope: "resolver",
      before: present("generation-1"),
      after: present("generation-2"),
      probe: { access: "authorized", offset: 0, limit: 1 },
    },
    {
      ...common,
      phase: "cleanup",
      before: present("generation-2"),
      after: absent,
      probe: { access: "authorized", offset: 0, limit: 1 },
    },
  ];
}

/** Create a structurally exact passing report without replacing the target under test. */
export function createProgressiveContentPostgresEvidenceFixture(input: {
  readonly objects: readonly FixtureObject[];
  readonly corpusManifestSha256: string;
  readonly commit: string;
}) {
  const entries = input.objects.map((object) => {
    const mapping = CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS.find(
      ({ family }) => family === object.family,
    );
    if (!mapping)
      throw new TypeError(`unknown fixture family ${object.family}`);
    const sourceWork = {
      readCalls: Math.max(1, Math.ceil(object.byteLength / (64 * 1024))),
      bytesRead: object.byteLength,
      maxReadBytes: Math.min(64 * 1024, object.byteLength),
    };
    const typedRejection =
      mapping.binaryPolicy === "typed-rejection" &&
      (object.format === "binary" || object.format === "invalid-utf8");
    if (typedRejection) {
      const rejectionCode =
        object.format === "binary"
          ? "CONTENT_BINARY_UNSUPPORTED"
          : "CONTENT_INVALID_UTF8";
      return {
        objectId: object.id,
        family: object.family,
        adapterId: mapping.adapterId,
        status: "typed-rejected",
        sourceSha256: object.sourceSha256,
        sourceRevision: object.revision,
        sourceBytes: object.byteLength,
        sourceWork: {
          readCalls: 1,
          bytesRead: Math.min(64 * 1024, object.byteLength),
          maxReadBytes: Math.min(64 * 1024, object.byteLength),
        },
        code: rejectionCode,
        rejectionCode,
      };
    }
    const targetReceipts = receipts(object, mapping.postgresBacked);
    return {
      objectId: object.id,
      family: object.family,
      adapterId: mapping.adapterId,
      status: "verified",
      sourceSha256: object.sourceSha256,
      sourceRevision: object.revision,
      nativeRevision: object.revision,
      sourceBytes: object.byteLength,
      sourceWork,
      realization: {
        reference: {
          kind: object.family === "tool-output" ? "tool-result" : object.family,
          ref: `fixture:${object.id}`,
        },
        cleanupIdentity: `fixture:${object.id}:cleanup`,
        resolverBindingSha256: object.sourceSha256,
      },
      conformance: {
        status: "passed",
        adapterId: mapping.adapterId,
        objectId: object.id,
        reassembledSha256: object.sourceSha256,
        cleanupVerified: true,
        postCleanupProbeVerified: true,
      },
      receipts: targetReceipts,
    };
  });
  const observedPostgresRows = entries.reduce((total, entry) => {
    const mapping = CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS.find(
      ({ family }) => family === entry.family,
    );
    const targetReceipts = entry.receipts;
    if (!mapping?.postgresBacked || !targetReceipts) {
      return total;
    }
    const realized = targetReceipts.find(({ phase }) => phase === "realized");
    return total + (realized?.after.databaseRows ?? 0);
  }, 0);
  return {
    schemaVersion: CONTENT_CONTEXT_POSTGRES_SCHEMA_VERSION,
    status: "passed",
    backend: "postgres",
    commit: input.commit,
    corpusManifestSha256: input.corpusManifestSha256,
    server: { version: "PostgreSQL 17.1", versionNum: 170_001 },
    command: {
      executable: "bun",
      argv: [
        "packages/scripts/produce-content-context-postgres.mjs",
        `--commit=${input.commit}`,
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
      observedPostgresRows,
    },
    targetHarness: {
      schemaVersion: "elizaos.progressive-content.target-harness.v1",
      corpusManifestSha256: input.corpusManifestSha256,
      generatorRevision: input.commit,
      status: "passed",
      factories: CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS.map(
        ({
          family,
          adapterId,
          authoritativeStore,
          productionMethod,
          binaryPolicy,
        }) => ({
          family,
          adapterId,
          authoritativeStore,
          productionMethod,
          binaryPolicy,
        }),
      ),
      entries,
    },
    indexVectors: CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS.filter(
      ({ postgresBacked }) => postgresBacked,
    ).map(({ family, adapterId, productionMethod }) => ({
      family,
      adapterId,
      productionMethod,
      plannerSettings: { enableSeqscan: false },
      seekPlan: {
        indexName:
          family === "document"
            ? "idx_document_source_byte_seek"
            : "idx_message_content_byte_seek",
        nodeTypes: ["Limit", "Index Scan"],
        actualRows: 1,
        sharedHitBlocks: 1,
        sharedReadBlocks: 0,
        planningTimeMs: 0.1,
        executionTimeMs: 0.1,
      },
    })),
    cleanup: { databaseDropped: true, postDropProbe: "absent" },
  };
}

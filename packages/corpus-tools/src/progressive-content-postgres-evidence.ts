/** Validates real-PostgreSQL evidence emitted by the shared production target harness. */

export const CONTENT_CONTEXT_POSTGRES_SCHEMA_VERSION =
  "elizaos.content-context.postgres.v4" as const;

export const CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS = [
  {
    family: "file",
    adapterId: "coding-tools-file-production-v3",
    authoritativeStore: "filesystem",
    productionMethod: "READ.byteWindow",
    binaryPolicy: "typed-rejection",
    postgresBacked: false,
  },
  {
    family: "document",
    adapterId: "plugin-sql-postgres-document-production-v1",
    authoritativeStore: "document-store",
    productionMethod: "DatabaseAdapter.readDocumentRange",
    binaryPolicy: "typed-rejection",
    postgresBacked: true,
  },
  {
    family: "memory",
    adapterId: "plugin-sql-postgres-memory-production-v1",
    authoritativeStore: "memory-store",
    productionMethod: "DatabaseAdapter.readMessageContentRange",
    binaryPolicy: "typed-rejection",
    postgresBacked: true,
  },
  {
    family: "email",
    adapterId: "plugin-sql-postgres-email-production-v1",
    authoritativeStore: "message-store",
    productionMethod: "DatabaseAdapter.readMessageContentRange",
    binaryPolicy: "typed-rejection",
    postgresBacked: true,
  },
  {
    family: "attachment",
    adapterId: "agent-content-addressed-media-production-v1",
    authoritativeStore: "content-addressed-media",
    productionMethod: "media-store.persistMediaStream/readStoredMediaByteRange",
    binaryPolicy: "native-bytes",
    postgresBacked: false,
  },
  {
    family: "tool-output",
    adapterId: "coding-tools-shell-output-artifact-production-v1",
    authoritativeStore: "filesystem",
    productionMethod:
      "shell-output-artifact.persistShellOutputByteArtifact/readShellOutputArtifactBytePage",
    binaryPolicy: "native-bytes",
    postgresBacked: false,
  },
] as const;

type EvidenceRecord = Record<string, unknown>;
type ExpectedObject = {
  readonly id: string;
  readonly family: string;
  readonly format: string;
  readonly byteLength: number;
  readonly sourceSha256: string;
  readonly revision: string;
  readonly authorizationScope: string;
};

function record(value: unknown, label: string): EvidenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as EvidenceRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function exactKeys(
  value: EvidenceRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function safeNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function validateSnapshot(value: unknown, label: string): EvidenceRecord {
  const snapshot = record(value, label);
  exactKeys(
    snapshot,
    [
      "resolverGeneration",
      "present",
      "ownedBytes",
      "databaseRows",
      "temporaryArtifacts",
      "walBytes",
    ],
    label,
  );
  if (
    typeof snapshot.resolverGeneration !== "string" ||
    snapshot.resolverGeneration.length === 0 ||
    typeof snapshot.present !== "boolean" ||
    !safeNonnegative(snapshot.ownedBytes) ||
    !safeNonnegative(snapshot.databaseRows) ||
    !safeNonnegative(snapshot.temporaryArtifacts) ||
    !safeNonnegative(snapshot.walBytes)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return snapshot;
}

function validateReceiptSet(
  value: unknown,
  label: string,
  postgresBacked: boolean,
): void {
  const receipts = array(value, `${label} receipts`).map((entry, index) =>
    record(entry, `${label} receipt ${index}`),
  );
  const phases = [
    "realized",
    "authorization",
    "isolation",
    "restart",
    "cleanup",
  ];
  if (
    receipts.length !== phases.length ||
    phases.some(
      (phase) =>
        receipts.filter((receipt) => receipt.phase === phase).length !== 1,
    )
  ) {
    throw new TypeError(
      `${label} lifecycle receipts are incomplete or duplicated`,
    );
  }
  let binding: string | undefined;
  for (const receipt of receipts) {
    const hasRestartScope =
      receipt.phase === "realized" || receipt.phase === "restart";
    exactKeys(
      receipt,
      [
        "schemaVersion",
        "targetBindingSha256",
        "phase",
        ...(hasRestartScope ? ["restartScope"] : []),
        "before",
        "after",
        "probe",
        "status",
      ],
      `${label} ${String(receipt.phase)} receipt`,
    );
    if (
      receipt.schemaVersion !==
        "elizaos.progressive-content.target-receipt.v1" ||
      !digest(receipt.targetBindingSha256) ||
      receipt.status !== "passed" ||
      (hasRestartScope &&
        !["resolver", "process"].includes(String(receipt.restartScope)))
    ) {
      throw new TypeError(`${label} receipt identity or status is invalid`);
    }
    binding ??= receipt.targetBindingSha256;
    if (receipt.targetBindingSha256 !== binding) {
      throw new TypeError(`${label} receipts do not bind one target`);
    }
    const before = validateSnapshot(
      receipt.before,
      `${label} ${String(receipt.phase)} before`,
    );
    const after = validateSnapshot(
      receipt.after,
      `${label} ${String(receipt.phase)} after`,
    );
    const probe = record(
      receipt.probe,
      `${label} ${String(receipt.phase)} probe`,
    );
    const optionalProbeKeys = Object.hasOwn(probe, "errorCode")
      ? ["access", "offset", "limit", "errorCode"]
      : Object.hasOwn(probe, "sliceSha256")
        ? ["access", "offset", "limit", "sliceSha256"]
        : ["access", "offset", "limit"];
    exactKeys(
      probe,
      optionalProbeKeys,
      `${label} ${String(receipt.phase)} probe`,
    );
    if (!safeNonnegative(probe.offset) || !safeNonnegative(probe.limit)) {
      throw new TypeError(`${label} receipt probe range is invalid`);
    }
    if (
      receipt.phase === "realized" &&
      (before.present !== true || after.present !== true)
    ) {
      throw new TypeError(
        `${label} was not observed present after realization`,
      );
    }
    if (
      receipt.phase === "authorization" &&
      (probe.access !== "unauthorized" || typeof probe.errorCode !== "string")
    ) {
      throw new TypeError(`${label} authorization denial was not observed`);
    }
    if (
      receipt.phase === "isolation" &&
      (probe.access !== "isolated" || typeof probe.errorCode !== "string")
    ) {
      throw new TypeError(`${label} isolation denial was not observed`);
    }
    if (
      receipt.phase === "restart" &&
      (before.present !== true ||
        after.present !== true ||
        before.resolverGeneration === after.resolverGeneration)
    ) {
      throw new TypeError(`${label} resolver restart was not observed`);
    }
    if (
      receipt.phase === "cleanup" &&
      (before.present !== true ||
        after.present !== false ||
        after.ownedBytes !== 0 ||
        after.databaseRows !== 0 ||
        after.temporaryArtifacts !== 0 ||
        after.walBytes !== 0)
    ) {
      throw new TypeError(`${label} cleanup transition was not observed`);
    }
    if (
      postgresBacked &&
      receipt.phase === "realized" &&
      (!safeNonnegative(after.databaseRows) || after.databaseRows < 1)
    ) {
      throw new TypeError(`${label} did not observe PostgreSQL rows`);
    }
  }
}

function validateTargetHarness(
  value: unknown,
  expected: {
    readonly corpusManifestSha256: string;
    readonly objects: readonly ExpectedObject[];
  },
): number {
  const harness = record(value, "PostgreSQL target harness");
  exactKeys(
    harness,
    [
      "schemaVersion",
      "corpusManifestSha256",
      "generatorRevision",
      "status",
      "factories",
      "entries",
    ],
    "PostgreSQL target harness",
  );
  if (
    harness.schemaVersion !== "elizaos.progressive-content.target-harness.v1" ||
    harness.corpusManifestSha256 !== expected.corpusManifestSha256 ||
    harness.status !== "passed" ||
    typeof harness.generatorRevision !== "string" ||
    harness.generatorRevision.length === 0
  ) {
    throw new TypeError(
      "PostgreSQL target harness identity or status is invalid",
    );
  }
  const factories = array(harness.factories, "PostgreSQL target factories").map(
    (entry, index) => record(entry, `PostgreSQL target factory ${index}`),
  );
  if (factories.length !== CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS.length) {
    throw new TypeError("PostgreSQL target factories are incomplete");
  }
  for (const mapping of CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS) {
    const factory = factories.find(({ family }) => family === mapping.family);
    if (!factory)
      throw new TypeError(`${mapping.family} target factory is absent`);
    exactKeys(
      factory,
      [
        "family",
        "adapterId",
        "authoritativeStore",
        "productionMethod",
        "binaryPolicy",
      ],
      `${mapping.family} target factory`,
    );
    if (
      factory.adapterId !== mapping.adapterId ||
      factory.authoritativeStore !== mapping.authoritativeStore ||
      factory.productionMethod !== mapping.productionMethod ||
      factory.binaryPolicy !== mapping.binaryPolicy
    ) {
      throw new TypeError(
        `${mapping.family} target factory differs from production`,
      );
    }
  }
  const expectedById = new Map(
    expected.objects.map((object) => [object.id, object] as const),
  );
  const entries = array(harness.entries, "PostgreSQL target entries").map(
    (entry, index) => record(entry, `PostgreSQL target entry ${index}`),
  );
  if (entries.length !== expected.objects.length) {
    throw new TypeError("PostgreSQL target object coverage is incomplete");
  }
  const seen = new Set<string>();
  let observedPostgresRows = 0;
  for (const entry of entries) {
    const object = expectedById.get(String(entry.objectId));
    const mapping = CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS.find(
      ({ family }) => family === object?.family,
    );
    if (
      !object ||
      !mapping ||
      seen.has(object.id) ||
      entry.family !== object.family ||
      entry.adapterId !== mapping.adapterId ||
      entry.sourceSha256 !== object.sourceSha256 ||
      entry.sourceRevision !== object.revision ||
      entry.sourceBytes !== object.byteLength
    ) {
      throw new TypeError(
        "PostgreSQL target entry differs from its corpus object",
      );
    }
    const sourceWork = record(entry.sourceWork, `${object.id} source work`);
    exactKeys(
      sourceWork,
      ["readCalls", "bytesRead", "maxReadBytes"],
      `${object.id} source work`,
    );
    if (
      !safeNonnegative(sourceWork.readCalls) ||
      !safeNonnegative(sourceWork.bytesRead) ||
      !safeNonnegative(sourceWork.maxReadBytes) ||
      sourceWork.maxReadBytes > 64 * 1024
    ) {
      throw new TypeError(`${object.id} source work is invalid or unbounded`);
    }
    const typedRejection =
      mapping.binaryPolicy === "typed-rejection" &&
      (object.format === "binary" || object.format === "invalid-utf8");
    if (typedRejection) {
      exactKeys(
        entry,
        [
          "objectId",
          "family",
          "adapterId",
          "status",
          "sourceSha256",
          "sourceRevision",
          "sourceBytes",
          "sourceWork",
          "code",
          "rejectionCode",
        ],
        `${object.id} typed rejection`,
      );
      const expectedCode =
        object.format === "binary"
          ? "CONTENT_BINARY_UNSUPPORTED"
          : "CONTENT_INVALID_UTF8";
      if (
        entry.status !== "typed-rejected" ||
        entry.code !== expectedCode ||
        entry.rejectionCode !== expectedCode ||
        sourceWork.bytesRead > 64 * 1024
      ) {
        throw new TypeError(`${object.id} typed rejection is invalid`);
      }
    } else {
      exactKeys(
        entry,
        [
          "objectId",
          "family",
          "adapterId",
          "status",
          "sourceSha256",
          "sourceRevision",
          "nativeRevision",
          "sourceBytes",
          "sourceWork",
          "realization",
          "conformance",
          "receipts",
        ],
        `${object.id} verified target`,
      );
      if (
        entry.status !== "verified" ||
        typeof entry.nativeRevision !== "string" ||
        sourceWork.bytesRead !== object.byteLength ||
        (object.byteLength > 0 && sourceWork.readCalls < 1)
      ) {
        throw new TypeError(`${object.id} verified target is incomplete`);
      }
      const conformance = record(entry.conformance, `${object.id} conformance`);
      if (
        conformance.status !== "passed" ||
        conformance.adapterId !== mapping.adapterId ||
        conformance.objectId !== object.id ||
        conformance.reassembledSha256 !== object.sourceSha256 ||
        conformance.cleanupVerified !== true ||
        conformance.postCleanupProbeVerified !== true
      ) {
        throw new TypeError(
          `${object.id} conformance did not pass the real target`,
        );
      }
      validateReceiptSet(entry.receipts, object.id, mapping.postgresBacked);
      if (mapping.postgresBacked) {
        const realized = array(entry.receipts, `${object.id} receipts`)
          .map((receipt) => record(receipt, `${object.id} receipt`))
          .find(({ phase }) => phase === "realized");
        const snapshot = validateSnapshot(
          realized?.after,
          `${object.id} realized after`,
        );
        observedPostgresRows += Number(snapshot.databaseRows);
      }
    }
    seen.add(object.id);
  }
  for (const mapping of CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS) {
    if (
      !entries.some(
        ({ family, status }) =>
          family === mapping.family && status === "verified",
      )
    ) {
      throw new TypeError(
        `${mapping.family} has no receipt-bearing verified target`,
      );
    }
  }
  return observedPostgresRows;
}

/** Reject reports that omit exact target receipts or real indexed seek observations. */
export function validateProgressiveContentPostgresEvidence(
  value: unknown,
  expected: {
    readonly commit: string;
    readonly corpusManifestSha256: string;
    readonly objects: readonly ExpectedObject[];
  },
): void {
  const report = record(value, "PostgreSQL report");
  exactKeys(
    report,
    [
      "schemaVersion",
      "status",
      "backend",
      "commit",
      "corpusManifestSha256",
      "server",
      "command",
      "performance",
      "targetHarness",
      "indexVectors",
      "cleanup",
    ],
    "PostgreSQL report",
  );
  if (
    report.schemaVersion !== CONTENT_CONTEXT_POSTGRES_SCHEMA_VERSION ||
    report.status !== "passed" ||
    report.backend !== "postgres" ||
    report.commit !== expected.commit ||
    report.corpusManifestSha256 !== expected.corpusManifestSha256
  ) {
    throw new TypeError("PostgreSQL report identity or status is invalid");
  }
  const server = record(report.server, "PostgreSQL server");
  exactKeys(server, ["version", "versionNum"], "PostgreSQL server");
  if (
    typeof server.version !== "string" ||
    !/^PostgreSQL\s/u.test(server.version) ||
    !safeNonnegative(server.versionNum) ||
    server.versionNum < 120_000
  ) {
    throw new TypeError("PostgreSQL server version is invalid");
  }
  const command = record(report.command, "PostgreSQL command");
  exactKeys(command, ["executable", "argv", "cwd"], "PostgreSQL command");
  const argv = array(command.argv, "PostgreSQL command argv");
  if (
    command.executable !== "bun" ||
    command.cwd !== "." ||
    argv[0] !== "packages/scripts/produce-content-context-postgres.mjs" ||
    argv.filter((entry) => entry === `--commit=${expected.commit}`).length !==
      1 ||
    argv.some(
      (entry) =>
        typeof entry !== "string" ||
        /postgres(?:ql)?:\/\//iu.test(entry) ||
        /(?:password|secret|token)=/iu.test(entry),
    )
  ) {
    throw new TypeError("PostgreSQL command is not exact or leaks credentials");
  }
  const observedPostgresRows = validateTargetHarness(
    report.targetHarness,
    expected,
  );
  const performance = record(report.performance, "PostgreSQL performance");
  exactKeys(
    performance,
    [
      "durationMs",
      "peakRssBytes",
      "peakHeapUsedBytes",
      "peakExternalBytes",
      "rssDeltaBytes",
      "heapUsedStartBytes",
      "heapUsedEndBytes",
      "externalStartBytes",
      "externalEndBytes",
      "databaseSizeBytes",
      "observedPostgresRows",
    ],
    "PostgreSQL performance",
  );
  if (
    !finiteNonnegative(performance.durationMs) ||
    performance.durationMs <= 0 ||
    !safeNonnegative(performance.peakRssBytes) ||
    performance.peakRssBytes < 1 ||
    !safeNonnegative(performance.peakHeapUsedBytes) ||
    performance.peakHeapUsedBytes < 1 ||
    !safeNonnegative(performance.peakExternalBytes) ||
    performance.peakExternalBytes < 1 ||
    typeof performance.rssDeltaBytes !== "number" ||
    !Number.isSafeInteger(performance.rssDeltaBytes) ||
    !safeNonnegative(performance.heapUsedStartBytes) ||
    !safeNonnegative(performance.heapUsedEndBytes) ||
    !safeNonnegative(performance.externalStartBytes) ||
    !safeNonnegative(performance.externalEndBytes) ||
    !safeNonnegative(performance.databaseSizeBytes) ||
    performance.databaseSizeBytes < 1 ||
    performance.observedPostgresRows !== observedPostgresRows ||
    observedPostgresRows < 1
  ) {
    throw new TypeError("PostgreSQL performance observations are invalid");
  }
  const vectors = array(report.indexVectors, "PostgreSQL index vectors").map(
    (entry, index) => record(entry, `PostgreSQL index vector ${index}`),
  );
  const postgresMappings = CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS.filter(
    ({ postgresBacked }) => postgresBacked,
  );
  if (
    vectors.length !== postgresMappings.length ||
    new Set(vectors.map(({ family }) => family)).size !== vectors.length
  ) {
    throw new TypeError(
      "PostgreSQL index vectors are incomplete or duplicated",
    );
  }
  for (const mapping of postgresMappings) {
    const vector = vectors.find(({ family }) => family === mapping.family);
    if (!vector)
      throw new TypeError(`${mapping.family} index vector is absent`);
    exactKeys(
      vector,
      [
        "family",
        "adapterId",
        "productionMethod",
        "plannerSettings",
        "seekPlan",
      ],
      `${mapping.family} index vector`,
    );
    if (
      vector.adapterId !== mapping.adapterId ||
      vector.productionMethod !== mapping.productionMethod
    ) {
      throw new TypeError(
        `${mapping.family} index vector differs from its target factory`,
      );
    }
    const plannerSettings = record(
      vector.plannerSettings,
      `${mapping.family} planner settings`,
    );
    exactKeys(
      plannerSettings,
      ["enableSeqscan"],
      `${mapping.family} planner settings`,
    );
    if (plannerSettings.enableSeqscan !== false) {
      throw new TypeError(`${mapping.family} planner settings are invalid`);
    }
    const plan = record(vector.seekPlan, `${mapping.family} seek plan`);
    exactKeys(
      plan,
      [
        "indexName",
        "nodeTypes",
        "actualRows",
        "sharedHitBlocks",
        "sharedReadBlocks",
        "planningTimeMs",
        "executionTimeMs",
      ],
      `${mapping.family} seek plan`,
    );
    const expectedIndex =
      mapping.family === "document"
        ? "idx_document_source_byte_seek"
        : "idx_message_content_byte_seek";
    const nodes = array(plan.nodeTypes, `${mapping.family} seek nodes`);
    if (
      plan.indexName !== expectedIndex ||
      !nodes.some((node) => typeof node === "string" && /Index/u.test(node)) ||
      !safeNonnegative(plan.actualRows) ||
      plan.actualRows < 1 ||
      !safeNonnegative(plan.sharedHitBlocks) ||
      !safeNonnegative(plan.sharedReadBlocks) ||
      !finiteNonnegative(plan.planningTimeMs) ||
      !finiteNonnegative(plan.executionTimeMs)
    ) {
      throw new TypeError(`${mapping.family} indexed seek plan is invalid`);
    }
  }
  const cleanup = record(report.cleanup, "PostgreSQL cleanup");
  exactKeys(
    cleanup,
    ["databaseDropped", "postDropProbe"],
    "PostgreSQL cleanup",
  );
  if (cleanup.databaseDropped !== true || cleanup.postDropProbe !== "absent") {
    throw new TypeError("PostgreSQL database cleanup is incomplete");
  }
}

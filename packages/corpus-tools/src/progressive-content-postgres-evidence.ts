/** Validates real-Postgres evidence against production storage ownership and bounded-read contracts. */

export const CONTENT_CONTEXT_POSTGRES_SCHEMA_VERSION =
  "elizaos.content-context.postgres.v2" as const;

export const CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS = [
  {
    family: "file",
    authoritativeStore: "filesystem",
    productionMethod: "READ.byteWindow",
    binaryPolicy: "native-bytes",
    postgresBacked: false,
    expectedIndexNames: [],
  },
  {
    family: "document",
    authoritativeStore: "document-store",
    productionMethod: "DatabaseAdapter.readDocumentRange",
    binaryPolicy: "typed-rejection",
    postgresBacked: true,
    expectedIndexNames: ["idx_document_source_byte_seek"],
  },
  {
    family: "memory",
    authoritativeStore: "memory-store",
    productionMethod: "DatabaseAdapter.readMessageContentRange",
    binaryPolicy: "typed-rejection",
    postgresBacked: true,
    expectedIndexNames: ["idx_message_content_byte_seek"],
  },
  {
    family: "email",
    authoritativeStore: "message-store",
    productionMethod: "DatabaseAdapter.readMessageContentRange",
    binaryPolicy: "typed-rejection",
    postgresBacked: true,
    expectedIndexNames: ["idx_message_content_byte_seek"],
  },
  {
    family: "attachment",
    authoritativeStore: "content-addressed-media",
    productionMethod: "media-store.readStoredMediaBytes",
    binaryPolicy: "native-bytes",
    postgresBacked: false,
    expectedIndexNames: [],
  },
  {
    family: "tool-output",
    authoritativeStore: "filesystem",
    productionMethod: "readShellOutputArtifactPage",
    binaryPolicy: "native-bytes",
    postgresBacked: false,
    expectedIndexNames: [],
  },
] as const;

type EvidenceRecord = Record<string, unknown>;
type ExpectedObject = {
  readonly id: string;
  readonly family: string;
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

function mappingFor(family: string) {
  return CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS.find(
    (mapping) => mapping.family === family,
  );
}

/** Reject fixture-shaped reports and evidence-only SQL tables before bundling. */
export function validateProgressiveContentPostgresEvidence(
  value: unknown,
  expected: {
    readonly commit: string;
    readonly corpusManifestSha256: string;
    readonly objects: readonly ExpectedObject[];
  },
): void {
  const report = record(value, "Postgres report");
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
      "familyMappings",
      "sharedVectors",
      "objects",
      "negativeVectors",
      "cleanup",
    ],
    "Postgres report",
  );
  if (
    report.schemaVersion !== CONTENT_CONTEXT_POSTGRES_SCHEMA_VERSION ||
    report.status !== "passed" ||
    report.backend !== "postgres" ||
    report.commit !== expected.commit ||
    report.corpusManifestSha256 !== expected.corpusManifestSha256
  ) {
    throw new TypeError("Postgres report identity or status is invalid");
  }

  const server = record(report.server, "Postgres server");
  exactKeys(server, ["version", "versionNum"], "Postgres server");
  if (
    typeof server.version !== "string" ||
    !/^PostgreSQL\s/u.test(server.version) ||
    !safeNonnegative(server.versionNum) ||
    server.versionNum < 120_000
  ) {
    throw new TypeError("Postgres server version is invalid");
  }

  const command = record(report.command, "Postgres command");
  exactKeys(command, ["executable", "argv", "cwd"], "Postgres command");
  const argv = array(command.argv, "Postgres command argv");
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
    throw new TypeError("Postgres command is not exact or leaks credentials");
  }

  const familyMappings = array(
    report.familyMappings,
    "Postgres family mappings",
  ).map((entry, index) => record(entry, `Postgres family mapping ${index}`));
  if (
    familyMappings.length !== CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS.length ||
    new Set(familyMappings.map(({ family }) => family)).size !==
      familyMappings.length
  ) {
    throw new TypeError(
      "Postgres family mappings are incomplete or duplicated",
    );
  }
  for (const expectedMapping of CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS) {
    const mapping = familyMappings.find(
      ({ family }) => family === expectedMapping.family,
    );
    if (!mapping)
      throw new TypeError(`${expectedMapping.family} mapping is absent`);
    exactKeys(
      mapping,
      [
        "family",
        "authoritativeStore",
        "productionMethod",
        "binaryPolicy",
        "postgresRows",
      ],
      `${expectedMapping.family} mapping`,
    );
    if (
      mapping.authoritativeStore !== expectedMapping.authoritativeStore ||
      mapping.productionMethod !== expectedMapping.productionMethod ||
      mapping.binaryPolicy !== expectedMapping.binaryPolicy ||
      !safeNonnegative(mapping.postgresRows) ||
      (expectedMapping.postgresBacked
        ? mapping.postgresRows < 1
        : mapping.postgresRows !== 0)
    ) {
      throw new TypeError(
        `${expectedMapping.family} mapping violates production storage ownership`,
      );
    }
  }

  const vectors = array(report.sharedVectors, "Postgres shared vectors").map(
    (entry, index) => record(entry, `Postgres shared vector ${index}`),
  );
  const postgresFamilies = CONTENT_CONTEXT_POSTGRES_FAMILY_MAPPINGS.filter(
    ({ postgresBacked }) => postgresBacked,
  );
  if (
    vectors.length !== postgresFamilies.length ||
    new Set(vectors.map(({ family }) => family)).size !== vectors.length
  ) {
    throw new TypeError("Postgres shared vectors are incomplete or duplicated");
  }
  for (const mapping of postgresFamilies) {
    const vector = vectors.find(({ family }) => family === mapping.family);
    if (!vector)
      throw new TypeError(`${mapping.family} shared vector is absent`);
    exactKeys(
      vector,
      [
        "family",
        "status",
        "productionMethod",
        "authorizationDenied",
        "isolationDenied",
        "restartVerified",
        "indexNames",
      ],
      `${mapping.family} shared vector`,
    );
    if (
      vector.status !== "passed" ||
      vector.productionMethod !== mapping.productionMethod ||
      vector.authorizationDenied !== true ||
      vector.isolationDenied !== true ||
      vector.restartVerified !== true ||
      JSON.stringify(
        array(vector.indexNames, `${mapping.family} index names`),
      ) !== JSON.stringify(mapping.expectedIndexNames)
    ) {
      throw new TypeError(`${mapping.family} shared vector is incomplete`);
    }
  }

  const expectedById = new Map(
    expected.objects.map((object) => [object.id, object] as const),
  );
  const objects = array(report.objects, "Postgres objects").map(
    (entry, index) => record(entry, `Postgres object ${index}`),
  );
  if (objects.length !== expected.objects.length) {
    throw new TypeError("Postgres object coverage is incomplete");
  }
  const seen = new Set<string>();
  for (const object of objects) {
    exactKeys(
      object,
      [
        "objectId",
        "family",
        "sourceBytes",
        "sourceSha256",
        "revision",
        "authorizationScope",
        "disposition",
        "postgresRows",
        "reassembledSha256",
        "authorizationVerified",
        "isolationVerified",
        "restartVerified",
        "sourceWork",
      ],
      "Postgres object",
    );
    const expectedObject = expectedById.get(String(object.objectId));
    const mapping = mappingFor(String(object.family));
    if (
      !expectedObject ||
      !mapping ||
      seen.has(expectedObject.id) ||
      object.family !== expectedObject.family ||
      object.sourceBytes !== expectedObject.byteLength ||
      object.sourceSha256 !== expectedObject.sourceSha256 ||
      object.revision !== expectedObject.revision ||
      object.authorizationScope !== expectedObject.authorizationScope ||
      object.reassembledSha256 !== expectedObject.sourceSha256 ||
      object.authorizationVerified !== true ||
      object.isolationVerified !== true ||
      object.restartVerified !== true ||
      !safeNonnegative(object.postgresRows) ||
      object.disposition !==
        (mapping.postgresBacked
          ? "postgres-text-reassembled"
          : "native-store-reassembled") ||
      (mapping.postgresBacked
        ? object.postgresRows < 1
        : object.postgresRows !== 0)
    ) {
      throw new TypeError("Postgres object differs from its corpus or mapping");
    }
    const work = record(object.sourceWork, "Postgres object source work");
    exactKeys(
      work,
      [
        "pageBytes",
        "bytesRead",
        "readCalls",
        "rowsRead",
        "parentScans",
        "readAmplification",
      ],
      "Postgres object source work",
    );
    if (
      !safeNonnegative(work.pageBytes) ||
      work.pageBytes < 1 ||
      work.pageBytes > 64 * 1024 ||
      !safeNonnegative(work.bytesRead) ||
      !safeNonnegative(work.readCalls) ||
      !safeNonnegative(work.rowsRead) ||
      work.parentScans !== 0 ||
      typeof work.readAmplification !== "number" ||
      !Number.isFinite(work.readAmplification) ||
      work.readAmplification < 1 ||
      work.readAmplification > 2 ||
      work.bytesRead > expectedObject.byteLength * 2 + work.pageBytes ||
      work.readCalls < Math.ceil(expectedObject.byteLength / work.pageBytes)
    ) {
      throw new TypeError(
        "Postgres object source work is unbounded or fabricated",
      );
    }
    seen.add(expectedObject.id);
  }

  const negativeVectors = array(
    report.negativeVectors,
    "Postgres negative vectors",
  ).map((entry, index) => record(entry, `Postgres negative vector ${index}`));
  const expectedNegativeKeys = postgresFamilies.flatMap(({ family }) =>
    ["binary", "invalid-utf8"].map((format) => `${family}:${format}`),
  );
  const actualNegativeKeys = negativeVectors.map(
    ({ family, format }) => `${String(family)}:${String(format)}`,
  );
  if (
    negativeVectors.length !== expectedNegativeKeys.length ||
    new Set(actualNegativeKeys).size !== actualNegativeKeys.length ||
    expectedNegativeKeys.some((key) => !actualNegativeKeys.includes(key))
  ) {
    throw new TypeError(
      "Postgres negative vectors are incomplete or duplicated",
    );
  }
  for (const vector of negativeVectors) {
    exactKeys(
      vector,
      [
        "family",
        "format",
        "status",
        "rejectionCode",
        "postgresRows",
        "storageWrites",
      ],
      "Postgres negative vector",
    );
    const expectedRejectionCode =
      vector.format === "binary"
        ? "CONTENT_BINARY_UNSUPPORTED"
        : "CONTENT_INVALID_UTF8";
    if (
      vector.status !== "passed" ||
      vector.rejectionCode !== expectedRejectionCode ||
      vector.postgresRows !== 0 ||
      vector.storageWrites !== 0
    ) {
      throw new TypeError("Postgres negative vector is not fail-closed");
    }
  }

  const cleanup = record(report.cleanup, "Postgres cleanup");
  exactKeys(cleanup, ["schemaDropped", "postDropProbe"], "Postgres cleanup");
  if (cleanup.schemaDropped !== true || cleanup.postDropProbe !== "absent") {
    throw new TypeError("Postgres cleanup is incomplete");
  }
}

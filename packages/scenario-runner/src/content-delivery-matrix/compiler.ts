/**
 * Compiles and validates the directional content-delivery matrix (#23105).
 * Rows arrive as untrusted data (they will be edited by future lanes); the
 * compiler enforces the closed field set, unique ids, known enum values, and
 * proof obligations, then freezes the compiled matrix. The completeness gate
 * fails closed: a connector pair's declared capability with no covering row
 * is an error, never a silent gap.
 */

import { CONTENT_DELIVERY_PROOF_KINDS } from "./proofs";
import {
  CONTENT_DELIVERY_MATRIX_SCHEMA,
  type ContentDeliveryMatrixRow,
  DELIVERY_CONNECTORS,
  DELIVERY_CONTENT_KINDS,
  DELIVERY_TRANSFORM_CLASSES,
  type DeclaredDeliveryCapability,
} from "./schema";

/** The compiled, immutable matrix. */
export interface CompiledContentDeliveryMatrix {
  readonly schema: typeof CONTENT_DELIVERY_MATRIX_SCHEMA;
  readonly rows: readonly ContentDeliveryMatrixRow[];
  /** Enumerate covering rows for a connector pair and content kind. */
  rowsFor(
    source: ContentDeliveryMatrixRow["sourceConnector"],
    target: ContentDeliveryMatrixRow["targetConnector"],
    contentKind: ContentDeliveryMatrixRow["contentKind"],
  ): readonly ContentDeliveryMatrixRow[];
}

function fail(path: string, message: string): never {
  throw new Error(`content-delivery matrix ${path}: ${message}`);
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === "string" && (allowed as readonly string[]).includes(value)
  );
}

function requireRow(
  value: unknown,
  index: number,
  seenIds: Set<string>,
): ContentDeliveryMatrixRow {
  const path = `rows[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const knownFields = new Set([
    "id",
    "schema",
    "sourceConnector",
    "targetConnector",
    "contentKind",
    "transformClass",
    "requiredProofs",
  ]);
  const unknownFields = Object.keys(record).filter(
    (key) => !knownFields.has(key),
  );
  if (unknownFields.length > 0) {
    fail(path, `unknown field(s): ${unknownFields.join(", ")}`);
  }
  for (const field of knownFields) {
    if (!(field in record)) {
      fail(path, `missing required field: ${field}`);
    }
  }
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    fail(path, "id must be a non-empty string");
  }
  if (seenIds.has(record.id)) {
    fail(path, `duplicate row id: ${record.id}`);
  }
  seenIds.add(record.id);
  if (record.schema !== CONTENT_DELIVERY_MATRIX_SCHEMA) {
    fail(
      path,
      `schema must be ${CONTENT_DELIVERY_MATRIX_SCHEMA}, got ${String(record.schema)}`,
    );
  }
  if (!isOneOf(record.sourceConnector, DELIVERY_CONNECTORS)) {
    fail(
      path,
      `sourceConnector must be one of ${DELIVERY_CONNECTORS.join(", ")}`,
    );
  }
  if (!isOneOf(record.targetConnector, DELIVERY_CONNECTORS)) {
    fail(
      path,
      `targetConnector must be one of ${DELIVERY_CONNECTORS.join(", ")}`,
    );
  }
  if (record.sourceConnector === record.targetConnector) {
    fail(path, "sourceConnector and targetConnector must differ");
  }
  if (!isOneOf(record.contentKind, DELIVERY_CONTENT_KINDS)) {
    fail(
      path,
      `contentKind must be one of ${DELIVERY_CONTENT_KINDS.join(", ")}`,
    );
  }
  if (!isOneOf(record.transformClass, DELIVERY_TRANSFORM_CLASSES)) {
    fail(
      path,
      `transformClass must be one of ${DELIVERY_TRANSFORM_CLASSES.join(", ")}`,
    );
  }
  if (
    !Array.isArray(record.requiredProofs) ||
    record.requiredProofs.length === 0 ||
    !record.requiredProofs.every((proof) =>
      isOneOf(proof, CONTENT_DELIVERY_PROOF_KINDS),
    )
  ) {
    fail(
      path,
      `requiredProofs must be a non-empty array of ${CONTENT_DELIVERY_PROOF_KINDS.join(", ")}`,
    );
  }
  // The transform class dictates which proofs are structurally required.
  if (record.transformClass === "verbatim-text") {
    const proofs = record.requiredProofs as unknown as readonly string[];
    if (!proofs.includes("provider-receipt")) {
      fail(path, "verbatim-text rows require the provider-receipt proof");
    }
  }
  if (record.transformClass === "byte-preserving-file") {
    const proofs = record.requiredProofs as unknown as readonly string[];
    for (const required of ["provider-receipt", "byte-hash"] as const) {
      if (!proofs.includes(required)) {
        fail(path, `byte-preserving-file rows require the ${required} proof`);
      }
    }
  }
  return Object.freeze({
    id: record.id,
    schema: record.schema,
    sourceConnector: record.sourceConnector,
    targetConnector: record.targetConnector,
    contentKind: record.contentKind,
    transformClass: record.transformClass,
    requiredProofs: Object.freeze([
      ...record.requiredProofs,
    ]) as readonly string[],
  }) as ContentDeliveryMatrixRow;
}

/**
 * Validate rows and freeze the compiled matrix. Throws on the first invalid
 * row; never returns a partially compiled matrix.
 */
export function compileContentDeliveryMatrix(
  rows: readonly unknown[],
): CompiledContentDeliveryMatrix {
  if (rows.length === 0) {
    fail("rows", "must not be empty — a matrix with no rows certifies nothing");
  }
  const seenIds = new Set<string>();
  const compiledRows = rows.map((row, index) =>
    requireRow(row, index, seenIds),
  );
  const frozenRows: readonly ContentDeliveryMatrixRow[] =
    Object.freeze(compiledRows);
  return Object.freeze({
    schema: CONTENT_DELIVERY_MATRIX_SCHEMA,
    rows: frozenRows,
    rowsFor(
      source: ContentDeliveryMatrixRow["sourceConnector"],
      target: ContentDeliveryMatrixRow["targetConnector"],
      contentKind: ContentDeliveryMatrixRow["contentKind"],
    ) {
      return frozenRows.filter(
        (row) =>
          row.sourceConnector === source &&
          row.targetConnector === target &&
          row.contentKind === contentKind,
      );
    },
  });
}

/**
 * Fail-closed completeness gate: every declared capability must be covered by
 * at least one matrix row. A declared-but-uncertified delivery path throws —
 * the inventory must be proven, not assumed.
 */
export function assertDeliveryCoverage(
  declared: readonly DeclaredDeliveryCapability[],
  matrix: CompiledContentDeliveryMatrix,
): void {
  const uncovered: string[] = [];
  for (const capability of declared) {
    const covering = matrix.rowsFor(
      capability.sourceConnector,
      capability.targetConnector,
      capability.contentKind,
    );
    if (covering.length === 0) {
      uncovered.push(
        `${capability.sourceConnector}->${capability.targetConnector}.${contentKindLabel(capability.contentKind)}`,
      );
    }
  }
  if (uncovered.length > 0) {
    throw new Error(
      `content-delivery matrix completeness gate failed: declared capabilities with no covering row: ${uncovered.join(", ")}`,
    );
  }
}

function contentKindLabel(
  kind: DeclaredDeliveryCapability["contentKind"],
): string {
  return kind;
}

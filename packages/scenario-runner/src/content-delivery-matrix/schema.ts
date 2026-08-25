/**
 * Versioned row types for the directional content-delivery matrix (#23105).
 * One row certifies that content of a given kind can travel from a source
 * connector to a target connector under a named transformation class, and
 * names the proof obligations (provider receipt, byte hash, readback) a
 * covering test must satisfy. Rows are data: the compiler validates and
 * freezes them, tests execute them against the wire-mock fleet.
 */
import type { ContentDeliveryProofKind } from "./proofs";

/** Bump when the row shape changes in a way old rows cannot satisfy. */
export const CONTENT_DELIVERY_MATRIX_SCHEMA = 1;

/** Connector identifiers, matching plugin/connector `source` names. */
export const DELIVERY_CONNECTORS = ["discord", "telegram"] as const;
export type DeliveryConnector = (typeof DELIVERY_CONNECTORS)[number];

/** Content kinds the first lane certifies. */
export const DELIVERY_CONTENT_KINDS = ["text", "file"] as const;
export type DeliveryContentKind = (typeof DELIVERY_CONTENT_KINDS)[number];

/**
 * How content is allowed to change on the way from source to target:
 * - `verbatim-text`: every UTF-16 unit of source text must arrive unchanged
 *   (transport chunking is allowed only if chunks concatenate losslessly).
 * - `byte-preserving-file`: the delivered file's byte stream must hash to the
 *   source file's SHA-256; renames are allowed, byte drift is not.
 */
export const DELIVERY_TRANSFORM_CLASSES = [
  "verbatim-text",
  "byte-preserving-file",
] as const;
export type DeliveryTransformClass =
  (typeof DELIVERY_TRANSFORM_CLASSES)[number];

/** The closed field set of one matrix row. */
export interface ContentDeliveryMatrixRow {
  /** Stable unique row id, e.g. `discord-to-telegram.text`. */
  readonly id: string;
  readonly schema: typeof CONTENT_DELIVERY_MATRIX_SCHEMA;
  readonly sourceConnector: DeliveryConnector;
  readonly targetConnector: DeliveryConnector;
  readonly contentKind: DeliveryContentKind;
  readonly transformClass: DeliveryTransformClass;
  /** Proof obligations the covering test must discharge. */
  readonly requiredProofs: readonly ContentDeliveryProofKind[];
}

/**
 * A capability a connector pair declares as supported. The completeness gate
 * (`assertDeliveryCoverage`) rejects any declared capability that no matrix
 * row covers — a declared-but-uncertified delivery path is a defect, not a
 * silent gap.
 */
export interface DeclaredDeliveryCapability {
  readonly sourceConnector: DeliveryConnector;
  readonly targetConnector: DeliveryConnector;
  readonly contentKind: DeliveryContentKind;
}

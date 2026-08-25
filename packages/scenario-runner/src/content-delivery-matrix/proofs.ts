/**
 * Proof primitives for content-delivery matrix rows (#23105): byte hashing,
 * typed provider receipts, and receipt verification. A row's covering test
 * uses these to prove byte-complete delivery rather than asserting on
 * prose; a delivery without a provider receipt is never recorded as proven.
 */
import { createHash } from "node:crypto";

/** What a covering test must prove for a row. */
export const CONTENT_DELIVERY_PROOF_KINDS = [
  "provider-receipt",
  "byte-hash",
  "readback",
] as const;
export type ContentDeliveryProofKind =
  (typeof CONTENT_DELIVERY_PROOF_KINDS)[number];

/** Where the receipt was observed: the wire the provider actually saw. */
export const RECEIPT_SOURCE_KINDS = [
  "provider-http-wire",
  "provider-api-readback",
] as const;
export type ReceiptSourceKind = (typeof RECEIPT_SOURCE_KINDS)[number];

/** A typed receipt for one delivered payload on the target provider wire. */
export interface DeliveryProviderReceipt {
  readonly kind: "provider-receipt";
  readonly sourceConnector: string;
  readonly targetConnector: string;
  /** The provider API method the delivery used, e.g. `sendMessage`. */
  readonly operation: string;
  readonly wireMethod: string;
  readonly wirePath: string;
  readonly sourceKind: ReceiptSourceKind;
  /** SHA-256 of the exact delivered payload bytes this receipt covers. */
  readonly payloadSha256: string;
  /** ISO timestamp of the observed wire request. */
  readonly observedAt: string;
  /** What the provider answered (echoed fields), used by readback checks. */
  readonly providerEcho: Readonly<Record<string, unknown>>;
}

/** SHA-256 of a payload, hex-lowercase — the single hashing primitive. */
export function deliveryPayloadSha256(payload: string | Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Verify a receipt against the payload it claims to cover. Fails when the
 * receipt is malformed, its hash does not match the delivered payload, or it
 * names a different connector pair — never fabricates a pass.
 */
export function verifyDeliveryReceipt(
  receipt: DeliveryProviderReceipt,
  deliveredPayload: string | Uint8Array,
  expected: { sourceConnector: string; targetConnector: string },
): void {
  if (receipt.kind !== "provider-receipt") {
    throw new Error(
      `delivery receipt verification: expected kind "provider-receipt", got ${String(receipt.kind)}`,
    );
  }
  if (
    receipt.sourceConnector !== expected.sourceConnector ||
    receipt.targetConnector !== expected.targetConnector
  ) {
    throw new Error(
      `delivery receipt verification: receipt names ${receipt.sourceConnector}->${receipt.targetConnector}, expected ${expected.sourceConnector}->${expected.targetConnector}`,
    );
  }
  const actualHash = deliveryPayloadSha256(deliveredPayload);
  if (receipt.payloadSha256 !== actualHash) {
    throw new Error(
      `delivery receipt verification: payload hash mismatch (receipt ${receipt.payloadSha256}, delivered ${actualHash})`,
    );
  }
}

/**
 * Compare well-formed Unicode text for verbatim delivery. Transport chunking
 * is allowed only when the concatenated chunks reconstruct the source exactly;
 * lone-surrogate drift introduced anywhere in the pipeline fails here.
 */
export function assertVerbatimTextDelivery(
  sourceText: string,
  deliveredChunks: readonly string[],
): void {
  const delivered = deliveredChunks.join("");
  if (delivered !== sourceText) {
    throw new Error(
      `verbatim text delivery failed: delivered ${delivered.length} UTF-16 units, source has ${sourceText.length}; first difference at unit ${firstDifferenceUnit(sourceText, delivered)}`,
    );
  }
}

function firstDifferenceUnit(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  }
  return shared;
}

/**
 * Prove byte-preserving file delivery: delivered bytes must SHA-256 to the
 * source bytes' digest. Filename/caption changes are allowed by the
 * `byte-preserving-file` transform class; byte drift is not.
 */
export function assertBytePreservingDelivery(
  sourceBytes: Uint8Array,
  deliveredBytes: Uint8Array,
): void {
  const sourceHash = deliveryPayloadSha256(sourceBytes);
  const deliveredHash = deliveryPayloadSha256(deliveredBytes);
  if (sourceHash !== deliveredHash) {
    throw new Error(
      `byte-preserving delivery failed: source sha256 ${sourceHash}, delivered sha256 ${deliveredHash}`,
    );
  }
}

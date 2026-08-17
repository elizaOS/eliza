/**
 * Primary-only authority for immutable native-storage HEAD receipts.
 *
 * Provider I/O deliberately stays outside this repository. A caller first
 * prepares a privacy-safe request identity, verifies one terminal provider
 * result, then commits the exact response. Positive debits and receipts are
 * written in one PostgreSQL transaction; zero-price receipts never touch the
 * credit ledger.
 */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../client";
import { type SqlExecutor, sqlRows } from "../execute-helpers";
import { writeTransaction } from "../helpers";

/**
 * Authority-version-1 retention policy. Changing either duration requires a
 * new parser version, and physical compaction must preserve an idempotency
 * tombstone (the paid ledger marker is one such tombstone).
 */
export const ORG_STORAGE_HEAD_RECEIPT_REPLAY_TTL_MS = 24 * 60 * 60 * 1_000;
export const ORG_STORAGE_HEAD_RECEIPT_PURGE_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

export const ORG_STORAGE_HEAD_RECEIPT_INVALID_INPUT = "ORG_STORAGE_HEAD_RECEIPT_INVALID_INPUT";
export const ORG_STORAGE_HEAD_RECEIPT_CONFLICT = "ORG_STORAGE_HEAD_RECEIPT_CONFLICT";
export const ORG_STORAGE_HEAD_RECEIPT_INSUFFICIENT_CREDITS =
  "ORG_STORAGE_HEAD_RECEIPT_INSUFFICIENT_CREDITS";
export const ORG_STORAGE_HEAD_RECEIPT_UNAVAILABLE = "ORG_STORAGE_HEAD_RECEIPT_UNAVAILABLE";
export const ORG_STORAGE_HEAD_RECEIPT_INVARIANT_VIOLATION =
  "ORG_STORAGE_HEAD_RECEIPT_INVARIANT_VIOLATION";

const AUTHORITY_VERSION = 1;
const STORAGE_NAMESPACE = "attachment-r2-v1";
const OPERATION = "head";
const HEADER_POLICY_VERSION = 1;
const LEDGER_DESCRIPTION = "API proxy: storage — head";
const LEDGER_METADATA_TYPE = "native_storage_head";
const LEDGER_METADATA_VERSION = 1;
const IDEMPOTENCY_HASH_DOMAIN = "org-storage-head-idempotency:v1";
const REQUEST_DIGEST_DOMAIN = "org-storage-head-request:v1";
const LEDGER_MARKER_DOMAIN = "org-storage-head-ledger:v1";
const RECEIPT_DIGEST_DOMAIN = "org-storage-head-receipt:v1";
const LEDGER_MARKER_PREFIX = "org-storage-head:v1:";
const MAX_IDEMPOTENCY_KEY_CHARACTERS = 128;
const MAX_CONDITIONAL_HEADER_BYTES = 8_192;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_USD_MICROS = 999_999_999_999n;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREFIXED_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LEDGER_MARKER_PATTERN = /^org-storage-head:v1:[0-9a-f]{64}$/;
const CANONICAL_CHARGE_USD_PATTERN = /^(?:0|[1-9][0-9]{0,5})\.[0-9]{6}$/;
const CANONICAL_BALANCE_USD_PATTERN = /^(?:0|[1-9][0-9]{0,9})\.[0-9]{6}$/;
const CANONICAL_NEGATIVE_CHARGE_USD_PATTERN = /^-(?:0|[1-9][0-9]{0,5})\.[0-9]{6}$/;
const ETAG_PATTERN = /^[!#-~]+$/;
const TEXT_ENCODER = new TextEncoder();
// Exact-object membership is non-enumerable and weakly held; it conveys no cross-request state.
const PREPARED_IDENTITIES = new WeakSet<object>();
declare const PREPARED_IDENTITY_BRAND: unique symbol;

export type OrgStorageHeadReceiptConflictReason = "idempotency_key_reused" | "receipt_expired";

/** The request cannot safely identify one native-storage HEAD. */
export class OrgStorageHeadReceiptInvalidInputError extends ElizaError {
  override readonly name = "OrgStorageHeadReceiptInvalidInputError";
  readonly statusCode = 400;

  constructor(field: string) {
    super("Native storage HEAD receipt input is invalid", {
      code: ORG_STORAGE_HEAD_RECEIPT_INVALID_INPUT,
      context: { field },
      severity: "ephemeral",
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A durable idempotency identity exists but cannot authorize this request. */
export class OrgStorageHeadReceiptConflictError extends ElizaError {
  override readonly name = "OrgStorageHeadReceiptConflictError";
  readonly statusCode = 409;

  constructor(readonly reason: OrgStorageHeadReceiptConflictReason) {
    super(
      reason === "receipt_expired"
        ? "The native storage HEAD receipt expired; use a new Idempotency-Key"
        : "The Idempotency-Key was already used for a different native storage HEAD",
      {
        code: ORG_STORAGE_HEAD_RECEIPT_CONFLICT,
        context: { reason },
        severity: "ephemeral",
      },
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A verified terminal response could not be committed because the balance is too low. */
export class OrgStorageHeadReceiptInsufficientCreditsError extends ElizaError {
  override readonly name = "OrgStorageHeadReceiptInsufficientCreditsError";
  readonly statusCode = 402;

  constructor() {
    super("Insufficient credits", {
      code: ORG_STORAGE_HEAD_RECEIPT_INSUFFICIENT_CREDITS,
      severity: "ephemeral",
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A database operation failed before durable state could be classified. */
export class OrgStorageHeadReceiptUnavailableError extends ElizaError {
  override readonly name = "OrgStorageHeadReceiptUnavailableError";
  readonly statusCode = 503;

  constructor(cause?: unknown) {
    super("Native storage HEAD receipt is unavailable", {
      code: ORG_STORAGE_HEAD_RECEIPT_UNAVAILABLE,
      ...(cause === undefined ? {} : { cause }),
      severity: "ephemeral",
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A durable row or impossible transaction shape violated the receipt contract. */
export class OrgStorageHeadReceiptInvariantError extends ElizaError {
  override readonly name = "OrgStorageHeadReceiptInvariantError";
  readonly statusCode = 503;

  constructor(cause?: unknown) {
    super("Native storage HEAD receipt integrity check failed", {
      code: ORG_STORAGE_HEAD_RECEIPT_INVARIANT_VIOLATION,
      ...(cause === undefined ? {} : { cause }),
      severity: "fatal",
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface OrgStorageHeadReceiptRequest {
  readonly objectKey: string;
  readonly ifMatch: string | null;
  readonly ifNoneMatch: string | null;
  readonly ifModifiedSince: string | null;
  readonly ifUnmodifiedSince: string | null;
}

export interface PrepareOrgStorageHeadReceiptInput {
  readonly organizationId: string;
  readonly rawIdempotencyKey: string | undefined;
  readonly request: OrgStorageHeadReceiptRequest;
}

/** Privacy-safe identity persisted with a terminal receipt. */
export interface OrgStorageHeadReceiptIdentity {
  readonly organizationId: string;
  readonly idempotencyKeyHash: string;
  readonly requestDigest: string;
  readonly ledgerIdempotencyMarker: string;
}

/** Opaque in-process ticket returned on a `prepare` miss. */
export type PreparedOrgStorageHeadReceiptIdentity = OrgStorageHeadReceiptIdentity & {
  readonly [PREPARED_IDENTITY_BRAND]: true;
};

export type OrgStorageHeadTerminalResponse =
  | {
      readonly kind: "ok";
      readonly objectId: string;
      readonly objectGeneration: bigint;
      readonly contentLength: bigint;
      readonly contentType: string;
      readonly etag: string;
      readonly lastModified: Date;
      readonly forceAttachment: boolean;
    }
  | {
      readonly kind: "not_modified";
      readonly objectId: string;
      readonly objectGeneration: bigint;
      readonly etag: string;
      readonly lastModified: Date;
    }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "precondition_failed";
      readonly objectId: string;
      readonly objectGeneration: bigint;
      readonly etag: string;
      readonly lastModified: Date;
    };

export interface OrgStorageHeadReceipt {
  readonly id: string;
  readonly identity: OrgStorageHeadReceiptIdentity;
  readonly chargeAmountUsd: string;
  readonly response: OrgStorageHeadTerminalResponse;
  readonly creditTransactionId: string | null;
  readonly receiptDigest: string;
  readonly createdAt: Date;
  readonly replayExpiresAt: Date;
  readonly purgeAfter: Date;
}

export type PrepareOrgStorageHeadReceiptResult =
  | { readonly outcome: "miss"; readonly identity: PreparedOrgStorageHeadReceiptIdentity }
  | { readonly outcome: "replay"; readonly receipt: OrgStorageHeadReceipt };

export interface CommitOrgStorageHeadReceiptInput {
  readonly identity: PreparedOrgStorageHeadReceiptIdentity;
  /** Canonical numeric(12,6) USD string; price is deliberately not part of the request digest. */
  readonly chargeAmountUsd: string;
  readonly response: OrgStorageHeadTerminalResponse;
}

export interface OrgStorageHeadBalanceMutation {
  readonly transactionId: string;
  /** Primary balance observed after the debit; recovery may observe a later mutation. */
  readonly observedBalanceUsd: string;
}

export type CommitOrgStorageHeadReceiptResult =
  | {
      readonly outcome: "committed";
      readonly receipt: OrgStorageHeadReceipt;
      readonly balanceMutation: OrgStorageHeadBalanceMutation | null;
    }
  | {
      readonly outcome: "replayed";
      readonly receipt: OrgStorageHeadReceipt;
      readonly balanceMutation: null;
    };

export type OrgStorageHeadReceiptTransactionRunner = <T>(
  callback: (transaction: DbTransaction) => Promise<T>,
) => Promise<T>;

interface ReceiptQueryRow {
  database_now: Date | string;
  organization_balance_usd: string | null;
  receipt_id: string | null;
  receipt_organization_id: string | null;
  authority_version: number | string | null;
  storage_namespace: string | null;
  operation: string | null;
  idempotency_key_hash: string | null;
  request_digest: string | null;
  charge_amount_usd: string | null;
  response_kind: string | null;
  response_status: number | string | null;
  header_policy_version: number | string | null;
  object_id: string | null;
  object_generation: bigint | number | string | null;
  response_content_length: bigint | number | string | null;
  response_content_type: string | null;
  response_etag: string | null;
  response_last_modified: Date | string | null;
  response_force_attachment: boolean | null;
  credit_transaction_id: string | null;
  receipt_digest: string | null;
  replay_expires_at: Date | string | null;
  purge_after: Date | string | null;
  receipt_created_at: Date | string | null;
  ledger_id: string | null;
  ledger_organization_id: string | null;
  ledger_user_id: string | null;
  ledger_amount: string | null;
  ledger_type: string | null;
  ledger_description: string | null;
  ledger_metadata: unknown;
  ledger_marker: string | null;
  ledger_created_at_matches_receipt: boolean | null;
  ledger_settled_at: Date | string | null;
  marker_id: string | null;
  marker_organization_id: string | null;
  marker_user_id: string | null;
  marker_amount: string | null;
  marker_type: string | null;
  marker_description: string | null;
  marker_metadata: unknown;
  marker_ledger_marker: string | null;
  marker_created_at: Date | string | null;
  marker_settled_at: Date | string | null;
}

interface ReceiptLookupMiss {
  readonly outcome: "miss";
  readonly databaseNow: Date;
  readonly organizationBalanceUsd: string;
}

interface ReceiptLookupReplay {
  readonly outcome: "replay";
  readonly databaseNow: Date;
  readonly organizationBalanceUsd: string;
  readonly receipt: OrgStorageHeadReceipt;
}

type ReceiptLookup = ReceiptLookupMiss | ReceiptLookupReplay;

interface InternalCommittedResult {
  readonly outcome: "committed";
  readonly receipt: OrgStorageHeadReceipt;
  readonly balanceMutation: OrgStorageHeadBalanceMutation | null;
}

interface InternalReplayedResult {
  readonly outcome: "replayed";
  readonly receipt: OrgStorageHeadReceipt;
}

type InternalTransactionResult =
  | InternalCommittedResult
  | InternalReplayedResult
  | {
      readonly outcome: "insufficient_credits";
    };

function invalidInput(field: string): never {
  throw new OrgStorageHeadReceiptInvalidInputError(field);
}

function unavailable(cause?: unknown): never {
  throw new OrgStorageHeadReceiptInvariantError(cause);
}

function requireUuid(value: string, field: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalidInput(field);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requireRawIdempotencyKey(value: string | undefined): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_IDEMPOTENCY_KEY_CHARACTERS ||
    value !== value.trim()
  ) {
    invalidInput("rawIdempotencyKey");
  }
  let nonSpace = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint > 0x7e) {
      invalidInput("rawIdempotencyKey");
    }
    if (character !== " ") nonSpace = true;
  }
  if (!nonSpace) invalidInput("rawIdempotencyKey");
}

function requireObjectKey(organizationId: string, value: string): void {
  if (typeof value !== "string") invalidInput("request.objectKey");
  const segments = value.split("/");
  if (
    value.length < 1 ||
    !value.startsWith(`org/${organizationId}/`) ||
    value.startsWith("/") ||
    !isWellFormedUnicode(value) ||
    value !== value.normalize("NFC") ||
    TEXT_ENCODER.encode(value).byteLength > 1_024 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    /\p{Cc}/u.test(value)
  ) {
    invalidInput("request.objectKey");
  }
}

function requireConditionalHeader(value: string | null, field: string): void {
  if (value === null) return;
  if (
    typeof value !== "string" ||
    !isWellFormedUnicode(value) ||
    TEXT_ENCODER.encode(value).byteLength > MAX_CONDITIONAL_HEADER_BYTES ||
    /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/u.test(value)
  ) {
    invalidInput(field);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function prefixedSha256(value: string): string {
  return `sha256:${sha256(value)}`;
}

function canonicalRequestIdentity(input: PrepareOrgStorageHeadReceiptInput): string {
  return JSON.stringify([
    REQUEST_DIGEST_DOMAIN,
    input.organizationId,
    OPERATION,
    input.request.objectKey,
    input.request.ifMatch,
    input.request.ifNoneMatch,
    input.request.ifModifiedSince,
    input.request.ifUnmodifiedSince,
  ]);
}

function prepareIdentity(
  input: PrepareOrgStorageHeadReceiptInput,
): PreparedOrgStorageHeadReceiptIdentity {
  requireUuid(input.organizationId, "organizationId");
  requireRawIdempotencyKey(input.rawIdempotencyKey);
  if (typeof input.request !== "object" || input.request === null) invalidInput("request");
  requireObjectKey(input.organizationId, input.request.objectKey);
  requireConditionalHeader(input.request.ifMatch, "request.ifMatch");
  requireConditionalHeader(input.request.ifNoneMatch, "request.ifNoneMatch");
  requireConditionalHeader(input.request.ifModifiedSince, "request.ifModifiedSince");
  requireConditionalHeader(input.request.ifUnmodifiedSince, "request.ifUnmodifiedSince");

  const idempotencyKeyHash = prefixedSha256(
    JSON.stringify([IDEMPOTENCY_HASH_DOMAIN, input.organizationId, input.rawIdempotencyKey]),
  );
  const ledgerDigest = sha256(
    JSON.stringify([LEDGER_MARKER_DOMAIN, input.organizationId, idempotencyKeyHash]),
  );
  const identity = Object.freeze({
    organizationId: input.organizationId,
    idempotencyKeyHash,
    requestDigest: prefixedSha256(canonicalRequestIdentity(input)),
    ledgerIdempotencyMarker: `${LEDGER_MARKER_PREFIX}${ledgerDigest}`,
  }) as PreparedOrgStorageHeadReceiptIdentity;
  PREPARED_IDENTITIES.add(identity);
  return identity;
}

function requireIdentity(identity: OrgStorageHeadReceiptIdentity): void {
  if (typeof identity !== "object" || identity === null) invalidInput("identity");
  requireUuid(identity.organizationId, "identity.organizationId");
  if (!PREFIXED_SHA256_PATTERN.test(identity.idempotencyKeyHash)) {
    invalidInput("identity.idempotencyKeyHash");
  }
  if (!PREFIXED_SHA256_PATTERN.test(identity.requestDigest)) {
    invalidInput("identity.requestDigest");
  }
  if (!LEDGER_MARKER_PATTERN.test(identity.ledgerIdempotencyMarker)) {
    invalidInput("identity.ledgerIdempotencyMarker");
  }
  const expectedMarker = `${LEDGER_MARKER_PREFIX}${sha256(
    JSON.stringify([LEDGER_MARKER_DOMAIN, identity.organizationId, identity.idempotencyKeyHash]),
  )}`;
  if (identity.ledgerIdempotencyMarker !== expectedMarker) {
    invalidInput("identity.ledgerIdempotencyMarker");
  }
}

function canonicalIdentity(
  identity: PreparedOrgStorageHeadReceiptIdentity,
): OrgStorageHeadReceiptIdentity {
  if (typeof identity !== "object" || identity === null || !PREPARED_IDENTITIES.has(identity)) {
    invalidInput("identity.preparedTicket");
  }
  requireIdentity(identity);
  return Object.freeze({
    organizationId: identity.organizationId,
    idempotencyKeyHash: identity.idempotencyKeyHash,
    requestDigest: identity.requestDigest,
    ledgerIdempotencyMarker: identity.ledgerIdempotencyMarker,
  });
}

function requireCanonicalUsd(value: string): bigint {
  if (typeof value !== "string" || !CANONICAL_CHARGE_USD_PATTERN.test(value)) {
    invalidInput("chargeAmountUsd");
  }
  const micros = BigInt(value.replace(".", ""));
  if (micros < 0n || micros > MAX_USD_MICROS) invalidInput("chargeAmountUsd");
  return micros;
}

function requireBigintRange(
  value: bigint,
  field: string,
  maximum: bigint = MAX_SIGNED_BIGINT,
): void {
  if (typeof value !== "bigint" || value < 0n || value > maximum) invalidInput(field);
}

function requireWholeSecondDate(value: Date, field: string): Date {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    value.getMilliseconds() !== 0
  ) {
    invalidInput(field);
  }
  return new Date(value.getTime());
}

function requireEtag(value: string): void {
  if (typeof value !== "string" || value.length > 512 || !ETAG_PATTERN.test(value)) {
    invalidInput("response.etag");
  }
}

function requireContentType(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    invalidInput("response.contentType");
  }
}

function canonicalResponse(
  response: OrgStorageHeadTerminalResponse,
): OrgStorageHeadTerminalResponse {
  if (typeof response !== "object" || response === null) invalidInput("response");
  if (response.kind === "not_found") return Object.freeze({ kind: "not_found" });
  if (
    response.kind !== "ok" &&
    response.kind !== "not_modified" &&
    response.kind !== "precondition_failed"
  ) {
    invalidInput("response.kind");
  }
  requireUuid(response.objectId, "response.objectId");
  requireBigintRange(response.objectGeneration, "response.objectGeneration");
  if (response.objectGeneration === 0n) invalidInput("response.objectGeneration");
  requireEtag(response.etag);
  const lastModified = requireWholeSecondDate(response.lastModified, "response.lastModified");

  if (response.kind === "ok") {
    requireBigintRange(response.contentLength, "response.contentLength", MAX_SAFE_INTEGER_BIGINT);
    requireContentType(response.contentType);
    if (typeof response.forceAttachment !== "boolean") {
      invalidInput("response.forceAttachment");
    }
    return Object.freeze({
      kind: "ok",
      objectId: response.objectId,
      objectGeneration: response.objectGeneration,
      contentLength: response.contentLength,
      contentType: response.contentType,
      etag: response.etag,
      lastModified,
      forceAttachment: response.forceAttachment,
    });
  }
  return Object.freeze({
    kind: response.kind,
    objectId: response.objectId,
    objectGeneration: response.objectGeneration,
    etag: response.etag,
    lastModified,
  });
}

function dateValue(value: Date | string | null, field: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Number.NaN);
  if (!Number.isFinite(parsed.getTime())) unavailable(new Error(`${field}_invalid`));
  return parsed;
}

function integerValue(value: number | string | null, expected: number, field: string): void {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed !== expected)
    unavailable(new Error(`${field}_invalid`));
}

function bigintValue(
  value: bigint | number | string | null,
  field: string,
  maximum: bigint,
): bigint {
  let parsed: bigint;
  try {
    parsed = typeof value === "bigint" ? value : BigInt(value ?? "invalid");
  } catch {
    unavailable(new Error(`${field}_invalid`));
  }
  if (parsed < 0n || parsed > maximum) unavailable(new Error(`${field}_invalid`));
  return parsed;
}

function canonicalStoredChargeUsd(value: string | null, field: string): string {
  if (typeof value !== "string" || !CANONICAL_CHARGE_USD_PATTERN.test(value)) {
    unavailable(new Error(`${field}_invalid`));
  }
  const micros = BigInt(value.replace(".", ""));
  if (micros < 0n || micros > MAX_USD_MICROS) unavailable(new Error(`${field}_invalid`));
  return value;
}

function canonicalStoredBalanceUsd(value: string | null, field: string): string {
  if (typeof value !== "string" || !CANONICAL_BALANCE_USD_PATTERN.test(value)) {
    unavailable(new Error(`${field}_invalid`));
  }
  return value;
}

function exactLedgerMetadata(value: unknown, receiptId: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  const keys = Object.keys(metadata).sort();
  return (
    keys.length === 3 &&
    keys[0] === "receipt_id" &&
    keys[1] === "type" &&
    keys[2] === "version" &&
    metadata.type === LEDGER_METADATA_TYPE &&
    metadata.receipt_id === receiptId &&
    metadata.version === LEDGER_METADATA_VERSION
  );
}

function detachedMarkerReceiptId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  const keys = Object.keys(metadata).sort();
  return keys.length === 3 &&
    keys[0] === "receipt_id" &&
    keys[1] === "type" &&
    keys[2] === "version" &&
    metadata.type === LEDGER_METADATA_TYPE &&
    typeof metadata.receipt_id === "string" &&
    UUID_PATTERN.test(metadata.receipt_id) &&
    metadata.version === LEDGER_METADATA_VERSION
    ? metadata.receipt_id
    : null;
}

function responseStatus(response: OrgStorageHeadTerminalResponse): 200 | 304 | 404 | 412 {
  switch (response.kind) {
    case "ok":
      return 200;
    case "not_modified":
      return 304;
    case "not_found":
      return 404;
    case "precondition_failed":
      return 412;
  }
}

function receiptDigest(input: Omit<OrgStorageHeadReceipt, "receiptDigest">): string {
  const response = input.response;
  const responseIdentity =
    response.kind === "ok"
      ? [
          response.kind,
          response.objectId,
          response.objectGeneration.toString(10),
          response.contentLength.toString(10),
          response.contentType,
          response.etag,
          response.lastModified.toISOString(),
          response.forceAttachment,
        ]
      : response.kind === "not_found"
        ? [response.kind]
        : [
            response.kind,
            response.objectId,
            response.objectGeneration.toString(10),
            response.etag,
            response.lastModified.toISOString(),
          ];
  return sha256(
    JSON.stringify([
      RECEIPT_DIGEST_DOMAIN,
      input.id,
      input.identity.organizationId,
      input.identity.idempotencyKeyHash,
      input.identity.requestDigest,
      input.identity.ledgerIdempotencyMarker,
      input.chargeAmountUsd,
      responseIdentity,
      input.creditTransactionId,
      input.createdAt.toISOString(),
      input.replayExpiresAt.toISOString(),
      input.purgeAfter.toISOString(),
    ]),
  );
}

function rowResponse(row: ReceiptQueryRow): OrgStorageHeadTerminalResponse {
  const objectId = row.object_id;
  const etag = row.response_etag;
  const lastModified = row.response_last_modified;
  const generation = row.object_generation;

  if (row.response_kind === "not_found") {
    integerValue(row.response_status, 404, "response_status");
    if (
      objectId !== null ||
      generation !== null ||
      row.response_content_length !== null ||
      row.response_content_type !== null ||
      etag !== null ||
      lastModified !== null ||
      row.response_force_attachment !== null
    ) {
      unavailable(new Error("response_shape_invalid"));
    }
    return Object.freeze({ kind: "not_found" });
  }

  if (
    (row.response_kind !== "ok" &&
      row.response_kind !== "not_modified" &&
      row.response_kind !== "precondition_failed") ||
    objectId === null ||
    generation === null ||
    etag === null ||
    lastModified === null ||
    !UUID_PATTERN.test(objectId) ||
    !ETAG_PATTERN.test(etag) ||
    etag.length > 512
  ) {
    unavailable(new Error("response_shape_invalid"));
  }
  const objectGeneration = bigintValue(generation, "object_generation", MAX_SIGNED_BIGINT);
  if (objectGeneration === 0n) unavailable(new Error("object_generation_invalid"));
  const parsedLastModified = dateValue(lastModified, "response_last_modified");
  if (parsedLastModified.getMilliseconds() !== 0) {
    unavailable(new Error("response_last_modified_invalid"));
  }

  if (row.response_kind === "ok") {
    integerValue(row.response_status, 200, "response_status");
    if (
      row.response_content_length === null ||
      row.response_content_type === null ||
      typeof row.response_force_attachment !== "boolean"
    ) {
      unavailable(new Error("response_shape_invalid"));
    }
    const contentLength = bigintValue(
      row.response_content_length,
      "response_content_length",
      MAX_SAFE_INTEGER_BIGINT,
    );
    const contentType = row.response_content_type;
    if (
      contentType.length < 1 ||
      contentType.length > 255 ||
      contentType.trim() !== contentType ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(contentType)
    ) {
      unavailable(new Error("response_content_type_invalid"));
    }
    return Object.freeze({
      kind: "ok",
      objectId,
      objectGeneration,
      contentLength,
      contentType,
      etag,
      lastModified: parsedLastModified,
      forceAttachment: row.response_force_attachment,
    });
  }

  integerValue(
    row.response_status,
    row.response_kind === "not_modified" ? 304 : 412,
    "response_status",
  );
  if (
    row.response_content_length !== null ||
    row.response_content_type !== null ||
    row.response_force_attachment !== null
  ) {
    unavailable(new Error("response_shape_invalid"));
  }
  return Object.freeze({
    kind: row.response_kind,
    objectId,
    objectGeneration,
    etag,
    lastModified: parsedLastModified,
  });
}

function parseReceipt(
  row: ReceiptQueryRow,
  expectedIdentity: OrgStorageHeadReceiptIdentity,
): OrgStorageHeadReceipt {
  const receiptId = row.receipt_id;
  if (
    receiptId === null ||
    !UUID_PATTERN.test(receiptId) ||
    row.receipt_organization_id !== expectedIdentity.organizationId ||
    row.idempotency_key_hash !== expectedIdentity.idempotencyKeyHash ||
    typeof row.request_digest !== "string" ||
    !PREFIXED_SHA256_PATTERN.test(row.request_digest)
  ) {
    unavailable(new Error("receipt_identity_invalid"));
  }
  integerValue(row.authority_version, AUTHORITY_VERSION, "authority_version");
  integerValue(row.header_policy_version, HEADER_POLICY_VERSION, "header_policy_version");
  if (row.storage_namespace !== STORAGE_NAMESPACE || row.operation !== OPERATION) {
    unavailable(new Error("receipt_identity_invalid"));
  }

  const chargeAmountUsd = canonicalStoredChargeUsd(row.charge_amount_usd, "charge_amount_usd");
  const chargeMicros = BigInt(chargeAmountUsd.replace(".", ""));
  const response = rowResponse(row);
  const createdAt = dateValue(row.receipt_created_at, "created_at");
  const replayExpiresAt = dateValue(row.replay_expires_at, "replay_expires_at");
  const purgeAfter = dateValue(row.purge_after, "purge_after");
  if (
    replayExpiresAt.getTime() - createdAt.getTime() !== ORG_STORAGE_HEAD_RECEIPT_REPLAY_TTL_MS ||
    purgeAfter.getTime() - replayExpiresAt.getTime() !== ORG_STORAGE_HEAD_RECEIPT_PURGE_GRACE_MS
  ) {
    unavailable(new Error("receipt_retention_invalid"));
  }

  let creditTransactionId: string | null = null;
  if (chargeMicros === 0n) {
    if (
      row.credit_transaction_id !== null ||
      row.ledger_id !== null ||
      row.marker_id !== null ||
      row.marker_organization_id !== null
    ) {
      unavailable(new Error("zero_charge_ledger_invalid"));
    }
  } else {
    creditTransactionId = row.credit_transaction_id;
    if (
      creditTransactionId === null ||
      !UUID_PATTERN.test(creditTransactionId) ||
      row.ledger_id !== creditTransactionId ||
      row.marker_id !== creditTransactionId ||
      row.ledger_organization_id !== expectedIdentity.organizationId ||
      row.marker_organization_id !== expectedIdentity.organizationId ||
      row.ledger_user_id !== null ||
      row.ledger_type !== "debit" ||
      row.ledger_amount !== `-${chargeAmountUsd}` ||
      row.ledger_description !== LEDGER_DESCRIPTION ||
      row.ledger_marker !== expectedIdentity.ledgerIdempotencyMarker ||
      row.ledger_settled_at !== null ||
      row.ledger_created_at_matches_receipt !== true ||
      !exactLedgerMetadata(row.ledger_metadata, receiptId)
    ) {
      unavailable(new Error("positive_charge_ledger_invalid"));
    }
  }

  const identity = Object.freeze({
    organizationId: expectedIdentity.organizationId,
    idempotencyKeyHash: expectedIdentity.idempotencyKeyHash,
    requestDigest: row.request_digest,
    ledgerIdempotencyMarker: expectedIdentity.ledgerIdempotencyMarker,
  });
  const receiptWithoutDigest = Object.freeze({
    id: receiptId,
    identity,
    chargeAmountUsd,
    response,
    creditTransactionId,
    createdAt,
    replayExpiresAt,
    purgeAfter,
  });
  if (
    typeof row.receipt_digest !== "string" ||
    !SHA256_PATTERN.test(row.receipt_digest) ||
    row.receipt_digest !== receiptDigest(receiptWithoutDigest)
  ) {
    unavailable(new Error("receipt_digest_invalid"));
  }
  return Object.freeze({ ...receiptWithoutDigest, receiptDigest: row.receipt_digest });
}

async function queryReceipt(
  executor: SqlExecutor,
  identity: OrgStorageHeadReceiptIdentity,
): Promise<ReceiptQueryRow> {
  const rows = await sqlRows<ReceiptQueryRow>(
    executor,
    sql`
      SELECT
        date_trunc('milliseconds', clock_timestamp()) AS database_now,
        organization.credit_balance::text AS organization_balance_usd,
        receipt.id AS receipt_id,
        receipt.organization_id AS receipt_organization_id,
        receipt.authority_version,
        receipt.storage_namespace,
        receipt.operation,
        receipt.idempotency_key_hash,
        receipt.request_digest,
        receipt.charge_amount_usd::text AS charge_amount_usd,
        receipt.response_kind,
        receipt.response_status,
        receipt.header_policy_version,
        receipt.object_id,
        receipt.object_generation::text AS object_generation,
        receipt.response_content_length::text AS response_content_length,
        receipt.response_content_type,
        receipt.response_etag,
        receipt.response_last_modified,
        receipt.response_force_attachment,
        receipt.credit_transaction_id,
        receipt.receipt_digest,
        receipt.replay_expires_at,
        receipt.purge_after,
        receipt.created_at AS receipt_created_at,
        ledger.id AS ledger_id,
        ledger.organization_id AS ledger_organization_id,
        ledger.user_id AS ledger_user_id,
        ledger.amount::text AS ledger_amount,
        ledger.type AS ledger_type,
        ledger.description AS ledger_description,
        ledger.metadata AS ledger_metadata,
        ledger.stripe_payment_intent_id AS ledger_marker,
        ledger.created_at = receipt.created_at AT TIME ZONE 'UTC'
          AS ledger_created_at_matches_receipt,
        ledger.settled_at AS ledger_settled_at,
        marker.id AS marker_id,
        marker.organization_id AS marker_organization_id,
        marker.user_id AS marker_user_id,
        marker.amount::text AS marker_amount,
        marker.type AS marker_type,
        marker.description AS marker_description,
        marker.metadata AS marker_metadata,
        marker.stripe_payment_intent_id AS marker_ledger_marker,
        marker.created_at AT TIME ZONE 'UTC' AS marker_created_at,
        marker.settled_at AS marker_settled_at
      FROM (SELECT 1) AS singleton
      LEFT JOIN organizations AS organization
        ON organization.id = ${identity.organizationId}
      LEFT JOIN org_storage_head_receipts AS receipt
        ON receipt.organization_id = ${identity.organizationId}
        AND receipt.idempotency_key_hash = ${identity.idempotencyKeyHash}
      LEFT JOIN credit_transactions AS ledger
        ON ledger.id = receipt.credit_transaction_id
      LEFT JOIN credit_transactions AS marker
        ON marker.stripe_payment_intent_id = ${identity.ledgerIdempotencyMarker}
    `,
  );
  if (rows.length !== 1 || !rows[0]) unavailable(new Error("receipt_query_shape"));
  return rows[0];
}

async function lookupReceipt(
  executor: SqlExecutor,
  identity: OrgStorageHeadReceiptIdentity,
): Promise<ReceiptLookup> {
  const row = await queryReceipt(executor, identity);
  const databaseNow = dateValue(row.database_now, "database_now");
  const organizationBalanceUsd = canonicalStoredBalanceUsd(
    row.organization_balance_usd,
    "organization_balance",
  );
  if (row.receipt_id === null) {
    if (row.marker_id !== null || row.marker_organization_id !== null) {
      const markerAmount = row.marker_amount;
      const markerCreatedAt = dateValue(row.marker_created_at, "marker_created_at");
      if (
        !UUID_PATTERN.test(row.marker_id ?? "") ||
        row.marker_organization_id !== identity.organizationId ||
        row.marker_user_id !== null ||
        typeof markerAmount !== "string" ||
        !CANONICAL_NEGATIVE_CHARGE_USD_PATTERN.test(markerAmount) ||
        BigInt(markerAmount.slice(1).replace(".", "")) <= 0n ||
        row.marker_type !== "debit" ||
        row.marker_description !== LEDGER_DESCRIPTION ||
        row.marker_ledger_marker !== identity.ledgerIdempotencyMarker ||
        row.marker_settled_at !== null ||
        markerCreatedAt.getTime() > databaseNow.getTime() ||
        detachedMarkerReceiptId(row.marker_metadata) === null
      ) {
        unavailable(new Error("orphan_ledger_marker"));
      }
      throw new OrgStorageHeadReceiptConflictError("receipt_expired");
    }
    return { outcome: "miss", databaseNow, organizationBalanceUsd };
  }

  const receipt = parseReceipt(row, identity);
  if (receipt.createdAt.getTime() > databaseNow.getTime()) {
    unavailable(new Error("receipt_created_in_future"));
  }
  if (receipt.identity.requestDigest !== identity.requestDigest) {
    throw new OrgStorageHeadReceiptConflictError("idempotency_key_reused");
  }
  if (receipt.replayExpiresAt.getTime() <= databaseNow.getTime()) {
    throw new OrgStorageHeadReceiptConflictError("receipt_expired");
  }
  return { outcome: "replay", databaseNow, organizationBalanceUsd, receipt };
}

async function lockOrganization(
  transaction: DbTransaction,
  organizationId: string,
): Promise<string> {
  const rows = await sqlRows<{ credit_balance: string }>(
    transaction,
    sql`
      SELECT credit_balance::text AS credit_balance
      FROM organizations
      WHERE id = ${organizationId}
      FOR UPDATE
    `,
  );
  if (rows.length !== 1 || !rows[0]) unavailable(new Error("organization_not_found"));
  return canonicalStoredBalanceUsd(rows[0].credit_balance, "organization_balance");
}

function receiptCandidate(input: {
  id: string;
  identity: OrgStorageHeadReceiptIdentity;
  chargeAmountUsd: string;
  response: OrgStorageHeadTerminalResponse;
  creditTransactionId: string | null;
  createdAt: Date;
}): OrgStorageHeadReceipt {
  const replayExpiresAt = new Date(
    input.createdAt.getTime() + ORG_STORAGE_HEAD_RECEIPT_REPLAY_TTL_MS,
  );
  const purgeAfter = new Date(replayExpiresAt.getTime() + ORG_STORAGE_HEAD_RECEIPT_PURGE_GRACE_MS);
  const withoutDigest = Object.freeze({
    id: input.id,
    identity: input.identity,
    chargeAmountUsd: input.chargeAmountUsd,
    response: input.response,
    creditTransactionId: input.creditTransactionId,
    createdAt: new Date(input.createdAt.getTime()),
    replayExpiresAt,
    purgeAfter,
  });
  return Object.freeze({ ...withoutDigest, receiptDigest: receiptDigest(withoutDigest) });
}

async function insertLedger(
  transaction: DbTransaction,
  receipt: OrgStorageHeadReceipt,
): Promise<void> {
  const transactionId = receipt.creditTransactionId;
  if (transactionId === null) unavailable(new Error("ledger_id_missing"));
  const metadata = JSON.stringify({
    type: LEDGER_METADATA_TYPE,
    receipt_id: receipt.id,
    version: LEDGER_METADATA_VERSION,
  });
  await transaction.execute(sql`
    INSERT INTO credit_transactions (
      id, organization_id, user_id, amount, type, description, metadata,
      stripe_payment_intent_id, created_at, settled_at
    ) VALUES (
      ${transactionId}, ${receipt.identity.organizationId}, NULL,
      ${`-${receipt.chargeAmountUsd}`}::numeric, 'debit', ${LEDGER_DESCRIPTION},
      ${metadata}::jsonb, ${receipt.identity.ledgerIdempotencyMarker},
      (${receipt.createdAt}::timestamptz AT TIME ZONE 'UTC'), NULL
    )
  `);
}

async function insertReceipt(
  transaction: DbTransaction,
  receipt: OrgStorageHeadReceipt,
): Promise<void> {
  const response = receipt.response;
  const objectId = response.kind === "not_found" ? null : response.objectId;
  const objectGeneration =
    response.kind === "not_found" ? null : response.objectGeneration.toString(10);
  const contentLength = response.kind === "ok" ? response.contentLength.toString(10) : null;
  const contentType = response.kind === "ok" ? response.contentType : null;
  const etag = response.kind === "not_found" ? null : response.etag;
  const lastModified = response.kind === "not_found" ? null : response.lastModified;
  const forceAttachment = response.kind === "ok" ? response.forceAttachment : null;
  await transaction.execute(sql`
    INSERT INTO org_storage_head_receipts (
      id, organization_id, authority_version, storage_namespace, operation,
      idempotency_key_hash, request_digest, charge_amount_usd,
      response_kind, response_status, header_policy_version,
      object_id, object_generation, response_content_length, response_content_type,
      response_etag, response_last_modified, response_force_attachment,
      credit_transaction_id, receipt_digest, replay_expires_at, purge_after, created_at
    ) VALUES (
      ${receipt.id}, ${receipt.identity.organizationId}, ${AUTHORITY_VERSION},
      ${STORAGE_NAMESPACE}, ${OPERATION}, ${receipt.identity.idempotencyKeyHash},
      ${receipt.identity.requestDigest}, ${receipt.chargeAmountUsd}::numeric,
      ${response.kind}, ${responseStatus(response)}, ${HEADER_POLICY_VERSION},
      ${objectId}, ${objectGeneration}::bigint, ${contentLength}::bigint, ${contentType},
      ${etag}, ${lastModified}, ${forceAttachment}, ${receipt.creditTransactionId},
      ${receipt.receiptDigest}, ${receipt.replayExpiresAt}, ${receipt.purgeAfter},
      ${receipt.createdAt}
    )
  `);
}

async function debitBalance(
  transaction: DbTransaction,
  organizationId: string,
  amountUsd: string,
  now: Date,
): Promise<string | null> {
  const rows = await sqlRows<{ credit_balance: string }>(
    transaction,
    sql`
      UPDATE organizations
      SET credit_balance = credit_balance - ${amountUsd}::numeric,
          updated_at = ${now}
      WHERE id = ${organizationId}
        AND credit_balance >= ${amountUsd}::numeric
      RETURNING credit_balance::text AS credit_balance
    `,
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) unavailable(new Error("balance_update_shape"));
  return canonicalStoredBalanceUsd(rows[0].credit_balance, "organization_balance");
}

function isKnownReceiptError(error: unknown): boolean {
  return (
    error instanceof OrgStorageHeadReceiptInvalidInputError ||
    error instanceof OrgStorageHeadReceiptConflictError ||
    error instanceof OrgStorageHeadReceiptInsufficientCreditsError ||
    error instanceof OrgStorageHeadReceiptInvariantError ||
    error instanceof OrgStorageHeadReceiptUnavailableError
  );
}

/** Primary-only repository for terminal native-storage HEAD receipts. */
export class OrgStorageHeadReceiptRepository {
  constructor(
    private readonly runTransaction: OrgStorageHeadReceiptTransactionRunner = writeTransaction,
  ) {}

  /**
   * Validates and hashes one request, then checks the primary for a terminal replay.
   * This method is intended to run before catalog, pricing, or provider work.
   */
  async prepare(
    input: PrepareOrgStorageHeadReceiptInput,
  ): Promise<PrepareOrgStorageHeadReceiptResult> {
    const identity = prepareIdentity(input);
    try {
      const lookup = await lookupReceipt(dbWrite, identity);
      return lookup.outcome === "replay"
        ? { outcome: "replay", receipt: lookup.receipt }
        : { outcome: "miss", identity };
    } catch (error) {
      if (isKnownReceiptError(error)) throw error;
      throw new OrgStorageHeadReceiptUnavailableError(error);
    }
  }

  /**
   * Commits a verified terminal response. The positive ledger debit and receipt
   * share one transaction; an ambiguous transaction acknowledgement is recovered
   * once from the primary and is never blindly retried.
   */
  async commitTerminal(
    input: CommitOrgStorageHeadReceiptInput,
  ): Promise<CommitOrgStorageHeadReceiptResult> {
    const identity = canonicalIdentity(input.identity);
    const chargeAmountUsd = input.chargeAmountUsd;
    const chargeMicros = requireCanonicalUsd(chargeAmountUsd);
    const response = canonicalResponse(input.response);
    const receiptId = randomUUID();
    const transactionId = chargeMicros === 0n ? null : randomUUID();

    try {
      const result = await this.runTransaction<InternalTransactionResult>(async (transaction) => {
        await lockOrganization(transaction, identity.organizationId);
        const existing = await lookupReceipt(transaction, identity);
        if (existing.outcome === "replay") {
          return { outcome: "replayed", receipt: existing.receipt };
        }

        const candidate = receiptCandidate({
          id: receiptId,
          identity,
          chargeAmountUsd,
          response,
          creditTransactionId: transactionId,
          createdAt: existing.databaseNow,
        });
        let observedBalanceUsd: string | null = null;
        if (chargeMicros > 0n) {
          observedBalanceUsd = await debitBalance(
            transaction,
            identity.organizationId,
            chargeAmountUsd,
            candidate.createdAt,
          );
          if (observedBalanceUsd === null) return { outcome: "insufficient_credits" };
          await insertLedger(transaction, candidate);
        }
        await insertReceipt(transaction, candidate);

        const committed = await lookupReceipt(transaction, identity);
        if (committed.outcome !== "replay" || committed.receipt.id !== receiptId) {
          unavailable(new Error("receipt_insert_not_authoritative"));
        }
        return {
          outcome: "committed",
          receipt: committed.receipt,
          balanceMutation:
            transactionId === null || observedBalanceUsd === null
              ? null
              : { transactionId, observedBalanceUsd },
        };
      });

      if (result.outcome === "insufficient_credits") {
        throw new OrgStorageHeadReceiptInsufficientCreditsError();
      }
      return result.outcome === "committed"
        ? result
        : { outcome: "replayed", receipt: result.receipt, balanceMutation: null };
    } catch (error) {
      if (isKnownReceiptError(error)) throw error;

      // The transaction may have committed while its acknowledgement was lost.
      // One primary read identifies our exact candidate or a concurrent winner.
      try {
        const recovered = await lookupReceipt(dbWrite, identity);
        if (recovered.outcome === "replay") {
          if (recovered.receipt.id === receiptId) {
            return {
              outcome: "committed",
              receipt: recovered.receipt,
              balanceMutation:
                recovered.receipt.creditTransactionId === null
                  ? null
                  : {
                      transactionId: recovered.receipt.creditTransactionId,
                      observedBalanceUsd: recovered.organizationBalanceUsd,
                    },
            };
          }
          return { outcome: "replayed", receipt: recovered.receipt, balanceMutation: null };
        }
      } catch (recoveryError) {
        if (isKnownReceiptError(recoveryError)) throw recoveryError;
        throw new OrgStorageHeadReceiptUnavailableError(recoveryError);
      }
      throw new OrgStorageHeadReceiptUnavailableError(error);
    }
  }
}

export const orgStorageHeadReceiptRepository = new OrgStorageHeadReceiptRepository();

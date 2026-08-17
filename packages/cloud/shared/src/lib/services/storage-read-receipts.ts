/**
 * Durable paid receipts for private storage read capabilities.
 *
 * A receipt binds one caller idempotency key to one tenant-scoped GET request.
 * Only digests and public capability configuration enter ledger metadata: raw
 * idempotency keys, object keys, signed URLs, and capability tokens never do.
 * Zero-cost reads deliberately bypass this paid-receipt lane.
 */

import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import type { CreditTransaction } from "../../db/schemas/credit-transactions";
import { type CreditsService, creditsService, type DeductCreditsParams } from "./credits";

const RECEIPT_TYPE = "proxy_storage";
const RECEIPT_MARKER = "storage_presign_receipt_v1";
const RECEIPT_VERSION = 1;
const RECEIPT_SERVICE = "storage";
const RECEIPT_METHOD = "presign";
const RECEIPT_OPERATION = "get";
const LEDGER_KEY_PREFIX = "storage-presign:v1";
const REQUEST_DIGEST_DOMAIN = "storage-presign-request:v1";
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const MAX_IDEMPOTENCY_KEY_CHARACTERS = 128;
const MAX_CAPABILITY_HOST_CHARACTERS = 259;
const MAX_CLOCK_SKEW_SECONDS = 30;
const MAX_LEDGER_CHARGE_USD = new Decimal("999999.999999");
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_POSITIVE_USD_PATTERN = /^(?:0|[1-9]\d*)\.\d{6}$/;
const CANONICAL_NEGATIVE_USD_PATTERN = /^-(?:0|[1-9]\d*)\.\d{6}$/;
const RECEIPT_METADATA_KEYS = new Set([
  "type",
  "storagePresignReceipt",
  "version",
  "service",
  "method",
  "operation",
  "requestDigest",
  "capabilityHost",
  "issuedAt",
  "expiresAt",
  "chargeAmountUsd",
]);
const UTF8_ENCODER = new TextEncoder();

export type StorageReadReceiptConflictReason = "idempotency_key_reused" | "receipt_expired";

/** The caller supplied an idempotency key that cannot safely identify a request. */
export class StorageReadReceiptInvalidIdempotencyKeyError extends ElizaError {
  override readonly name = "StorageReadReceiptInvalidIdempotencyKeyError";
  readonly statusCode = 400;

  constructor() {
    super("A valid Idempotency-Key header is required", {
      code: "STORAGE_READ_RECEIPT_INVALID_IDEMPOTENCY_KEY",
      severity: "ephemeral",
    });
  }
}

/** The idempotency identity is valid but cannot authorize this request. */
export class StorageReadReceiptConflictError extends ElizaError {
  override readonly name = "StorageReadReceiptConflictError";
  readonly statusCode = 409;
  readonly transactionId: string | undefined;

  constructor(
    readonly reason: StorageReadReceiptConflictReason,
    expiredTransactionId?: string,
  ) {
    const transactionId =
      reason === "receipt_expired" &&
      expiredTransactionId !== undefined &&
      UUID_PATTERN.test(expiredTransactionId)
        ? expiredTransactionId
        : undefined;
    super(
      reason === "receipt_expired"
        ? "The storage read receipt expired; use a new Idempotency-Key"
        : "The Idempotency-Key was already used for a different storage read request",
      {
        code: "STORAGE_READ_RECEIPT_CONFLICT",
        context: { reason, ...(transactionId ? { transactionId } : {}) },
        severity: "ephemeral",
      },
    );
    this.transactionId = transactionId;
  }
}

/** A paid read could not be admitted because the organization lacks credits. */
export class StorageReadReceiptInsufficientCreditsError extends ElizaError {
  override readonly name = "StorageReadReceiptInsufficientCreditsError";
  readonly statusCode = 402;

  constructor() {
    super("Insufficient credits", {
      code: "STORAGE_READ_RECEIPT_INSUFFICIENT_CREDITS",
      severity: "ephemeral",
    });
  }
}

/** A ledger/configuration invariant failed, so no capability may be disclosed. */
export class StorageReadReceiptUnavailableError extends ElizaError {
  override readonly name = "StorageReadReceiptUnavailableError";
  readonly statusCode = 503;

  constructor(options?: { cause?: unknown }) {
    super("Storage read receipt is unavailable", {
      code: "STORAGE_READ_RECEIPT_UNAVAILABLE",
      cause: options?.cause,
      severity: "ephemeral",
    });
  }
}

export interface StorageReadReceiptTemporalClaims {
  issuedAt: number;
  expiresAt: number;
  capabilityHost: string;
}

export interface StorageReadReceiptClaims extends StorageReadReceiptTemporalClaims {
  chargeAmountUsd: string;
}

interface PreparedStorageReadReceiptBase {
  organizationId: string;
  ledgerIdempotencyKey: string;
  requestDigest: string;
  ttlSeconds: number;
  capabilityHost: string;
}

export interface NewPreparedStorageReadReceipt extends PreparedStorageReadReceiptBase {
  status: "new";
  candidateClaims: StorageReadReceiptTemporalClaims;
}

export interface ReplayedPreparedStorageReadReceipt extends PreparedStorageReadReceiptBase {
  status: "replay";
  claims: StorageReadReceiptClaims;
  transactionId: string;
}

export type PreparedStorageReadReceipt =
  | NewPreparedStorageReadReceipt
  | ReplayedPreparedStorageReadReceipt;

export interface PrepareStorageReadReceiptInput {
  rawIdempotencyKey: string | undefined;
  organizationId: string;
  scopedKey: string;
  ttlSeconds: number;
  capabilityHost: string;
}

export interface ChargeStorageReadReceiptInput {
  chargeAmountUsd: number;
}

export interface ChargedStorageReadReceipt {
  claims: StorageReadReceiptClaims;
  transactionId: string;
  /**
   * True when recovery definitely selected a prior candidate. A concurrent
   * winner with byte-identical claims is observationally equivalent to the
   * local candidate and may report false.
   */
  replayed: boolean;
}

type StorageReadReceiptDeductResult = Awaited<ReturnType<CreditsService["deductCredits"]>>;

export interface StorageReadReceiptCredits {
  getCommittedTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CreditTransaction | undefined>;
  deductCredits(params: DeductCreditsParams): Promise<StorageReadReceiptDeductResult>;
}

interface StorageReadReceiptMetadata extends Record<string, unknown> {
  type: typeof RECEIPT_TYPE;
  storagePresignReceipt: typeof RECEIPT_MARKER;
  version: typeof RECEIPT_VERSION;
  service: typeof RECEIPT_SERVICE;
  method: typeof RECEIPT_METHOD;
  operation: typeof RECEIPT_OPERATION;
  requestDigest: string;
  capabilityHost: string;
  issuedAt: number;
  expiresAt: number;
  chargeAmountUsd: string;
}

function isValidRawIdempotencyKey(value: string | undefined): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length < 1 || value.length > MAX_IDEMPOTENCY_KEY_CHARACTERS || value !== value.trim()) {
    return false;
  }
  let hasNonWhitespace = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint > 0x7e) {
      return false;
    }
    if (character !== " ") {
      hasNonWhitespace = true;
    }
  }
  return hasNonWhitespace;
}

function isCanonicalCapabilityHost(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > MAX_CAPABILITY_HOST_CHARACTERS ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    value.includes("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("@") ||
    !URL.canParse(`https://${value}`)
  ) {
    return false;
  }
  const parsed = new URL(`https://${value}`);
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.host === value
  );
}

function assertTtlSeconds(ttlSeconds: number): void {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < MIN_TTL_SECONDS ||
    ttlSeconds > MAX_TTL_SECONDS
  ) {
    throw new StorageReadReceiptUnavailableError();
  }
}

function readSafeNow(nowSeconds: () => number): number {
  const now = nowSeconds();
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new StorageReadReceiptUnavailableError();
  }
  return now;
}

function assertSafeTemporalClaims(
  claims: StorageReadReceiptTemporalClaims,
  expectedTtlSeconds: number,
  expectedHost: string,
  nowSeconds: number,
  expiredTransactionId?: string,
): void {
  if (
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.issuedAt <= 0 ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt !== expectedTtlSeconds ||
    claims.issuedAt > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
    claims.capabilityHost !== expectedHost
  ) {
    throw new StorageReadReceiptUnavailableError();
  }
  if (claims.expiresAt <= nowSeconds) {
    throw new StorageReadReceiptConflictError("receipt_expired", expiredTransactionId);
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", UTF8_ENCODER.encode(value));
  let encoded = "";
  for (const byte of new Uint8Array(digest)) {
    encoded += byte.toString(16).padStart(2, "0");
  }
  return encoded;
}

function canonicalRequestIdentity(input: PrepareStorageReadReceiptInput): string {
  return JSON.stringify([
    REQUEST_DIGEST_DOMAIN,
    input.organizationId,
    RECEIPT_OPERATION,
    input.scopedKey,
    input.ttlSeconds,
  ]);
}

function canonicalChargeAmountUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new StorageReadReceiptUnavailableError();
  }
  const quantized = new Decimal(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  if (!quantized.isFinite() || quantized.lte(0) || quantized.gt(MAX_LEDGER_CHARGE_USD)) {
    throw new StorageReadReceiptUnavailableError();
  }
  return quantized.toFixed(6);
}

function receiptMetadata(
  prepared: NewPreparedStorageReadReceipt,
  chargeAmountUsd: string,
): StorageReadReceiptMetadata {
  return {
    type: RECEIPT_TYPE,
    storagePresignReceipt: RECEIPT_MARKER,
    version: RECEIPT_VERSION,
    service: RECEIPT_SERVICE,
    method: RECEIPT_METHOD,
    operation: RECEIPT_OPERATION,
    requestDigest: prepared.requestDigest,
    capabilityHost: prepared.capabilityHost,
    issuedAt: prepared.candidateClaims.issuedAt,
    expiresAt: prepared.candidateClaims.expiresAt,
    chargeAmountUsd,
  };
}

function isExactReceiptMetadataShape(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === RECEIPT_METADATA_KEYS.size &&
    keys.every((key) => RECEIPT_METADATA_KEYS.has(key))
  );
}

function parseCommittedReceipt(
  transaction: CreditTransaction,
  expected: PreparedStorageReadReceiptBase,
  nowSeconds: number,
): StorageReadReceiptClaims {
  if (
    !UUID_PATTERN.test(transaction.id) ||
    transaction.stripe_payment_intent_id !== expected.ledgerIdempotencyKey ||
    transaction.organization_id !== expected.organizationId ||
    transaction.type !== "debit"
  ) {
    throw new StorageReadReceiptUnavailableError();
  }

  const metadata = transaction.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new StorageReadReceiptUnavailableError();
  }
  if (
    !isExactReceiptMetadataShape(metadata) ||
    metadata.type !== RECEIPT_TYPE ||
    metadata.storagePresignReceipt !== RECEIPT_MARKER ||
    metadata.version !== RECEIPT_VERSION ||
    metadata.service !== RECEIPT_SERVICE ||
    metadata.method !== RECEIPT_METHOD ||
    metadata.operation !== RECEIPT_OPERATION ||
    typeof metadata.requestDigest !== "string" ||
    !SHA256_HEX_PATTERN.test(metadata.requestDigest)
  ) {
    throw new StorageReadReceiptUnavailableError();
  }
  if (metadata.requestDigest !== expected.requestDigest) {
    throw new StorageReadReceiptConflictError("idempotency_key_reused");
  }
  if (
    typeof metadata.capabilityHost !== "string" ||
    metadata.capabilityHost !== expected.capabilityHost ||
    !isCanonicalCapabilityHost(metadata.capabilityHost) ||
    typeof metadata.issuedAt !== "number" ||
    typeof metadata.expiresAt !== "number" ||
    typeof metadata.chargeAmountUsd !== "string" ||
    metadata.chargeAmountUsd.length > "999999.999999".length ||
    !CANONICAL_POSITIVE_USD_PATTERN.test(metadata.chargeAmountUsd) ||
    typeof transaction.amount !== "string" ||
    transaction.amount.length > "-999999.999999".length ||
    !CANONICAL_NEGATIVE_USD_PATTERN.test(transaction.amount)
  ) {
    throw new StorageReadReceiptUnavailableError();
  }

  const charge = new Decimal(metadata.chargeAmountUsd);
  const ledgerAmount = new Decimal(transaction.amount);
  if (
    !charge.isFinite() ||
    charge.lte(0) ||
    charge.gt(MAX_LEDGER_CHARGE_USD) ||
    !ledgerAmount.equals(charge.negated())
  ) {
    throw new StorageReadReceiptUnavailableError();
  }

  const claims: StorageReadReceiptClaims = {
    issuedAt: metadata.issuedAt,
    expiresAt: metadata.expiresAt,
    capabilityHost: metadata.capabilityHost,
    chargeAmountUsd: metadata.chargeAmountUsd,
  };
  assertSafeTemporalClaims(
    claims,
    expected.ttlSeconds,
    expected.capabilityHost,
    nowSeconds,
    transaction.id,
  );
  return claims;
}

function candidateMatchesCommittedClaims(
  prepared: NewPreparedStorageReadReceipt,
  claims: StorageReadReceiptClaims,
  chargeAmountUsd: string,
): boolean {
  return (
    claims.issuedAt === prepared.candidateClaims.issuedAt &&
    claims.expiresAt === prepared.candidateClaims.expiresAt &&
    claims.capabilityHost === prepared.candidateClaims.capabilityHost &&
    claims.chargeAmountUsd === chargeAmountUsd
  );
}

/** Coordinates the primary-read, debit, and durable replay receipt lifecycle. */
export class StorageReadReceiptService {
  constructor(
    private readonly credits: StorageReadReceiptCredits = creditsService,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private async readCommittedTransaction(
    idempotencyKey: string,
  ): Promise<CreditTransaction | undefined> {
    try {
      return await this.credits.getCommittedTransactionByIdempotencyKey(idempotencyKey);
    } catch (error) {
      // error-policy:J2 primary receipt lookup failures remain fail-closed and
      // preserve their cause without exposing ledger or capability identities.
      throw new StorageReadReceiptUnavailableError({ cause: error });
    }
  }

  /**
   * Derive privacy-safe identities and recover any committed receipt before a
   * caller performs object lookup, pricing, signing validation, or a debit.
   */
  async prepare(input: PrepareStorageReadReceiptInput): Promise<PreparedStorageReadReceipt> {
    const rawIdempotencyKey = input.rawIdempotencyKey;
    if (!isValidRawIdempotencyKey(rawIdempotencyKey)) {
      throw new StorageReadReceiptInvalidIdempotencyKeyError();
    }
    if (
      input.organizationId.length === 0 ||
      input.scopedKey.length === 0 ||
      !isCanonicalCapabilityHost(input.capabilityHost)
    ) {
      throw new StorageReadReceiptUnavailableError();
    }
    assertTtlSeconds(input.ttlSeconds);
    const now = readSafeNow(this.nowSeconds);
    const [idempotencyDigest, requestDigest] = await Promise.all([
      sha256Hex(rawIdempotencyKey),
      sha256Hex(canonicalRequestIdentity(input)),
    ]);
    const preparedBase: PreparedStorageReadReceiptBase = {
      organizationId: input.organizationId,
      ledgerIdempotencyKey: `${LEDGER_KEY_PREFIX}:${input.organizationId}:${idempotencyDigest}`,
      requestDigest,
      ttlSeconds: input.ttlSeconds,
      capabilityHost: input.capabilityHost,
    };

    const existing = await this.readCommittedTransaction(preparedBase.ledgerIdempotencyKey);
    if (existing) {
      return {
        status: "replay",
        ...preparedBase,
        claims: parseCommittedReceipt(existing, preparedBase, now),
        transactionId: existing.id,
      };
    }

    const candidateClaims: StorageReadReceiptTemporalClaims = {
      issuedAt: now,
      expiresAt: now + input.ttlSeconds,
      capabilityHost: input.capabilityHost,
    };
    assertSafeTemporalClaims(candidateClaims, input.ttlSeconds, input.capabilityHost, now);
    return { status: "new", ...preparedBase, candidateClaims };
  }

  /**
   * Debit once and return only claims parsed back from the durable transaction.
   * A thrown post-commit side effect triggers one primary recovery read.
   */
  async chargeOrReplay(
    prepared: NewPreparedStorageReadReceipt,
    input: ChargeStorageReadReceiptInput,
  ): Promise<ChargedStorageReadReceipt> {
    const now = readSafeNow(this.nowSeconds);
    const expectedLedgerKeyPrefix = `${LEDGER_KEY_PREFIX}:${prepared.organizationId}:`;
    if (
      prepared.status !== "new" ||
      !SHA256_HEX_PATTERN.test(prepared.requestDigest) ||
      !prepared.ledgerIdempotencyKey.startsWith(expectedLedgerKeyPrefix) ||
      prepared.ledgerIdempotencyKey.length !== expectedLedgerKeyPrefix.length + 64 ||
      !SHA256_HEX_PATTERN.test(prepared.ledgerIdempotencyKey.slice(-64)) ||
      !isCanonicalCapabilityHost(prepared.capabilityHost)
    ) {
      throw new StorageReadReceiptUnavailableError();
    }
    assertTtlSeconds(prepared.ttlSeconds);
    assertSafeTemporalClaims(
      prepared.candidateClaims,
      prepared.ttlSeconds,
      prepared.capabilityHost,
      now,
    );
    const chargeAmountUsd = canonicalChargeAmountUsd(input.chargeAmountUsd);
    const metadata = receiptMetadata(prepared, chargeAmountUsd);

    let deduction: StorageReadReceiptDeductResult;
    try {
      deduction = await this.credits.deductCredits({
        organizationId: prepared.organizationId,
        amount: Number(chargeAmountUsd),
        description: "API proxy: storage — presign (get)",
        metadata,
        stripePaymentIntentId: prepared.ledgerIdempotencyKey,
      });
    } catch (error) {
      // error-policy:J2 an ambiguous debit failure gets one primary recovery
      // read; a miss rethrows the original outcome without fabricating success.
      const committed = await this.readCommittedTransaction(prepared.ledgerIdempotencyKey);
      if (!committed) {
        throw error;
      }
      return {
        claims: parseCommittedReceipt(committed, prepared, readSafeNow(this.nowSeconds)),
        transactionId: committed.id,
        replayed: true,
      };
    }

    if (!deduction.success) {
      throw new StorageReadReceiptInsufficientCreditsError();
    }
    if (!deduction.transaction) {
      throw new StorageReadReceiptUnavailableError();
    }
    const claims = parseCommittedReceipt(
      deduction.transaction,
      prepared,
      readSafeNow(this.nowSeconds),
    );
    return {
      claims,
      transactionId: deduction.transaction.id,
      replayed: !candidateMatchesCommittedClaims(prepared, claims, chargeAmountUsd),
    };
  }
}

export const storageReadReceiptService = new StorageReadReceiptService();

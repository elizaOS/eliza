/**
 * Executes and reconciles authenticated native R2 PUTs against the durable
 * database authority. Immutable provider keys let strong HEAD distinguish a
 * completed write from a safely refundable absence after a crash.
 */

import Decimal from "decimal.js";
import {
  orgStorageMutationsRepository,
  type PreparedStoragePut,
  StoragePutConflictError,
} from "../../../db/repositories/org-storage-mutations";
import type { OrgStoragePutOperation } from "../../../db/schemas/org-storage-mutations";
import type { RuntimeR2Bucket, RuntimeR2ObjectMetadata } from "../../storage/r2-runtime-binding";
import { logger } from "../../utils/logger";
import { creditsService, InsufficientCreditsError } from "../credits";

const PROVIDER_LEASE_MS = 5 * 60 * 1000;
const RECOVERY_GRACE_MS = 10 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY_BYTES = 200;

/** Rounds the per-byte leg up to the ledger's exact six-decimal unit. */
export function calculateStoragePutPrice(
  flatCost: number,
  perByteCost: number,
  bytes: number,
): number {
  if (
    !Number.isFinite(flatCost) ||
    !Number.isFinite(perByteCost) ||
    !Number.isSafeInteger(bytes) ||
    flatCost < 0 ||
    perByteCost < 0 ||
    bytes < 0
  ) {
    throw new Error("[NativeStoragePut] invalid server-owned pricing inputs");
  }
  return new Decimal(perByteCost)
    .mul(bytes)
    .toDecimalPlaces(6, Decimal.ROUND_CEIL)
    .add(flatCost)
    .toDecimalPlaces(6, Decimal.ROUND_CEIL)
    .toNumber();
}

export class NativeStoragePutError extends Error {
  constructor(
    public readonly code:
      | "IDEMPOTENCY_REQUIRED"
      | "IDEMPOTENCY_INVALID"
      | "OPERATION_IN_PROGRESS"
      | "PROVIDER_AMBIGUOUS"
      | "PROVIDER_INTEGRITY",
    message: string,
  ) {
    super(message);
    this.name = "NativeStoragePutError";
  }
}

export interface NativeStoragePutResponse {
  key: string;
  size: number;
  contentType: string;
  etag: string;
}

export interface ExecuteNativeStoragePutInput {
  bucket: RuntimeR2Bucket;
  organizationId: string;
  logicalKey: string;
  idempotencyKey: string;
  body: ArrayBuffer;
  contentType: string;
  priceUsd: number;
}

export interface ExecuteNativeStorageDeleteInput {
  bucket: RuntimeR2Bucket;
  organizationId: string;
  logicalKey: string;
  idempotencyKey: string;
  priceUsd: number;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
}

function canonicalPrice(priceUsd: number): string {
  if (!Number.isFinite(priceUsd) || priceUsd < 0) {
    throw new Error("[NativeStoragePut] server price must be finite and non-negative");
  }
  return priceUsd.toFixed(6);
}

async function requestIdentity(input: ExecuteNativeStoragePutInput) {
  const encodedKey = new TextEncoder().encode(input.idempotencyKey);
  if (encodedKey.byteLength === 0) {
    throw new NativeStoragePutError("IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
  }
  if (encodedKey.byteLength > MAX_IDEMPOTENCY_KEY_BYTES || /[\r\n\0]/.test(input.idempotencyKey)) {
    throw new NativeStoragePutError("IDEMPOTENCY_INVALID", "Idempotency-Key is invalid");
  }
  const contentSha256 = await sha256(input.body);
  const priceUsd = canonicalPrice(input.priceUsd);
  const idempotencyKeyHash = await sha256(input.idempotencyKey);
  const requestDigest = await sha256(
    JSON.stringify({
      version: 1,
      organizationId: input.organizationId,
      logicalKey: input.logicalKey,
      contentType: input.contentType,
      sizeBytes: input.body.byteLength,
      contentSha256,
      priceUsd,
    }),
  );
  return { contentSha256, priceUsd, idempotencyKeyHash, requestDigest };
}

async function deleteRequestIdentity(input: ExecuteNativeStorageDeleteInput) {
  const encodedKey = new TextEncoder().encode(input.idempotencyKey);
  if (encodedKey.byteLength === 0) {
    throw new NativeStoragePutError("IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
  }
  if (encodedKey.byteLength > MAX_IDEMPOTENCY_KEY_BYTES || /[\r\n\0]/.test(input.idempotencyKey)) {
    throw new NativeStoragePutError("IDEMPOTENCY_INVALID", "Idempotency-Key is invalid");
  }
  const priceUsd = canonicalPrice(input.priceUsd);
  if (priceUsd !== "0.000000") {
    throw new Error("[NativeStorageDelete] paid DELETE policy is not configured");
  }
  return {
    idempotencyKeyHash: await sha256(input.idempotencyKey),
    requestDigest: await sha256(
      JSON.stringify({
        version: 1,
        method: "delete",
        organizationId: input.organizationId,
        logicalKey: input.logicalKey,
        priceUsd,
      }),
    ),
  };
}

function responseFor(
  operation: OrgStoragePutOperation,
  logicalKey: string,
): NativeStoragePutResponse {
  if (!operation.result_etag) {
    throw new Error("[NativeStoragePut] committed operation is missing its ETag");
  }
  return {
    key: logicalKey,
    size: Number(operation.target_size_bytes),
    contentType: operation.target_content_type,
    etag: operation.result_etag,
  };
}

function validateObserved(
  operation: OrgStoragePutOperation,
  observed: RuntimeR2ObjectMetadata,
): { etag: string; uploadedAt: Date } {
  if (
    observed.size !== Number(operation.target_size_bytes) ||
    !observed.etag ||
    observed.customMetadata?.requestDigest !== operation.request_digest ||
    observed.customMetadata?.contentSha256 !== operation.target_content_sha256
  ) {
    throw new NativeStoragePutError(
      "PROVIDER_INTEGRITY",
      "R2 generation metadata did not match the durable PUT receipt",
    );
  }
  return { etag: observed.etag, uploadedAt: observed.uploaded ?? new Date() };
}

async function settleCredit(operation: OrgStoragePutOperation, actualCost: number): Promise<void> {
  const reservedAmount = Number(operation.price_usd);
  if (reservedAmount === 0) return;
  if (!operation.credit_transaction_id) {
    throw new Error("[NativeStoragePut] paid operation is missing its credit reservation");
  }
  await creditsService.reconcile({
    organizationId: operation.organization_id,
    reservedAmount,
    actualCost,
    description: "API proxy: storage — native put",
    metadata: {
      type: "proxy_storage",
      service: "storage",
      method: "put",
      storage_operation_id: operation.id,
      reservation_transaction_id: operation.credit_transaction_id,
    },
  });
}

async function commitObserved(
  operation: OrgStoragePutOperation,
  logicalKey: string,
  observed: RuntimeR2ObjectMetadata,
): Promise<NativeStoragePutResponse> {
  if (!operation.lease_token) {
    throw new Error("[NativeStoragePut] provider-started operation is missing its lease token");
  }
  const evidence = validateObserved(operation, observed);
  const response: NativeStoragePutResponse = {
    key: logicalKey,
    size: Number(operation.target_size_bytes),
    contentType: operation.target_content_type,
    etag: evidence.etag,
  };
  await orgStorageMutationsRepository.commitObservedPut({
    operationId: operation.id,
    organizationId: operation.organization_id,
    leaseToken: operation.lease_token,
    etag: evidence.etag,
    uploadedAt: evidence.uploadedAt,
    responseJson: JSON.stringify(response),
  });
  return response;
}

async function reserveCredits(prepared: PreparedStoragePut): Promise<OrgStoragePutOperation> {
  const operation = prepared.operation;
  if (operation.state !== "prepared") return operation;
  const amount = Number(operation.price_usd);
  if (amount === 0) {
    return await orgStorageMutationsRepository.attachCreditReservation({
      operationId: operation.id,
      organizationId: operation.organization_id,
      creditTransactionId: null,
    });
  }
  try {
    const reservation = await creditsService.reserve({
      organizationId: operation.organization_id,
      amount,
      idempotencyKey: `native-storage-put:${operation.id}`,
      description: "API proxy: storage — native put",
      metadata: {
        type: "proxy_storage",
        service: "storage",
        method: "put",
        storage_operation_id: operation.id,
      },
    });
    if (!reservation.reservationTransactionId) {
      throw new Error("[NativeStoragePut] credit reservation returned no transaction id");
    }
    return await orgStorageMutationsRepository.attachCreditReservation({
      operationId: operation.id,
      organizationId: operation.organization_id,
      creditTransactionId: reservation.reservationTransactionId,
    });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      await orgStorageMutationsRepository.finalizeRefund({
        operationId: operation.id,
        organizationId: operation.organization_id,
        responseJson: JSON.stringify({ error: "Insufficient credits" }),
      });
    }
    throw error;
  }
}

export async function executeNativeStoragePut(
  input: ExecuteNativeStoragePutInput,
): Promise<NativeStoragePutResponse> {
  if (!input.bucket.head) {
    throw new NativeStoragePutError("PROVIDER_INTEGRITY", "R2 HEAD is unavailable");
  }
  const identity = await requestIdentity(input);
  const prepared = await orgStorageMutationsRepository.preparePut({
    organizationId: input.organizationId,
    logicalKey: input.logicalKey,
    idempotencyKeyHash: identity.idempotencyKeyHash,
    requestDigest: identity.requestDigest,
    sizeBytes: BigInt(input.body.byteLength),
    contentType: input.contentType,
    contentSha256: identity.contentSha256,
    priceUsd: identity.priceUsd,
  });

  let operation = prepared.operation;
  if (operation.state === "committed") return responseFor(operation, input.logicalKey);
  if (operation.state === "refunded") {
    throw new NativeStoragePutError("OPERATION_IN_PROGRESS", "The prior PUT attempt was refunded");
  }
  operation = await reserveCredits(prepared);

  if (operation.state === "provider_started") {
    const observed = await input.bucket.head(operation.target_provider_key);
    if (observed) return await commitObserved(operation, input.logicalKey, observed);
    if (operation.lease_expires_at && operation.lease_expires_at > new Date()) {
      throw new NativeStoragePutError("OPERATION_IN_PROGRESS", "The PUT is still in progress");
    }
  }

  const now = new Date();
  operation = await orgStorageMutationsRepository.claimProviderLease({
    operationId: operation.id,
    organizationId: input.organizationId,
    leaseToken: crypto.randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + PROVIDER_LEASE_MS),
    now,
  });

  try {
    await input.bucket.put(operation.target_provider_key, input.body, {
      httpMetadata: { contentType: operation.target_content_type },
      customMetadata: {
        requestDigest: operation.request_digest,
        contentSha256: operation.target_content_sha256,
      },
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: operation.target_content_sha256,
    });
    const observed = await input.bucket.head(operation.target_provider_key);
    if (!observed) {
      throw new NativeStoragePutError(
        "PROVIDER_AMBIGUOUS",
        "R2 PUT completed without a strongly consistent HEAD result",
      );
    }
    return await commitObserved(operation, input.logicalKey, observed);
  } catch (error) {
    // error-policy:J2 an R2 write may have committed before transport failure.
    // Preserve provider_started for HEAD reconciliation; never refund here.
    logger.warn("[NativeStoragePut] provider outcome requires reconciliation", {
      operationId: operation.id,
      error,
    });
    throw error;
  }
}

export async function executeNativeStorageDelete(
  input: ExecuteNativeStorageDeleteInput,
): Promise<void> {
  if (!input.bucket.head) {
    throw new NativeStoragePutError("PROVIDER_INTEGRITY", "R2 HEAD is unavailable");
  }
  const identity = await deleteRequestIdentity(input);
  const prepared = await orgStorageMutationsRepository.prepareDelete({
    organizationId: input.organizationId,
    logicalKey: input.logicalKey,
    ...identity,
  });
  let operation = prepared.operation;
  if (operation.state === "committed") return;
  if (
    operation.state === "provider_started" &&
    operation.lease_expires_at &&
    operation.lease_expires_at > new Date()
  ) {
    throw new NativeStoragePutError("OPERATION_IN_PROGRESS", "The DELETE is still in progress");
  }
  const now = new Date();
  operation = await orgStorageMutationsRepository.claimDeleteLease({
    operationId: operation.id,
    organizationId: operation.organization_id,
    leaseToken: crypto.randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + PROVIDER_LEASE_MS),
    now,
  });
  try {
    await input.bucket.delete(operation.source_provider_key);
    const observed = await input.bucket.head(operation.source_provider_key);
    if (observed) {
      throw new NativeStoragePutError(
        "PROVIDER_AMBIGUOUS",
        "R2 DELETE completed but the immutable generation remains visible",
      );
    }
    await orgStorageMutationsRepository.commitObservedDelete({
      operationId: operation.id,
      organizationId: operation.organization_id,
      leaseToken: operation.lease_token!,
      responseJson: JSON.stringify({ deleted: true }),
    });
  } catch (error) {
    // error-policy:J2 deletion is idempotent, but quota and the catalog pointer
    // remain authoritative until a later strong HEAD proves provider absence.
    logger.warn("[NativeStorageDelete] provider outcome requires reconciliation", {
      operationId: operation.id,
      error,
    });
    throw error;
  }
}

export async function reconcileNativeStoragePuts(bucket: RuntimeR2Bucket) {
  if (!bucket.head) throw new Error("[NativeStoragePut] R2 HEAD is unavailable");
  const now = new Date();
  const due = await orgStorageMutationsRepository.listDueOperations(now);
  let committed = 0;
  let refunded = 0;
  let failed = 0;

  for (const operation of due) {
    try {
      if (operation.state === "provider_started") {
        const observed = await bucket.head(operation.target_provider_key);
        if (observed) {
          await commitObserved(operation, "[redacted]", observed);
          committed++;
          continue;
        }
      } else if (operation.created_at.getTime() + RECOVERY_GRACE_MS > now.getTime()) {
        continue;
      }
      let refundable = operation;
      if (Number(operation.price_usd) > 0 && !operation.credit_transaction_id) {
        const orphanedCreditId =
          await orgStorageMutationsRepository.findUnattachedCreditReservation(operation);
        if (orphanedCreditId) {
          refundable = await orgStorageMutationsRepository.attachCreditReservation({
            operationId: operation.id,
            organizationId: operation.organization_id,
            creditTransactionId: orphanedCreditId,
          });
        }
      }
      if (refundable.credit_transaction_id) {
        await settleCredit(refundable, 0);
      }
      await orgStorageMutationsRepository.finalizeRefund({
        operationId: operation.id,
        organizationId: operation.organization_id,
        responseJson: JSON.stringify({ error: "Storage PUT did not reach R2" }),
      });
      refunded++;
    } catch (error) {
      failed++;
      logger.warn("[NativeStoragePut] reconciliation item failed", {
        operationId: operation.id,
        error,
      });
    }
  }

  const dueDeletes = await orgStorageMutationsRepository.listDueDeletes(now);
  for (const pending of dueDeletes) {
    try {
      const observed = await bucket.head(pending.source_provider_key);
      if (pending.state === "prepared" || observed) {
        const retryNow = new Date();
        const leased = await orgStorageMutationsRepository.claimDeleteLease({
          operationId: pending.id,
          organizationId: pending.organization_id,
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(retryNow.getTime() + PROVIDER_LEASE_MS),
          now: retryNow,
        });
        await bucket.delete(leased.source_provider_key);
        if (await bucket.head(leased.source_provider_key)) continue;
        await orgStorageMutationsRepository.commitObservedDelete({
          operationId: leased.id,
          organizationId: leased.organization_id,
          leaseToken: leased.lease_token!,
          responseJson: JSON.stringify({ deleted: true }),
        });
      } else {
        await orgStorageMutationsRepository.commitObservedDelete({
          operationId: pending.id,
          organizationId: pending.organization_id,
          leaseToken: pending.lease_token!,
          responseJson: JSON.stringify({ deleted: true }),
        });
      }
    } catch (error) {
      failed++;
      logger.warn("[NativeStorageDelete] reconciliation failed", {
        operationId: pending.id,
        error,
      });
    }
  }

  const gc = await orgStorageMutationsRepository.listDueGc(now);
  let garbageCollected = 0;
  for (const item of gc) {
    try {
      await bucket.delete(item.provider_key);
      await orgStorageMutationsRepository.completeGc(item.id);
      garbageCollected++;
    } catch (error) {
      failed++;
      logger.warn("[NativeStoragePut] generation GC item failed", { gcId: item.id, error });
    }
  }
  return {
    scanned: due.length + dueDeletes.length,
    committed,
    refunded,
    garbageCollected,
    failed,
  };
}

export { StoragePutConflictError };

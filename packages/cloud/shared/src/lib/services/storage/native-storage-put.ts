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
import { orgStorageReadsRepository } from "../../../db/repositories/org-storage-reads";
import type {
  OrgStorageObject,
  OrgStoragePutOperation,
} from "../../../db/schemas/org-storage-mutations";
import type { RuntimeR2Bucket, RuntimeR2ObjectMetadata } from "../../storage/r2-runtime-binding";
import { logger } from "../../utils/logger";
import { InsufficientCreditsError } from "../credits";

const PROVIDER_LEASE_MS = 5 * 60 * 1000;
const RECOVERY_GRACE_MS = 10 * 60 * 1000;
const PROVIDER_ABSENCE_QUARANTINE_MS = 10 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY_BYTES = 200;
const NATIVE_STORAGE_QUOTA_RECONCILE_PAGE_SIZE = 1_000;
const NATIVE_STORAGE_QUOTA_RECONCILE_LIST_TIMEOUT_MS = 10_000;
const utf8Encoder = new TextEncoder();
const nativeStorageQuotaReconciliations = new WeakMap<
  RuntimeR2Bucket,
  Map<string, Promise<void>>
>();

/** Sums exact server-owned decimal legs, then rounds once to the ledger unit. */
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
  return new Decimal(flatCost.toString())
    .add(new Decimal(perByteCost.toString()).mul(bytes))
    .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
    .toNumber();
}

export class NativeStoragePutError extends Error {
  constructor(
    public readonly code:
      | "IDEMPOTENCY_REQUIRED"
      | "IDEMPOTENCY_INVALID"
      | "CONTENT_TYPE_INVALID"
      | "CONTENT_LENGTH_INVALID"
      | "CONTENT_SHA256_INVALID"
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
  body: ArrayBuffer | ReadableStream<Uint8Array>;
  /** Required for a stream because reading it here would defeat streaming. */
  sizeBytes?: number;
  /** Lowercase hex digest verified by R2 while it consumes a stream. */
  contentSha256?: string;
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

function legacyProviderKey(organizationId: string, logicalKey: string): string {
  return `org/${organizationId}/${logicalKey}`;
}

function adoptedContentType(observed: RuntimeR2ObjectMetadata): string {
  const contentType = observed.httpMetadata?.contentType?.trim() || "application/octet-stream";
  return contentType.length <= 255 && !/[\0\r\n]/.test(contentType)
    ? contentType
    : "application/octet-stream";
}

function listNativeStorageQuotaPage(
  operation: Promise<Awaited<ReturnType<NonNullable<RuntimeR2Bucket["list"]>>>>,
): Promise<Awaited<ReturnType<NonNullable<RuntimeR2Bucket["list"]>>>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new NativeStoragePutError("PROVIDER_INTEGRITY", "R2 quota reconciliation LIST timed out"),
      );
    }, NATIVE_STORAGE_QUOTA_RECONCILE_LIST_TIMEOUT_MS);
    operation.then(
      (page) => {
        clearTimeout(timeout);
        resolve(page);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function reconcileNativeStorageQuota(
  bucket: RuntimeR2Bucket,
  organizationId: string,
): Promise<void> {
  if (
    !(await orgStorageMutationsRepository.quotaNeedsNativeCatalogReconciliation(organizationId))
  ) {
    return;
  }
  if (!bucket.list) {
    throw new NativeStoragePutError(
      "PROVIDER_INTEGRITY",
      "R2 LIST is required for native quota reconciliation",
    );
  }
  const providerPrefix = `org/${organizationId}/`;
  // R2 cursors are opaque and have no documented size limit. Retain only a
  // fixed-size digest for cycle detection while passing the exact token back.
  const seenCursorDigests = new Set<string>();
  let cursor: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const page = await listNativeStorageQuotaPage(
      bucket.list({
        prefix: providerPrefix,
        cursor,
        limit: NATIVE_STORAGE_QUOTA_RECONCILE_PAGE_SIZE,
        include: ["httpMetadata"],
      }),
    );
    if (
      !page ||
      typeof page.truncated !== "boolean" ||
      !Array.isArray(page.objects) ||
      page.objects.length > NATIVE_STORAGE_QUOTA_RECONCILE_PAGE_SIZE ||
      (page.cursor !== undefined && typeof page.cursor !== "string")
    ) {
      throw new NativeStoragePutError(
        "PROVIDER_INTEGRITY",
        "R2 quota reconciliation returned an invalid object page",
      );
    }
    let nextCursor: string | undefined;
    if (page.truncated) {
      const nextPageCursor =
        typeof page.cursor === "string" && page.cursor.length > 0 ? page.cursor : null;
      const cursorDigest = nextPageCursor ? await sha256(nextPageCursor) : null;
      if (!nextPageCursor || !cursorDigest || seenCursorDigests.has(cursorDigest)) {
        throw new NativeStoragePutError(
          "PROVIDER_INTEGRITY",
          "R2 quota reconciliation pagination did not advance",
        );
      }
      seenCursorDigests.add(cursorDigest);
      nextCursor = nextPageCursor;
    }
    const candidates = [];
    for (let index = 0; index < page.objects.length; index += 1) {
      if (!Object.hasOwn(page.objects, index)) {
        throw new NativeStoragePutError(
          "PROVIDER_INTEGRITY",
          "R2 returned incomplete legacy quota metadata",
        );
      }
      const observed = page.objects[index];
      if (
        !observed ||
        typeof observed.key !== "string" ||
        !observed.key.startsWith(providerPrefix) ||
        observed.key.length === providerPrefix.length ||
        observed.key.length > 1_024 ||
        utf8Encoder.encode(observed.key).byteLength > 1_024 ||
        typeof observed.etag !== "string" ||
        !observed.etag ||
        observed.etag.length > 512 ||
        !Number.isSafeInteger(observed.size) ||
        observed.size <= 0 ||
        (observed.uploaded !== undefined &&
          (!(observed.uploaded instanceof Date) || !Number.isFinite(observed.uploaded.getTime())))
      ) {
        throw new NativeStoragePutError(
          "PROVIDER_INTEGRITY",
          "R2 returned incomplete legacy quota metadata",
        );
      }
      candidates.push({
        organizationId,
        logicalKey: observed.key.slice(providerPrefix.length),
        providerKey: observed.key,
        sizeBytes: BigInt(observed.size),
        contentType: adoptedContentType(observed),
        etag: observed.etag,
        uploadedAt: observed.uploaded ?? new Date(0),
      });
    }
    await orgStorageMutationsRepository.adoptLegacyObjects(candidates);
    hasMore = Boolean(nextCursor);
    if (nextCursor) {
      cursor = nextCursor;
    }
  }
  await orgStorageMutationsRepository.reconcileNativeQuotaFromCatalog(organizationId);
}

export async function ensureNativeStorageQuotaReconciled(
  bucket: RuntimeR2Bucket,
  organizationId: string,
): Promise<void> {
  let byOrganization = nativeStorageQuotaReconciliations.get(bucket);
  if (!byOrganization) {
    byOrganization = new Map();
    nativeStorageQuotaReconciliations.set(bucket, byOrganization);
  }
  const existing = byOrganization.get(organizationId);
  if (existing) {
    await existing;
    return;
  }
  const reconciliation = reconcileNativeStorageQuota(bucket, organizationId);
  byOrganization.set(organizationId, reconciliation);
  try {
    await reconciliation;
  } finally {
    if (byOrganization.get(organizationId) === reconciliation) {
      byOrganization.delete(organizationId);
    }
    if (byOrganization.size === 0) {
      nativeStorageQuotaReconciliations.delete(bucket);
    }
  }
}

export async function resolveNativeStorageObject(
  bucket: RuntimeR2Bucket,
  organizationId: string,
  logicalKey: string,
): Promise<OrgStorageObject | undefined> {
  await ensureNativeStorageQuotaReconciled(bucket, organizationId);
  const existing = await orgStorageMutationsRepository.findObject(organizationId, logicalKey);
  if (existing?.provider_key || existing?.deleted_at || (existing?.generation ?? 0n) > 0n) {
    return existing;
  }
  if (!bucket.head) throw new Error("[NativeStoragePut] R2 HEAD is unavailable");
  const providerKey = legacyProviderKey(organizationId, logicalKey);
  const observed = await bucket.head(providerKey);
  if (!observed) return existing;
  if (!observed.etag || observed.size <= 0) {
    throw new NativeStoragePutError(
      "PROVIDER_INTEGRITY",
      "Legacy R2 object metadata is incomplete",
    );
  }
  return await orgStorageMutationsRepository.adoptLegacyObject({
    organizationId,
    logicalKey,
    providerKey,
    sizeBytes: BigInt(observed.size),
    contentType: adoptedContentType(observed),
    etag: observed.etag,
    uploadedAt: observed.uploaded ?? new Date(0),
  });
}

async function requestIdentity(input: ExecuteNativeStoragePutInput) {
  const encodedKey = new TextEncoder().encode(input.idempotencyKey);
  if (encodedKey.byteLength === 0) {
    throw new NativeStoragePutError("IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
  }
  if (encodedKey.byteLength > MAX_IDEMPOTENCY_KEY_BYTES || /[\r\n\0]/.test(input.idempotencyKey)) {
    throw new NativeStoragePutError("IDEMPOTENCY_INVALID", "Idempotency-Key is invalid");
  }
  const contentType = input.contentType.trim();
  if (contentType.length === 0 || contentType.length > 255 || /[\0\r\n]/.test(contentType)) {
    throw new NativeStoragePutError("CONTENT_TYPE_INVALID", "Content-Type is invalid");
  }
  const bufferedBody = input.body instanceof ArrayBuffer ? input.body : undefined;
  const sizeBytes = bufferedBody ? bufferedBody.byteLength : input.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || !sizeBytes || sizeBytes <= 0) {
    throw new NativeStoragePutError(
      "CONTENT_LENGTH_INVALID",
      "A positive, safe Content-Length is required",
    );
  }
  const computedSha256 = bufferedBody ? await sha256(bufferedBody) : undefined;
  const contentSha256 = (input.contentSha256 ?? computedSha256)?.toLowerCase();
  if (!contentSha256 || !/^[0-9a-f]{64}$/.test(contentSha256)) {
    throw new NativeStoragePutError(
      "CONTENT_SHA256_INVALID",
      "A lowercase hexadecimal SHA-256 digest is required",
    );
  }
  if (computedSha256 && input.contentSha256 && computedSha256 !== contentSha256) {
    throw new NativeStoragePutError(
      "CONTENT_SHA256_INVALID",
      "The declared SHA-256 digest does not match the request body",
    );
  }
  const priceUsd = canonicalPrice(input.priceUsd);
  const idempotencyKeyHash = await sha256(input.idempotencyKey);
  const requestDigest = await sha256(
    JSON.stringify({
      version: 1,
      organizationId: input.organizationId,
      logicalKey: input.logicalKey,
      contentType,
      sizeBytes,
      contentSha256,
      priceUsd,
    }),
  );
  return { contentType, contentSha256, sizeBytes, priceUsd, idempotencyKeyHash, requestDigest };
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

function throwRefundReplay(operation: OrgStoragePutOperation): never {
  let response: { error?: unknown } = {};
  try {
    response = operation.response_json ? JSON.parse(operation.response_json) : {};
  } catch {
    throw new Error("[NativeStoragePut] refunded receipt is not valid JSON");
  }
  if (response.error === "Insufficient credits") {
    throw new InsufficientCreditsError(Number(operation.price_usd), 0, "insufficient_balance");
  }
  throw new NativeStoragePutError(
    "PROVIDER_AMBIGUOUS",
    typeof response.error === "string" ? response.error : "The prior PUT was refunded",
  );
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
  const result = await orgStorageMutationsRepository.reservePutCredits({
    operationId: operation.id,
    organizationId: operation.organization_id,
  });
  if (result.insufficient) {
    throw new InsufficientCreditsError(
      Number(operation.price_usd),
      result.available,
      "insufficient_balance",
    );
  }
  return result.operation;
}

export async function executeNativeStoragePut(
  input: ExecuteNativeStoragePutInput,
): Promise<NativeStoragePutResponse> {
  if (!input.bucket.head) {
    throw new NativeStoragePutError("PROVIDER_INTEGRITY", "R2 HEAD is unavailable");
  }
  const identity = await requestIdentity(input);
  await resolveNativeStorageObject(input.bucket, input.organizationId, input.logicalKey);
  const prepared = await orgStorageMutationsRepository.preparePut({
    organizationId: input.organizationId,
    logicalKey: input.logicalKey,
    idempotencyKeyHash: identity.idempotencyKeyHash,
    requestDigest: identity.requestDigest,
    sizeBytes: BigInt(identity.sizeBytes),
    contentType: identity.contentType,
    contentSha256: identity.contentSha256,
    priceUsd: identity.priceUsd,
  });

  let operation = prepared.operation;
  if (operation.state === "committed") return responseFor(operation, input.logicalKey);
  if (operation.state === "refunded") throwRefundReplay(operation);
  if (operation.state === "reconciling") {
    throw new NativeStoragePutError("OPERATION_IN_PROGRESS", "The prior PUT is reconciling");
  }
  operation = await reserveCredits(prepared);
  if (operation.state === "committed") return responseFor(operation, input.logicalKey);
  if (operation.state === "refunded") throwRefundReplay(operation);
  if (operation.state === "reconciling") {
    throw new NativeStoragePutError(
      "OPERATION_IN_PROGRESS",
      "The prior PUT cannot continue provider dispatch",
    );
  }

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
    if (error instanceof StoragePutConflictError && error.reason === "stale_lease") {
      const latest = await orgStorageMutationsRepository.findOperation(
        operation.organization_id,
        operation.id,
      );
      if (latest?.state === "refunded") {
        await input.bucket.delete(operation.target_provider_key);
        if (await input.bucket.head(operation.target_provider_key)) {
          throw new NativeStoragePutError(
            "PROVIDER_AMBIGUOUS",
            "A late R2 generation could not be removed after refund",
          );
        }
      }
    }
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
  await orgStorageReadsRepository.revokeCapabilitiesForObject({
    organizationId: operation.organization_id,
    objectId: operation.object_id,
    now: new Date(),
  });
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
  const staleBefore = new Date(now.getTime() - RECOVERY_GRACE_MS);
  let committed = 0;
  let refunded = 0;
  let failed = 0;

  for (const operation of due) {
    try {
      const leaseToken = crypto.randomUUID();
      const claimed = await orgStorageMutationsRepository.claimReconciliationLease({
        operationId: operation.id,
        organizationId: operation.organization_id,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + PROVIDER_LEASE_MS),
        staleBefore,
        now,
      });
      if (claimed.state === "provider_started" || claimed.provider_absence_observed_at) {
        const observed = await bucket.head(claimed.target_provider_key);
        if (observed) {
          await commitObserved(claimed, "[redacted]", observed);
          committed++;
          continue;
        }
        if (claimed.state === "provider_started") {
          await orgStorageMutationsRepository.deferProviderAbsence({
            operationId: claimed.id,
            organizationId: claimed.organization_id,
            leaseToken,
            observedAt: now,
            recheckAt: new Date(now.getTime() + PROVIDER_ABSENCE_QUARANTINE_MS),
          });
          continue;
        }
      }
      await orgStorageMutationsRepository.finalizeRefund({
        operationId: claimed.id,
        organizationId: claimed.organization_id,
        leaseToken,
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

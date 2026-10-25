/**
 * Executes paid native storage GET, HEAD, LIST, and presign requests through
 * durable receipts. Provider success is recorded before one atomic debit and
 * terminal receipt; retries recover from the database before provider access.
 */
import Decimal from "decimal.js";
import { orgStorageMutationsRepository } from "../../../db/repositories/org-storage-mutations";
import {
  orgStorageReadsRepository,
  type ProviderStorageReadResult,
  StorageReadConflictError,
} from "../../../db/repositories/org-storage-reads";
import type {
  OrgStorageReadMethod,
  OrgStorageReadOperation,
} from "../../../db/schemas/org-storage-reads";
import type { RuntimeR2Bucket, RuntimeR2Object } from "../../storage/r2-runtime-binding";
import {
  ensureNativeStorageQuotaReconciled,
  resolveNativeStorageObject,
} from "./native-storage-put";

const MAX_IDEMPOTENCY_KEY_BYTES = 200;
const MAX_LEDGER_PRICE = new Decimal("999999.999999");
const DIRECT_GET_REPLAY_MS = 5 * 60 * 1000;
const UTF8 = new TextEncoder();

export class NativeStorageReadError extends Error {
  constructor(
    public readonly code:
      | "IDEMPOTENCY_REQUIRED"
      | "IDEMPOTENCY_INVALID"
      | "IDEMPOTENCY_MISMATCH"
      | "PROVIDER_INTEGRITY"
      | "RECEIPT_CORRUPT"
      | "INSUFFICIENT_CREDITS",
    message: string,
  ) {
    super(message);
    this.name = "NativeStorageReadError";
  }
}

export interface NativeStorageObjectHeaders {
  contentType: string;
  size: number;
  etag: string;
  lastModified: string;
}

export interface NativeStorageGetResult {
  operation: OrgStorageReadOperation;
  status: number;
  headers?: NativeStorageObjectHeaders;
  object?: RuntimeR2Object;
  replay: boolean;
}

export interface NativeStorageJsonResult {
  operation: OrgStorageReadOperation;
  status: number;
  body: Record<string, unknown>;
  replay: boolean;
}

interface BaseReadInput {
  bucket: RuntimeR2Bucket;
  organizationId: string;
  userId: string;
  rawIdempotencyKey: string;
  priceUsd: number;
}

interface PreparedIdentity {
  operation: OrgStorageReadOperation;
  replay: boolean;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", UTF8.encode(value)));
}

function canonicalPrice(value: number | string): string {
  const decimal = new Decimal(String(value));
  if (!decimal.isFinite() || decimal.isNegative()) {
    throw new NativeStorageReadError("RECEIPT_CORRUPT", "Storage read price is invalid");
  }
  const rounded = decimal.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  if (rounded.gt(MAX_LEDGER_PRICE)) {
    throw new NativeStorageReadError("RECEIPT_CORRUPT", "Storage read price is out of range");
  }
  return rounded.toFixed(6);
}

function validateIdempotencyKey(value: string): void {
  const bytes = UTF8.encode(value);
  if (bytes.byteLength === 0) {
    throw new NativeStorageReadError("IDEMPOTENCY_REQUIRED", "Idempotency-Key is required");
  }
  if (
    bytes.byteLength > MAX_IDEMPOTENCY_KEY_BYTES ||
    value !== value.trim() ||
    /[\0\r\n]/.test(value)
  ) {
    throw new NativeStorageReadError("IDEMPOTENCY_INVALID", "Idempotency-Key is invalid");
  }
}

async function requestDigest(input: {
  organizationId: string;
  userId: string;
  method: OrgStorageReadMethod;
  request: Record<string, unknown>;
  priceUsd: string;
}): Promise<string> {
  return await sha256(
    JSON.stringify([
      "native-storage-read:v2",
      input.organizationId,
      input.userId,
      input.method,
      input.request,
      input.priceUsd,
    ]),
  );
}

async function prepareIdentity(input: {
  organizationId: string;
  userId: string;
  rawIdempotencyKey: string;
  method: OrgStorageReadMethod;
  request: Record<string, unknown>;
  priceUsd: number;
  capabilityHost?: string;
  capabilityTtlSeconds?: number;
}): Promise<PreparedIdentity> {
  validateIdempotencyKey(input.rawIdempotencyKey);
  const idempotencyKeyHash = await sha256(input.rawIdempotencyKey);
  const existing = await orgStorageReadsRepository.findByIdempotency(
    input.organizationId,
    idempotencyKeyHash,
  );
  const priceUsd = canonicalPrice(existing?.price_usd ?? input.priceUsd);
  const digest = await requestDigest({
    organizationId: input.organizationId,
    userId: input.userId,
    method: input.method,
    request: input.request,
    priceUsd,
  });
  if (existing) {
    if (
      existing.user_id !== input.userId ||
      existing.method !== input.method ||
      existing.request_digest !== digest
    ) {
      throw new NativeStorageReadError(
        "IDEMPOTENCY_MISMATCH",
        "Idempotency-Key was used for another storage request",
      );
    }
    return { operation: existing, replay: true };
  }

  let capability:
    | {
        capabilityId: string;
        capabilityHost: string;
        capabilityIssuedAt: Date;
        capabilityExpiresAt: Date;
        retainUntil: Date;
      }
    | undefined;
  if (input.method === "presign") {
    if (
      !input.capabilityHost ||
      !Number.isSafeInteger(input.capabilityTtlSeconds) ||
      input.capabilityTtlSeconds! < 60 ||
      input.capabilityTtlSeconds! > 3600
    ) {
      throw new NativeStorageReadError("RECEIPT_CORRUPT", "Capability policy is invalid");
    }
    const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const expiresAt = new Date(issuedAt.getTime() + input.capabilityTtlSeconds! * 1000);
    capability = {
      capabilityId: crypto.randomUUID(),
      capabilityHost: input.capabilityHost,
      capabilityIssuedAt: issuedAt,
      capabilityExpiresAt: expiresAt,
      retainUntil: expiresAt,
    };
  }
  try {
    return await orgStorageReadsRepository.prepare({
      organizationId: input.organizationId,
      userId: input.userId,
      idempotencyKeyHash,
      requestDigest: digest,
      method: input.method,
      priceUsd,
      ...capability,
      ...(input.method === "get"
        ? { retainUntil: new Date(Date.now() + DIRECT_GET_REPLAY_MS) }
        : {}),
    });
  } catch (error) {
    // error-policy:J2 translate only the expected repository identity conflict;
    // all other failures retain their original cause and stack.
    if (error instanceof StorageReadConflictError && error.reason === "idempotency_mismatch") {
      throw new NativeStorageReadError(
        "IDEMPOTENCY_MISMATCH",
        "Idempotency-Key was used for another storage request",
      );
    }
    throw error;
  }
}

function parseResponse(operation: OrgStorageReadOperation): Record<string, unknown> {
  if (!operation.response_json || operation.response_json.length > 2_000_000) {
    throw new NativeStorageReadError("RECEIPT_CORRUPT", "Storage receipt response is missing");
  }
  try {
    const parsed: unknown = JSON.parse(operation.response_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    // error-policy:J3 persisted receipt JSON is untrusted until shape validation.
    throw new NativeStorageReadError("RECEIPT_CORRUPT", "Storage receipt response is invalid");
  }
}

function responseStatus(operation: OrgStorageReadOperation): number {
  if (
    !operation.response_status ||
    operation.response_status < 100 ||
    operation.response_status > 599
  ) {
    throw new NativeStorageReadError("RECEIPT_CORRUPT", "Storage receipt status is invalid");
  }
  return operation.response_status;
}

function throwIfInsufficient(operation: OrgStorageReadOperation): void {
  if (responseStatus(operation) === 402) {
    throw new NativeStorageReadError("INSUFFICIENT_CREDITS", "Insufficient credits");
  }
}

async function settle(operation: OrgStorageReadOperation): Promise<OrgStorageReadOperation> {
  if (operation.state === "committed" || operation.state === "failed") return operation;
  const settled = await orgStorageReadsRepository.commitProviderSuccess({
    operationId: operation.id,
    organizationId: operation.organization_id,
    now: new Date(),
  });
  if (settled.insufficient) {
    throw new NativeStorageReadError("INSUFFICIENT_CREDITS", "Insufficient credits");
  }
  return settled.operation;
}

async function settlePresign(
  operation: OrgStorageReadOperation,
  now: Date,
): Promise<OrgStorageReadOperation> {
  if (
    operation.state === "provider_succeeded" &&
    operation.capability_expires_at &&
    operation.capability_expires_at <= now
  ) {
    return await orgStorageReadsRepository.expirePresignProviderSuccess({
      operationId: operation.id,
      organizationId: operation.organization_id,
      now,
    });
  }
  return await settle(operation);
}

async function failPrepared(
  operation: OrgStorageReadOperation,
  status: number,
  body: Record<string, unknown>,
): Promise<NativeStorageJsonResult> {
  const failed = await orgStorageReadsRepository.recordFailure({
    operationId: operation.id,
    organizationId: operation.organization_id,
    responseStatus: status,
    responseJson: JSON.stringify(body),
    now: new Date(),
  });
  return { operation: failed, status, body, replay: false };
}

function objectHeaders(operation: OrgStorageReadOperation): NativeStorageObjectHeaders {
  const response = parseResponse(operation);
  if (
    typeof response.contentType !== "string" ||
    typeof response.size !== "number" ||
    !Number.isSafeInteger(response.size) ||
    response.size < 0 ||
    typeof response.etag !== "string" ||
    typeof response.lastModified !== "string"
  ) {
    throw new NativeStorageReadError("RECEIPT_CORRUPT", "Storage object receipt is invalid");
  }
  return {
    contentType: response.contentType,
    size: response.size,
    etag: response.etag,
    lastModified: response.lastModified,
  };
}

async function reopenExactObject(
  bucket: RuntimeR2Bucket,
  operation: OrgStorageReadOperation,
): Promise<RuntimeR2Object> {
  if (!operation.provider_key || operation.result_size_bytes === null || !operation.result_etag) {
    throw new NativeStorageReadError(
      "RECEIPT_CORRUPT",
      "Storage receipt provider authority is missing",
    );
  }
  const object = await bucket.get(operation.provider_key, {
    onlyIf: { etagMatches: operation.result_etag },
  });
  if (
    !object ||
    object.etag !== operation.result_etag ||
    object.size !== Number(operation.result_size_bytes)
  ) {
    throw new NativeStorageReadError(
      "PROVIDER_INTEGRITY",
      "The receipted storage generation is unavailable",
    );
  }
  return object;
}

export async function executeNativeStorageGetOrHead(
  input: BaseReadInput & { logicalKey: string; method: "get" | "head" },
): Promise<NativeStorageGetResult> {
  const prepared = await prepareIdentity({
    ...input,
    method: input.method,
    request: { logicalKey: input.logicalKey },
  });
  let operation = prepared.operation;
  if (operation.state === "failed") {
    throwIfInsufficient(operation);
    return { operation, status: responseStatus(operation), replay: true };
  }
  if (operation.state === "provider_succeeded") operation = await settle(operation);
  if (operation.state === "committed") {
    const headers = objectHeaders(operation);
    return {
      operation,
      status: responseStatus(operation),
      headers,
      ...(input.method === "get"
        ? { object: await reopenExactObject(input.bucket, operation) }
        : {}),
      replay: true,
    };
  }

  const nativeObject = await resolveNativeStorageObject(
    input.bucket,
    input.organizationId,
    input.logicalKey,
  );
  if (!nativeObject?.provider_key || nativeObject.deleted_at) {
    const failed = await failPrepared(operation, 404, { error: "Object not found" });
    return { operation: failed.operation, status: failed.status, replay: false };
  }
  const observed =
    input.method === "head"
      ? await input.bucket.head?.(nativeObject.provider_key)
      : await input.bucket.get(nativeObject.provider_key, {
          onlyIf: nativeObject.etag ? { etagMatches: nativeObject.etag } : undefined,
        });
  if (
    !observed ||
    observed.etag !== nativeObject.etag ||
    observed.size !== Number(nativeObject.size_bytes) ||
    !nativeObject.content_type ||
    !nativeObject.uploaded_at
  ) {
    throw new NativeStorageReadError(
      "PROVIDER_INTEGRITY",
      "The cataloged storage generation is unavailable",
    );
  }
  const headers: NativeStorageObjectHeaders = {
    contentType: nativeObject.content_type,
    size: Number(nativeObject.size_bytes),
    etag: nativeObject.etag,
    lastModified: nativeObject.uploaded_at.toUTCString(),
  };
  const providerResult: ProviderStorageReadResult = {
    operationId: operation.id,
    organizationId: input.organizationId,
    objectId: nativeObject.id,
    objectGeneration: nativeObject.generation,
    providerKey: nativeObject.provider_key,
    resultSizeBytes: nativeObject.size_bytes,
    resultContentType: nativeObject.content_type,
    resultEtag: nativeObject.etag,
    responseStatus: 200,
    responseJson: JSON.stringify(headers),
    providerSucceededAt: new Date(),
  };
  operation = await orgStorageReadsRepository.recordProviderSuccess(providerResult);
  operation = await settle(operation);
  return {
    operation,
    status: 200,
    headers,
    ...(input.method === "get" ? { object: observed as RuntimeR2Object } : {}),
    replay: prepared.replay,
  };
}

export async function executeNativeStorageList(
  input: BaseReadInput & { prefix: string; recursive: boolean; limit: number },
): Promise<NativeStorageJsonResult> {
  const prepared = await prepareIdentity({
    ...input,
    method: "list",
    request: { prefix: input.prefix, recursive: input.recursive, limit: input.limit },
  });
  let operation = prepared.operation;
  if (operation.state === "failed") {
    throwIfInsufficient(operation);
    return {
      operation,
      status: responseStatus(operation),
      body: parseResponse(operation),
      replay: true,
    };
  }
  if (operation.state === "provider_succeeded") operation = await settle(operation);
  if (operation.state === "committed") {
    return {
      operation,
      status: responseStatus(operation),
      body: parseResponse(operation),
      replay: true,
    };
  }

  await ensureNativeStorageQuotaReconciled(input.bucket, input.organizationId);
  const catalog = await orgStorageMutationsRepository.listObjects(
    input.organizationId,
    input.prefix,
    input.limit + 1,
    input.recursive,
  );
  const body = {
    items: catalog.slice(0, input.limit).map((object) => {
      if (!object.content_type || !object.uploaded_at) {
        throw new NativeStorageReadError(
          "PROVIDER_INTEGRITY",
          "Storage catalog metadata is incomplete",
        );
      }
      return {
        key: object.logical_key,
        size: Number(object.size_bytes),
        contentType: object.content_type,
        modifiedAt: object.uploaded_at.toISOString(),
      };
    }),
    truncated: catalog.length > input.limit,
  };
  operation = await orgStorageReadsRepository.recordProviderSuccess({
    operationId: operation.id,
    organizationId: input.organizationId,
    responseStatus: 200,
    responseJson: JSON.stringify(body),
    providerSucceededAt: new Date(),
  });
  operation = await settle(operation);
  return { operation, status: 200, body, replay: prepared.replay };
}

export async function executeNativeStoragePresign(
  input: BaseReadInput & {
    logicalKey: string;
    capabilityHost: string;
    ttlSeconds: number;
  },
): Promise<NativeStorageJsonResult> {
  const prepared = await prepareIdentity({
    ...input,
    method: "presign",
    request: {
      logicalKey: input.logicalKey,
      ttlSeconds: input.ttlSeconds,
      capabilityHost: input.capabilityHost,
    },
    capabilityHost: input.capabilityHost,
    capabilityTtlSeconds: input.ttlSeconds,
  });
  let operation = prepared.operation;
  const rootOperationId = operation.id;
  if (operation.renewal_root_id !== null || operation.renewal_generation !== 0) {
    throw new NativeStorageReadError("RECEIPT_CORRUPT", "Capability root receipt is invalid");
  }
  if (operation.state === "failed" && operation.response_status !== 409) {
    throwIfInsufficient(operation);
    return {
      operation,
      status: responseStatus(operation),
      body: parseResponse(operation),
      replay: true,
    };
  }
  if (operation.state === "provider_succeeded") {
    operation = await settlePresign(operation, new Date());
  }
  if (operation.state === "committed" || operation.response_status === 409) {
    const latest = await orgStorageReadsRepository.findLatestPresignRenewal({
      organizationId: input.organizationId,
      rootOperationId,
    });
    if (!latest) {
      throw new NativeStorageReadError("RECEIPT_CORRUPT", "Capability lineage is missing");
    }
    operation = latest;
    if (operation.state === "provider_succeeded") {
      operation = await settlePresign(operation, new Date());
    }
    if (operation.capability_revoked_at !== null) {
      throw new NativeStorageReadError("PROVIDER_INTEGRITY", "Storage capability was revoked");
    }
    if (
      (operation.state === "committed" &&
        operation.capability_expires_at &&
        operation.capability_expires_at <= new Date()) ||
      (operation.state === "failed" && operation.response_status === 409)
    ) {
      const generation = operation.renewal_generation + 1;
      const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const expiresAt = new Date(issuedAt.getTime() + input.ttlSeconds * 1000);
      const renewalPrice = canonicalPrice(input.priceUsd);
      const renewed = await orgStorageReadsRepository.preparePresignRenewal({
        organizationId: input.organizationId,
        userId: input.userId,
        rootOperationId,
        expectedGeneration: generation,
        idempotencyKeyHash: await sha256(
          JSON.stringify([
            "native-storage-presign-renewal:v1",
            input.organizationId,
            rootOperationId,
            generation,
          ]),
        ),
        requestDigest: await sha256(
          JSON.stringify([
            "native-storage-presign-renewal:v1",
            rootOperationId,
            generation,
            input.organizationId,
            input.userId,
            input.capabilityHost,
            input.ttlSeconds,
            renewalPrice,
          ]),
        ),
        priceUsd: renewalPrice,
        capabilityId: crypto.randomUUID(),
        capabilityHost: input.capabilityHost,
        capabilityIssuedAt: issuedAt,
        capabilityExpiresAt: expiresAt,
        now: issuedAt,
      });
      operation = renewed.operation;
      if (operation.state === "provider_succeeded") {
        operation = await settlePresign(operation, new Date());
      }
      if (operation.state === "failed" && operation.response_status === 409) {
        return await executeNativeStoragePresign(input);
      }
    }
    if (operation.state === "committed") {
      return {
        operation,
        status: responseStatus(operation),
        body: parseResponse(operation),
        replay: true,
      };
    }
    if (operation.state === "failed" && operation.response_status !== 409) {
      throwIfInsufficient(operation);
      return {
        operation,
        status: responseStatus(operation),
        body: parseResponse(operation),
        replay: true,
      };
    }
  }

  const nativeObject = await resolveNativeStorageObject(
    input.bucket,
    input.organizationId,
    input.logicalKey,
  );
  if (!nativeObject?.provider_key || nativeObject.deleted_at) {
    return await failPrepared(operation, 404, { error: "Object not found" });
  }
  const observed = await input.bucket.head?.(nativeObject.provider_key);
  if (
    !observed ||
    observed.etag !== nativeObject.etag ||
    observed.size !== Number(nativeObject.size_bytes)
  ) {
    throw new NativeStorageReadError(
      "PROVIDER_INTEGRITY",
      "The cataloged storage generation is unavailable",
    );
  }
  if (!operation.capability_id || !operation.capability_expires_at) {
    throw new NativeStorageReadError("RECEIPT_CORRUPT", "Capability receipt is incomplete");
  }
  const body = {
    expiresAt: operation.capability_expires_at.toISOString(),
    receiptId: operation.id,
  };
  operation = await orgStorageReadsRepository.recordProviderSuccess({
    operationId: operation.id,
    organizationId: input.organizationId,
    objectId: nativeObject.id,
    objectGeneration: nativeObject.generation,
    providerKey: nativeObject.provider_key,
    resultSizeBytes: nativeObject.size_bytes,
    resultContentType: nativeObject.content_type ?? undefined,
    resultEtag: nativeObject.etag ?? undefined,
    responseStatus: 200,
    responseJson: JSON.stringify(body),
    providerSucceededAt: new Date(),
  });
  operation = await settlePresign(operation, new Date());
  if (operation.state === "failed" && operation.response_status === 409) {
    return await executeNativeStoragePresign(input);
  }
  return { operation, status: 200, body, replay: prepared.replay };
}

export async function authorizeNativeStorageCapability(input: {
  capabilityId: string;
  capabilityHost: string;
  now: Date;
}): Promise<OrgStorageReadOperation | undefined> {
  return await orgStorageReadsRepository.authorizeCapability(input);
}

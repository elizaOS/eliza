/**
 * Failure-injects the native storage-read orchestrator to prove provider
 * success precedes settlement and terminal retries reopen exact generations.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OrgStorageReadOperation } from "../../../db/schemas/org-storage-reads";

const ORG = "00000000-0000-4000-8000-000000021045";
const USER = "00000000-0000-4000-8000-000000021046";
const OP = "00000000-0000-4000-8000-000000021047";
const OBJECT = "00000000-0000-4000-8000-000000021048";
const PROVIDER_KEY = "__eliza_storage_authority/v2/opaque-generation";
const events: string[] = [];

const findByIdempotency = mock();
const findLatestPresignRenewal = mock();
const prepare = mock();
const preparePresignRenewal = mock();
const recordProviderSuccess = mock();
const recordFailure = mock();
const expirePresignProviderSuccess = mock();
const commitProviderSuccess = mock();
const authorizeCapability = mock();
const resolveNativeStorageObject = mock();
const ensureNativeStorageQuotaReconciled = mock();
const listObjects = mock();

class TestStorageReadConflictError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

mock.module("../../../db/repositories/org-storage-reads", () => ({
  orgStorageReadsRepository: {
    findByIdempotency,
    findLatestPresignRenewal,
    prepare,
    preparePresignRenewal,
    recordProviderSuccess,
    recordFailure,
    expirePresignProviderSuccess,
    commitProviderSuccess,
    authorizeCapability,
  },
  StorageReadConflictError: TestStorageReadConflictError,
}));
mock.module("../../../db/repositories/org-storage-mutations", () => ({
  orgStorageMutationsRepository: { listObjects },
}));
mock.module("./native-storage-put", () => ({
  resolveNativeStorageObject,
  ensureNativeStorageQuotaReconciled,
}));

const { executeNativeStorageGetOrHead, executeNativeStoragePresign, NativeStorageReadError } =
  await import("./native-storage-read");

function operation(state: OrgStorageReadOperation["state"]): OrgStorageReadOperation {
  const terminal = state === "committed";
  return {
    id: OP,
    organization_id: ORG,
    user_id: USER,
    object_id: state === "prepared" ? null : OBJECT,
    idempotency_key_hash: "a".repeat(64),
    request_digest: "b".repeat(64),
    renewal_root_id: null,
    renewal_generation: 0,
    method: "get",
    state,
    price_usd: "0.100000",
    object_generation: state === "prepared" ? null : 1n,
    provider_key: state === "prepared" ? null : PROVIDER_KEY,
    result_size_bytes: state === "prepared" ? null : 5n,
    result_content_type: state === "prepared" ? null : "audio/ogg",
    result_etag: state === "prepared" ? null : "etag-1",
    response_status: state === "prepared" ? null : 200,
    response_json:
      state === "prepared"
        ? null
        : JSON.stringify({
            contentType: "audio/ogg",
            size: 5,
            etag: "etag-1",
            lastModified: "Wed, 19 Aug 2026 12:00:00 GMT",
          }),
    capability_id: null,
    capability_host: null,
    capability_issued_at: null,
    capability_expires_at: null,
    capability_revoked_at: null,
    retain_until: new Date(Date.now() + 60_000),
    credit_transaction_id: terminal ? OP : null,
    provider_succeeded_at: state === "prepared" ? null : new Date(),
    completed_at: terminal ? new Date() : null,
    access_count: 0n,
    last_access_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

beforeEach(() => {
  events.length = 0;
  for (const fn of [
    findByIdempotency,
    findLatestPresignRenewal,
    prepare,
    preparePresignRenewal,
    recordProviderSuccess,
    recordFailure,
    expirePresignProviderSuccess,
    commitProviderSuccess,
    authorizeCapability,
    resolveNativeStorageObject,
    ensureNativeStorageQuotaReconciled,
    listObjects,
  ]) {
    fn.mockReset();
  }
  findByIdempotency.mockResolvedValue(undefined);
  prepare.mockResolvedValue({ operation: operation("prepared"), replay: false });
  resolveNativeStorageObject.mockResolvedValue({
    id: OBJECT,
    generation: 1n,
    provider_key: PROVIDER_KEY,
    size_bytes: 5n,
    content_type: "audio/ogg",
    etag: "etag-1",
    uploaded_at: new Date("2026-08-19T12:00:00.000Z"),
    deleted_at: null,
  });
  recordProviderSuccess.mockImplementation(async () => {
    events.push("provider-result-recorded");
    return operation("provider_succeeded");
  });
  commitProviderSuccess.mockImplementation(async () => {
    events.push("debit-committed");
    return { operation: operation("committed"), insufficient: false };
  });
});

function presignOperation(
  generation: number,
  state: OrgStorageReadOperation["state"],
  expiresAt: Date,
): OrgStorageReadOperation {
  const value = operation(state);
  return {
    ...value,
    id:
      generation === 0
        ? OP
        : `00000000-0000-4000-8000-${String(21047 + generation).padStart(12, "0")}`,
    method: "presign",
    renewal_root_id: generation === 0 ? null : OP,
    renewal_generation: generation,
    capability_id: `00000000-0000-4000-8000-${String(22047 + generation).padStart(12, "0")}`,
    capability_host: "blob.example.test",
    capability_issued_at: new Date(expiresAt.getTime() - 60_000),
    capability_expires_at: expiresAt,
    retain_until: expiresAt,
    response_json:
      state === "prepared"
        ? null
        : JSON.stringify({ expiresAt: expiresAt.toISOString(), receiptId: value.id }),
  };
}

describe("executeNativeStorageGetOrHead", () => {
  test("records provider success before the one atomic debit", async () => {
    const bucket = {
      get: mock(async () => {
        events.push("provider-read");
        return { body: new TextEncoder().encode("asset"), size: 5, etag: "etag-1" };
      }),
    };
    const result = await executeNativeStorageGetOrHead({
      bucket,
      organizationId: ORG,
      userId: USER,
      logicalKey: "private/voice.ogg",
      rawIdempotencyKey: "get-1",
      priceUsd: 0.1,
      method: "get",
    });
    expect(result.status).toBe(200);
    expect(events).toEqual(["provider-read", "provider-result-recorded", "debit-committed"]);
  });

  test("does not debit when exact provider integrity fails", async () => {
    const bucket = { get: mock(async () => null) };
    await expect(
      executeNativeStorageGetOrHead({
        bucket,
        organizationId: ORG,
        userId: USER,
        logicalKey: "private/voice.ogg",
        rawIdempotencyKey: "get-2",
        priceUsd: 0.1,
        method: "get",
      }),
    ).rejects.toBeInstanceOf(NativeStorageReadError);
    expect(recordProviderSuccess).not.toHaveBeenCalled();
    expect(commitProviderSuccess).not.toHaveBeenCalled();
  });

  test("replays a committed receipt from its exact generation without rediscovery or debit", async () => {
    const receipt = operation("committed");
    const digestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          "native-storage-read:v2",
          ORG,
          USER,
          "get",
          { logicalKey: "private/voice.ogg" },
          "0.100000",
        ]),
      ),
    );
    receipt.request_digest = Array.from(new Uint8Array(digestBytes), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    findByIdempotency.mockResolvedValue(receipt);
    const bucket = {
      get: mock(async () => ({
        body: new TextEncoder().encode("asset"),
        size: 5,
        etag: "etag-1",
      })),
    };
    const result = await executeNativeStorageGetOrHead({
      bucket,
      organizationId: ORG,
      userId: USER,
      logicalKey: "private/voice.ogg",
      rawIdempotencyKey: "get-1",
      priceUsd: 99,
      method: "get",
    });
    expect(result.replay).toBe(true);
    expect(bucket.get).toHaveBeenCalledWith(PROVIDER_KEY, {
      onlyIf: { etagMatches: "etag-1" },
    });
    expect(resolveNativeStorageObject).not.toHaveBeenCalled();
    expect(commitProviderSuccess).not.toHaveBeenCalled();
  });
});

describe("executeNativeStoragePresign", () => {
  test("renews when the locked settlement fence expires a preflight-valid provider result", async () => {
    const future = new Date(Date.now() + 300_000);
    const root = presignOperation(0, "provider_succeeded", future);
    const digestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          "native-storage-read:v2",
          ORG,
          USER,
          "presign",
          {
            logicalKey: "private/voice.ogg",
            ttlSeconds: 300,
            capabilityHost: "blob.example.test",
          },
          "0.100000",
        ]),
      ),
    );
    root.request_digest = Array.from(new Uint8Array(digestBytes), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const expiredFence = {
      ...root,
      state: "failed" as const,
      response_status: 409,
      response_json: JSON.stringify({ error: "Capability expired before settlement" }),
      completed_at: new Date(),
    };
    const childPrepared = presignOperation(1, "prepared", new Date(Date.now() + 300_000));
    const childSucceeded = { ...childPrepared, state: "provider_succeeded" as const };
    const childCommitted = { ...childSucceeded, state: "committed" as const };
    childCommitted.response_status = 200;
    childCommitted.response_json = JSON.stringify({
      expiresAt: childCommitted.capability_expires_at!.toISOString(),
      receiptId: childCommitted.id,
    });
    findByIdempotency.mockResolvedValue(root);
    findLatestPresignRenewal.mockResolvedValue(expiredFence);
    preparePresignRenewal.mockResolvedValue({ operation: childPrepared, created: true });
    recordProviderSuccess.mockResolvedValue(childSucceeded);
    commitProviderSuccess
      .mockResolvedValueOnce({ operation: expiredFence, insufficient: false })
      .mockResolvedValueOnce({ operation: childCommitted, insufficient: false });

    const result = await executeNativeStoragePresign({
      bucket: { head: mock(async () => ({ size: 5, etag: "etag-1" })) },
      organizationId: ORG,
      userId: USER,
      logicalKey: "private/voice.ogg",
      rawIdempotencyKey: "settlement-delay-presign",
      priceUsd: 0.1,
      capabilityHost: "blob.example.test",
      ttlSeconds: 300,
    });

    expect(result.operation).toMatchObject({ state: "committed", renewal_generation: 1 });
    expect(commitProviderSuccess).toHaveBeenCalledTimes(2);
    expect(preparePresignRenewal).toHaveBeenCalledTimes(1);
  });

  test("renews an expired stable root through one durable child before disclosure", async () => {
    const expired = new Date(Date.now() - 60_000);
    const root = presignOperation(0, "committed", expired);
    const digestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          "native-storage-read:v2",
          ORG,
          USER,
          "presign",
          {
            logicalKey: "private/voice.ogg",
            ttlSeconds: 300,
            capabilityHost: "blob.example.test",
          },
          "0.100000",
        ]),
      ),
    );
    root.request_digest = Array.from(new Uint8Array(digestBytes), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const childPrepared = presignOperation(1, "prepared", new Date(Date.now() + 300_000));
    const childSucceeded = { ...childPrepared, state: "provider_succeeded" as const };
    const childCommitted = { ...childSucceeded, state: "committed" as const };
    childCommitted.response_status = 200;
    childCommitted.response_json = JSON.stringify({
      expiresAt: childCommitted.capability_expires_at!.toISOString(),
      receiptId: childCommitted.id,
    });
    findByIdempotency.mockResolvedValue(root);
    findLatestPresignRenewal.mockResolvedValue(root);
    preparePresignRenewal.mockResolvedValue({ operation: childPrepared, created: true });
    recordProviderSuccess.mockResolvedValue(childSucceeded);
    commitProviderSuccess.mockResolvedValue({
      operation: childCommitted,
      insufficient: false,
    });
    const bucket = { head: mock(async () => ({ size: 5, etag: "etag-1" })) };
    const result = await executeNativeStoragePresign({
      bucket,
      organizationId: ORG,
      userId: USER,
      logicalKey: "private/voice.ogg",
      rawIdempotencyKey: "stable-presign",
      priceUsd: 0.25,
      capabilityHost: "blob.example.test",
      ttlSeconds: 300,
    });
    expect(result.operation).toMatchObject({
      id: childCommitted.id,
      renewal_generation: 1,
      state: "committed",
    });
    expect(preparePresignRenewal).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });
});

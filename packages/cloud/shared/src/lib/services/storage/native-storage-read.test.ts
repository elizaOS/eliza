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
const prepare = mock();
const recordProviderSuccess = mock();
const recordFailure = mock();
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
    prepare,
    recordProviderSuccess,
    recordFailure,
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

const { executeNativeStorageGetOrHead, NativeStorageReadError } = await import(
  "./native-storage-read"
);

function operation(state: OrgStorageReadOperation["state"]): OrgStorageReadOperation {
  const terminal = state === "committed";
  return {
    id: OP,
    organization_id: ORG,
    user_id: USER,
    object_id: state === "prepared" ? null : OBJECT,
    idempotency_key_hash: "a".repeat(64),
    request_digest: "b".repeat(64),
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
    prepare,
    recordProviderSuccess,
    recordFailure,
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

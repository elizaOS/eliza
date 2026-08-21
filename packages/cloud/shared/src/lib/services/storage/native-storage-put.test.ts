/**
 * Failure-injects native storage mutation and quota-reconciliation boundaries
 * with a fake strongly consistent R2 binding, including pagination ownership.
 */
import { beforeEach, describe, expect, jest, mock, test } from "bun:test";
import type { OrgStoragePutOperation } from "../../../db/schemas/org-storage-mutations";
import type { RuntimeR2Bucket, RuntimeR2ObjectMetadata } from "../../storage/r2-runtime-binding";

const ORG = "00000000-0000-4000-8000-000000021045";
const OP = "00000000-0000-4000-8000-000000021046";
const OBJECT = "00000000-0000-4000-8000-000000021047";
const PROVIDER_KEY = `__eliza_storage_authority/v2/org/${ORG}/${OBJECT}/1`;

const preparePut = mock();
const reservePutCredits = mock();
const claimProviderLease = mock();
const claimReconciliationLease = mock();
const deferProviderAbsence = mock();
const commitObservedPut = mock();
const finalizeRefund = mock();
const findObject = mock();
const adoptLegacyObject = mock();
const adoptLegacyObjects = mock();
const quotaNeedsNativeCatalogReconciliation = mock();
const reconcileNativeQuotaFromCatalog = mock();
const listDueOperations = mock();
const listDueGc = mock();
const completeGc = mock();
const prepareDelete = mock();
const claimDeleteLease = mock();
const commitObservedDelete = mock();
const listDueDeletes = mock();
const revokeCapabilitiesForObject = mock();
const loggerWarn = mock();

class TestInsufficientCreditsError extends Error {}
class TestStoragePutConflictError extends Error {}

mock.module("../../../db/repositories/org-storage-mutations", () => ({
  orgStorageMutationsRepository: {
    preparePut,
    reservePutCredits,
    claimProviderLease,
    claimReconciliationLease,
    deferProviderAbsence,
    commitObservedPut,
    finalizeRefund,
    findObject,
    adoptLegacyObject,
    adoptLegacyObjects,
    quotaNeedsNativeCatalogReconciliation,
    reconcileNativeQuotaFromCatalog,
    listDueOperations,
    listDueGc,
    completeGc,
    prepareDelete,
    claimDeleteLease,
    commitObservedDelete,
    listDueDeletes,
  },
  StoragePutConflictError: TestStoragePutConflictError,
}));
mock.module("../../../db/repositories/org-storage-reads", () => ({
  orgStorageReadsRepository: { revokeCapabilitiesForObject },
}));
mock.module("../credits", () => ({ InsufficientCreditsError: TestInsufficientCreditsError }));
mock.module("../../utils/logger", () => ({ logger: { warn: loggerWarn } }));

const {
  calculateStoragePutPrice,
  ensureNativeStorageQuotaReconciled,
  executeNativeStorageDelete,
  executeNativeStoragePut,
  reconcileNativeStoragePuts,
  resolveNativeStorageObject,
} = await import("./native-storage-put");

function operation(state: OrgStoragePutOperation["state"], price = "1.000000") {
  return {
    id: OP,
    organization_id: ORG,
    object_id: OBJECT,
    idempotency_key_hash: "a".repeat(64),
    request_digest: "b".repeat(64),
    state,
    source_generation: 0n,
    source_provider_key: null,
    source_size_bytes: 0n,
    target_generation: 1n,
    target_provider_key: PROVIDER_KEY,
    target_size_bytes: 7n,
    target_content_type: "text/plain",
    target_content_sha256: "c".repeat(64),
    quota_reserved_bytes: 7n,
    price_usd: price,
    credit_transaction_id: state === "prepared" || price === "0.000000" ? null : OP,
    lease_token: state === "provider_started" || state === "reconciling" ? OBJECT : null,
    lease_expires_at:
      state === "provider_started" || state === "reconciling" ? new Date(Date.now() - 1) : null,
    provider_absence_observed_at: null,
    result_etag: state === "committed" ? "etag-1" : null,
    result_uploaded_at: state === "committed" ? new Date() : null,
    response_json:
      state === "committed"
        ? "{}"
        : state === "refunded"
          ? JSON.stringify({ error: "Insufficient credits" })
          : null,
    completed_at: state === "committed" || state === "refunded" ? new Date() : null,
    created_at: new Date(Date.now() - 60_000),
    updated_at: new Date(),
  } satisfies OrgStoragePutOperation;
}

function fakeR2(throwAfterCommit: { value: boolean }): RuntimeR2Bucket {
  const objects = new Map<string, RuntimeR2ObjectMetadata>();
  return {
    get: mock(async () => null),
    head: mock(async (key: string) => objects.get(key) ?? null),
    put: mock(async (key, value, options) => {
      const size = value instanceof ArrayBuffer ? value.byteLength : 0;
      objects.set(key, {
        size,
        etag: "etag-1",
        uploaded: new Date(),
        customMetadata: options?.customMetadata,
      });
      if (throwAfterCommit.value) {
        throwAfterCommit.value = false;
        throw new Error("simulated commit-then-ack-loss");
      }
      return null;
    }),
    delete: mock(async () => undefined),
  };
}

beforeEach(() => {
  for (const fn of [
    preparePut,
    reservePutCredits,
    claimProviderLease,
    claimReconciliationLease,
    deferProviderAbsence,
    commitObservedPut,
    finalizeRefund,
    findObject,
    adoptLegacyObject,
    adoptLegacyObjects,
    quotaNeedsNativeCatalogReconciliation,
    reconcileNativeQuotaFromCatalog,
    listDueOperations,
    listDueGc,
    completeGc,
    prepareDelete,
    claimDeleteLease,
    commitObservedDelete,
    listDueDeletes,
    revokeCapabilitiesForObject,
    loggerWarn,
  ]) {
    fn.mockReset();
  }
  listDueOperations.mockResolvedValue([]);
  listDueGc.mockResolvedValue([]);
  listDueDeletes.mockResolvedValue([]);
  revokeCapabilitiesForObject.mockResolvedValue(0);
  quotaNeedsNativeCatalogReconciliation.mockResolvedValue(false);
  reservePutCredits.mockImplementation(async () => ({
    operation: operation("reserved"),
    insufficient: false,
    available: 9,
  }));
  findObject.mockResolvedValue(undefined);
});

describe("executeNativeStoragePut", () => {
  test("fully adopts legacy inventory before repairing a corrupted quota baseline", async () => {
    quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
    const bucket = fakeR2({ value: false });
    bucket.list = mock()
      .mockResolvedValueOnce({
        objects: [
          {
            key: `org/${ORG}/first.bin`,
            size: 3,
            etag: "first-etag",
            uploaded: new Date("2026-08-18T00:00:00.000Z"),
          },
        ],
        truncated: true,
        cursor: "next",
      })
      .mockResolvedValueOnce({
        objects: [
          {
            key: `org/${ORG}/second.bin`,
            size: 4,
            etag: "second-etag",
            uploaded: new Date("2026-08-18T00:01:00.000Z"),
          },
        ],
        truncated: false,
      });

    await ensureNativeStorageQuotaReconciled(bucket, ORG);

    expect(adoptLegacyObjects).toHaveBeenCalledTimes(2);
    expect(reconcileNativeQuotaFromCatalog).toHaveBeenCalledWith(ORG);
  });

  test("throws instead of looping forever when R2 repeats a page cursor", async () => {
    quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
    const bucket = fakeR2({ value: false });
    bucket.list = mock().mockResolvedValue({
      objects: [],
      truncated: true,
      cursor: "stuck",
    });

    await expect(ensureNativeStorageQuotaReconciled(bucket, ORG)).rejects.toMatchObject({
      code: "PROVIDER_INTEGRITY",
    });
    // Stopped after the repeat was detected, not after a third page.
    expect(bucket.list).toHaveBeenCalledTimes(2);
    // The repeated page is rejected before its contents can mutate the catalog.
    expect(adoptLegacyObjects).toHaveBeenCalledTimes(1);
  });

  test("does not reject a valid catalog because it spans more than 1000 pages", async () => {
    quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
    const bucket = fakeR2({ value: false });
    let page = 0;
    bucket.list = mock().mockImplementation(async () => {
      page += 1;
      return page === 1_001
        ? { objects: [], truncated: false }
        : { objects: [], truncated: true, cursor: `cursor-${page}` };
    });

    await expect(ensureNativeStorageQuotaReconciled(bucket, ORG)).resolves.toBeUndefined();
    expect(bucket.list).toHaveBeenCalledTimes(1_001);
    expect(adoptLegacyObjects).toHaveBeenCalledTimes(1_001);
    expect(reconcileNativeQuotaFromCatalog).toHaveBeenCalledWith(ORG);
  });

  test("accepts a large final R2 page sequence and replacement terminal state", async () => {
    quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
    const bucket = fakeR2({ value: false });
    let page = 0;
    bucket.list = mock().mockImplementation(async () => {
      page += 1;
      return page === 1_000
        ? { objects: [], truncated: false }
        : { objects: [], truncated: true, cursor: `cursor-${page}` };
    });

    await expect(ensureNativeStorageQuotaReconciled(bucket, ORG)).resolves.toBeUndefined();
    expect(bucket.list).toHaveBeenCalledTimes(1_000);
    expect(adoptLegacyObjects).toHaveBeenCalledTimes(1_000);
    expect(reconcileNativeQuotaFromCatalog).toHaveBeenCalledWith(ORG);
  });

  test("rejects an oversized provider page before catalog or quota mutation", async () => {
    quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
    const bucket = fakeR2({ value: false });
    bucket.list = mock().mockResolvedValue({
      objects: Array.from({ length: 1_001 }, (_, index) => ({
        key: `org/${ORG}/${index}.bin`,
        size: 1,
        etag: `etag-${index}`,
      })),
      truncated: false,
    });

    await expect(ensureNativeStorageQuotaReconciled(bucket, ORG)).rejects.toMatchObject({
      code: "PROVIDER_INTEGRITY",
    });
    expect(adoptLegacyObjects).not.toHaveBeenCalled();
    expect(reconcileNativeQuotaFromCatalog).not.toHaveBeenCalled();
  });

  test("rejects malformed runtime R2 metadata before catalog mutation", async () => {
    quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
    const bucket = fakeR2({ value: false });
    bucket.list = mock().mockResolvedValue({
      objects: [{ key: 7, size: 1, etag: "etag" }],
      truncated: false,
    });

    await expect(ensureNativeStorageQuotaReconciled(bucket, ORG)).rejects.toMatchObject({
      code: "PROVIDER_INTEGRITY",
    });
    expect(adoptLegacyObjects).not.toHaveBeenCalled();
    expect(reconcileNativeQuotaFromCatalog).not.toHaveBeenCalled();
  });

  test("rejects a malformed cursor on a terminal page before catalog mutation", async () => {
    quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
    const bucket = fakeR2({ value: false });
    bucket.list = mock().mockResolvedValue({
      objects: [{ key: `org/${ORG}/valid.bin`, size: 1, etag: "etag" }],
      truncated: false,
      cursor: 7,
    });

    await expect(ensureNativeStorageQuotaReconciled(bucket, ORG)).rejects.toMatchObject({
      code: "PROVIDER_INTEGRITY",
    });
    expect(adoptLegacyObjects).not.toHaveBeenCalled();
    expect(reconcileNativeQuotaFromCatalog).not.toHaveBeenCalled();
  });

  test("rejects a sparse provider page before catalog mutation", async () => {
    quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
    const bucket = fakeR2({ value: false });
    bucket.list = mock().mockResolvedValue({
      objects: new Array(1),
      truncated: false,
    });

    await expect(ensureNativeStorageQuotaReconciled(bucket, ORG)).rejects.toMatchObject({
      code: "PROVIDER_INTEGRITY",
    });
    expect(adoptLegacyObjects).not.toHaveBeenCalled();
    expect(reconcileNativeQuotaFromCatalog).not.toHaveBeenCalled();
  });

  test("preserves an opaque large cursor while retaining fixed-size cycle state", async () => {
    quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
    const bucket = fakeR2({ value: false });
    const opaqueCursor = "x".repeat(64 * 1_024);
    bucket.list = mock()
      .mockResolvedValueOnce({ objects: [], truncated: true, cursor: opaqueCursor })
      .mockResolvedValueOnce({ objects: [], truncated: false });

    await expect(ensureNativeStorageQuotaReconciled(bucket, ORG)).resolves.toBeUndefined();
    expect(bucket.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: opaqueCursor }),
    );
    expect(reconcileNativeQuotaFromCatalog).toHaveBeenCalledWith(ORG);
  });

  test("times out a stalled R2 LIST without mutating catalog state", async () => {
    jest.useFakeTimers();
    try {
      quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
      const bucket = fakeR2({ value: false });
      bucket.list = mock().mockImplementation(
        async () =>
          await new Promise<never>(() => {
            // Intentionally never settles.
          }),
      );

      const reconciliation = ensureNativeStorageQuotaReconciled(bucket, ORG);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(10_000);

      await expect(reconciliation).rejects.toMatchObject({ code: "PROVIDER_INTEGRITY" });
      expect(adoptLegacyObjects).not.toHaveBeenCalled();
      expect(reconcileNativeQuotaFromCatalog).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test("coalesces concurrent reconciliation and permits a clean retry after failure", async () => {
    quotaNeedsNativeCatalogReconciliation.mockResolvedValue(true);
    const bucket = fakeR2({ value: false });
    let releaseList: (() => void) | undefined;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    bucket.list = mock().mockImplementation(async () => {
      await listGate;
      return { objects: [], truncated: false };
    });

    const first = ensureNativeStorageQuotaReconciled(bucket, ORG);
    const joined = ensureNativeStorageQuotaReconciled(bucket, ORG);
    await Promise.resolve();
    expect(quotaNeedsNativeCatalogReconciliation).toHaveBeenCalledTimes(1);
    expect(bucket.list).toHaveBeenCalledTimes(1);
    releaseList?.();
    await Promise.all([first, joined]);
    expect(reconcileNativeQuotaFromCatalog).toHaveBeenCalledTimes(1);

    quotaNeedsNativeCatalogReconciliation.mockResolvedValueOnce(true);
    bucket.list = mock().mockResolvedValueOnce({
      objects: [],
      truncated: true,
      cursor: "",
    });
    await expect(ensureNativeStorageQuotaReconciled(bucket, ORG)).rejects.toMatchObject({
      code: "PROVIDER_INTEGRITY",
    });
    bucket.list = mock().mockResolvedValueOnce({ objects: [], truncated: false });
    await expect(ensureNativeStorageQuotaReconciled(bucket, ORG)).resolves.toBeUndefined();
    expect(quotaNeedsNativeCatalogReconciliation).toHaveBeenCalledTimes(3);
  });

  test("adopts a legacy logical key from strong native HEAD without moving bytes", async () => {
    const bucket = fakeR2({ value: false });
    const legacyKey = `org/${ORG}/legacy/voice.ogg`;
    bucket.head = mock(async (key: string) =>
      key === legacyKey
        ? {
            size: 7,
            etag: "legacy-etag",
            uploaded: new Date("2026-08-18T00:00:00.000Z"),
            httpMetadata: { contentType: "audio/ogg" },
          }
        : null,
    );
    const adopted = {
      generation: 0n,
      provider_key: legacyKey,
      size_bytes: 7n,
      content_type: "audio/ogg",
    };
    adoptLegacyObject.mockResolvedValue(adopted);
    expect(await resolveNativeStorageObject(bucket, ORG, "legacy/voice.ogg")).toBe(adopted);
    expect(adoptLegacyObject).toHaveBeenCalledWith({
      organizationId: ORG,
      logicalKey: "legacy/voice.ogg",
      providerKey: legacyKey,
      sizeBytes: 7n,
      contentType: "audio/ogg",
      etag: "legacy-etag",
      uploadedAt: new Date("2026-08-18T00:00:00.000Z"),
    });
  });

  test("preserves the authoritative per-byte rate while rounding to ledger precision", () => {
    expect(calculateStoragePutPrice(0.0001, 0.000000001, 1)).toBe(0.0001);
    expect(calculateStoragePutPrice(0.0001, 0.000000001, 50_000_000)).toBe(0.0501);
    expect(calculateStoragePutPrice(0.0000004, 0.0000004, 1)).toBe(0.000001);
  });

  test("keeps the hold on commit-then-ack-loss and reconciles by immutable-key HEAD", async () => {
    let current = operation("prepared");
    preparePut.mockImplementation(async () => ({
      operation: current,
      replay: current.state !== "prepared",
    }));
    reservePutCredits.mockImplementation(async () => {
      current = operation("reserved");
      return { operation: current, insufficient: false, available: 9 };
    });
    claimProviderLease.mockImplementation(async () => {
      current = operation("provider_started");
      return current;
    });
    commitObservedPut.mockImplementation(async () => {
      current = operation("committed");
      return current;
    });
    const bucket = fakeR2({ value: true });
    const input = {
      bucket,
      organizationId: ORG,
      logicalKey: "private/voice.txt",
      idempotencyKey: "request-1",
      body: new TextEncoder().encode("payload").buffer,
      contentType: "text/plain",
      priceUsd: 1,
    };

    await expect(executeNativeStoragePut(input)).rejects.toThrow("commit-then-ack-loss");
    expect(finalizeRefund).not.toHaveBeenCalled();
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(bucket.put).toHaveBeenCalledWith(
      PROVIDER_KEY,
      input.body,
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: "*" } }),
    );

    const response = await executeNativeStoragePut(input);
    expect(response).toEqual({
      key: input.logicalKey,
      size: 7,
      contentType: "text/plain",
      etag: "etag-1",
    });
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(commitObservedPut).toHaveBeenCalledTimes(1);
    expect(finalizeRefund).not.toHaveBeenCalled();
  });

  test("persists a zero-cost terminal receipt without creating a credit transaction", async () => {
    let current = operation("prepared", "0.000000");
    preparePut.mockResolvedValue({ operation: current, replay: false });
    reservePutCredits.mockImplementation(async () => {
      current = operation("reserved", "0.000000");
      return { operation: current, insufficient: false, available: 0 };
    });
    claimProviderLease.mockImplementation(async () => {
      current = operation("provider_started", "0.000000");
      return current;
    });
    commitObservedPut.mockImplementation(async () => operation("committed", "0.000000"));
    const bucket = fakeR2({ value: false });

    const response = await executeNativeStoragePut({
      bucket,
      organizationId: ORG,
      logicalKey: "zero-cost.txt",
      idempotencyKey: "zero-1",
      body: new TextEncoder().encode("payload").buffer,
      contentType: "text/plain",
      priceUsd: 0,
    });
    expect(response.etag).toBe("etag-1");
    expect(reservePutCredits).toHaveBeenCalledTimes(1);
    expect(commitObservedPut).toHaveBeenCalledTimes(1);
  });

  test("stops before provider dispatch when atomic storage credit reservation is terminal", async () => {
    preparePut.mockResolvedValue({ operation: operation("prepared"), replay: false });
    reservePutCredits.mockResolvedValue({
      operation: operation("refunded"),
      insufficient: true,
      available: 0.25,
    });
    const bucket = fakeR2({ value: false });
    await expect(
      executeNativeStoragePut({
        bucket,
        organizationId: ORG,
        logicalKey: "insufficient.txt",
        idempotencyKey: "insufficient-1",
        body: new TextEncoder().encode("payload").buffer,
        contentType: "text/plain",
        priceUsd: 1,
      }),
    ).rejects.toBeInstanceOf(TestInsufficientCreditsError);
    expect(bucket.put).not.toHaveBeenCalled();

    preparePut.mockResolvedValue({ operation: operation("refunded"), replay: true });
    await expect(
      executeNativeStoragePut({
        bucket,
        organizationId: ORG,
        logicalKey: "insufficient.txt",
        idempotencyKey: "insufficient-1",
        body: new TextEncoder().encode("payload").buffer,
        contentType: "text/plain",
        priceUsd: 1,
      }),
    ).rejects.toBeInstanceOf(TestInsufficientCreditsError);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  test("quarantines a negative HEAD while the original provider PUT remains unresolved", async () => {
    let current = operation("prepared");
    let releasePut: (() => void) | undefined;
    let markPutStarted: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let observed: RuntimeR2ObjectMetadata | null = null;
    const bucket: RuntimeR2Bucket = {
      get: mock(async () => null),
      head: mock(async () => observed),
      list: mock(async () => ({ objects: [], truncated: false })),
      put: mock(async (_key, value, options) => {
        markPutStarted?.();
        await putGate;
        observed = {
          size: value instanceof ArrayBuffer ? value.byteLength : 0,
          etag: "late-etag",
          customMetadata: options?.customMetadata,
        };
      }),
      delete: mock(async () => undefined),
    };
    preparePut.mockImplementation(async () => ({ operation: current, replay: false }));
    reservePutCredits.mockImplementation(async () => {
      current = operation("reserved");
      return { operation: current, insufficient: false, available: 9 };
    });
    claimProviderLease.mockImplementation(async () => {
      current = operation("provider_started");
      return current;
    });
    claimReconciliationLease.mockImplementation(async (input: { leaseToken: string }) => {
      current = {
        ...current,
        lease_token: input.leaseToken,
        lease_expires_at: new Date(Date.now() + 60_000),
      };
      return current;
    });
    deferProviderAbsence.mockImplementation(
      async (input: { observedAt: Date; recheckAt: Date }) => {
        current = {
          ...current,
          state: "reconciling",
          provider_absence_observed_at: input.observedAt,
          lease_expires_at: input.recheckAt,
        };
        return current;
      },
    );
    commitObservedPut.mockImplementation(async (input: { leaseToken: string }) => {
      if (input.leaseToken !== current.lease_token) throw new TestStoragePutConflictError();
      current = operation("committed");
      return current;
    });
    listDueOperations.mockImplementation(async () => [current]);

    const request = executeNativeStoragePut({
      bucket,
      organizationId: ORG,
      logicalKey: "late-provider.txt",
      idempotencyKey: "late-provider-1",
      body: new TextEncoder().encode("payload").buffer,
      contentType: "text/plain",
      priceUsd: 1,
    });
    await putStarted;

    const firstRecovery = await reconcileNativeStoragePuts(bucket);
    expect(firstRecovery.refunded).toBe(0);
    expect(deferProviderAbsence).toHaveBeenCalledTimes(1);
    expect(finalizeRefund).not.toHaveBeenCalled();

    releasePut?.();
    await expect(request).rejects.toBeInstanceOf(TestStoragePutConflictError);
    current.lease_expires_at = new Date(Date.now() - 1);
    const secondRecovery = await reconcileNativeStoragePuts(bucket);
    expect(secondRecovery.committed).toBe(1);
    expect(finalizeRefund).not.toHaveBeenCalled();
  });

  test("replays a concurrent commit observed while waiting on atomic credit reservation", async () => {
    preparePut.mockResolvedValue({ operation: operation("prepared"), replay: false });
    reservePutCredits.mockResolvedValue({
      operation: operation("committed"),
      insufficient: false,
      available: 9,
    });
    const bucket = fakeR2({ value: false });
    const response = await executeNativeStoragePut({
      bucket,
      organizationId: ORG,
      logicalKey: "concurrent.txt",
      idempotencyKey: "concurrent-1",
      body: new TextEncoder().encode("payload").buffer,
      contentType: "text/plain",
      priceUsd: 1,
    });
    expect(response.etag).toBe("etag-1");
    expect(bucket.put).not.toHaveBeenCalled();
    expect(claimProviderLease).not.toHaveBeenCalled();
  });

  test("replays a terminal provider-absence refund as the original service failure", async () => {
    const refunded = operation("refunded");
    refunded.response_json = JSON.stringify({ error: "Storage PUT did not reach R2" });
    preparePut.mockResolvedValue({ operation: refunded, replay: true });
    const bucket = fakeR2({ value: false });
    await expect(
      executeNativeStoragePut({
        bucket,
        organizationId: ORG,
        logicalKey: "refunded.txt",
        idempotencyKey: "refunded-1",
        body: new TextEncoder().encode("payload").buffer,
        contentType: "text/plain",
        priceUsd: 1,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_AMBIGUOUS",
      message: "Storage PUT did not reach R2",
    });
    expect(bucket.put).not.toHaveBeenCalled();
  });

  test("replays an ambiguous native delete without releasing authority early", async () => {
    let state: "prepared" | "provider_started" | "committed" = "prepared";
    const deleteOperation = () => ({
      id: OP,
      organization_id: ORG,
      object_id: OBJECT,
      idempotency_key_hash: "d".repeat(64),
      request_digest: "e".repeat(64),
      state,
      source_generation: 1n,
      source_provider_key: PROVIDER_KEY,
      source_size_bytes: 7n,
      lease_token: state === "provider_started" ? OBJECT : null,
      lease_expires_at: state === "provider_started" ? new Date(Date.now() - 1) : null,
      response_json: state === "committed" ? "{}" : null,
      completed_at: state === "committed" ? new Date() : null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    prepareDelete.mockImplementation(async () => ({
      operation: deleteOperation(),
      replay: state !== "prepared",
    }));
    claimDeleteLease.mockImplementation(async () => {
      state = "provider_started";
      return deleteOperation();
    });
    commitObservedDelete.mockImplementation(async () => {
      state = "committed";
      return deleteOperation();
    });
    let present = true;
    let loseAck = true;
    const bucket: RuntimeR2Bucket = {
      get: mock(async () => null),
      head: mock(async () => (present ? { size: 7, etag: "etag-1" } : null)),
      put: mock(async () => null),
      delete: mock(async () => {
        present = false;
        if (loseAck) {
          loseAck = false;
          throw new Error("delete commit-then-ack-loss");
        }
      }),
    };
    const input = {
      bucket,
      organizationId: ORG,
      logicalKey: "private/voice.txt",
      idempotencyKey: "delete-1",
      priceUsd: 0,
    };
    await expect(executeNativeStorageDelete(input)).rejects.toThrow("commit-then-ack-loss");
    expect(commitObservedDelete).not.toHaveBeenCalled();
    await executeNativeStorageDelete(input);
    expect(bucket.delete).toHaveBeenCalledTimes(2);
    expect(commitObservedDelete).toHaveBeenCalledTimes(1);
  });

  test("refunds an aged paid prepare that never acquired a credit hold", async () => {
    const pending = operation("prepared");
    pending.created_at = new Date(Date.now() - 11 * 60_000);
    listDueOperations.mockResolvedValue([pending]);
    claimReconciliationLease.mockResolvedValue(operation("reconciling"));
    finalizeRefund.mockResolvedValue(operation("refunded"));
    const result = await reconcileNativeStoragePuts(fakeR2({ value: false }));
    expect(result.refunded).toBe(1);
    expect(finalizeRefund).toHaveBeenCalledWith({
      operationId: OP,
      organizationId: ORG,
      leaseToken: expect.any(String),
      responseJson: JSON.stringify({ error: "Storage PUT did not reach R2" }),
    });
  });

  test("delegates orphan-hold recovery to the atomic storage refund transaction", async () => {
    const pending = operation("prepared");
    pending.created_at = new Date(Date.now() - 11 * 60_000);
    listDueOperations.mockResolvedValue([pending]);
    claimReconciliationLease.mockResolvedValue(operation("reconciling"));
    finalizeRefund.mockResolvedValue(operation("refunded"));
    await reconcileNativeStoragePuts(fakeR2({ value: false }));
    expect(reservePutCredits).not.toHaveBeenCalled();
    expect(finalizeRefund).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: OP, organizationId: ORG }),
    );
  });

  test("rejects empty and oversized content types before provider dispatch", async () => {
    const base = {
      bucket: fakeR2({ value: false }),
      organizationId: ORG,
      logicalKey: "invalid-content-type",
      idempotencyKey: "content-type-1",
      body: new TextEncoder().encode("payload").buffer,
      priceUsd: 0,
    };
    await expect(executeNativeStoragePut({ ...base, contentType: "   " })).rejects.toMatchObject({
      code: "CONTENT_TYPE_INVALID",
    });
    await expect(
      executeNativeStoragePut({ ...base, contentType: "x".repeat(256) }),
    ).rejects.toMatchObject({ code: "CONTENT_TYPE_INVALID" });
    expect(preparePut).not.toHaveBeenCalled();
    expect(base.bucket.put).not.toHaveBeenCalled();
  });

  test("streams a declared body to R2 without materializing it", async () => {
    let current = operation("prepared", "0.000000");
    let observed: RuntimeR2ObjectMetadata | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("payload"));
        controller.close();
      },
    });
    const bucket: RuntimeR2Bucket = {
      get: mock(async () => null),
      head: mock(async () => observed),
      put: mock(async (_key, value, options) => {
        expect(value).toBe(body);
        observed = {
          size: 7,
          etag: "etag-1",
          uploaded: new Date(),
          customMetadata: options?.customMetadata,
        };
      }),
      delete: mock(async () => undefined),
    };
    preparePut.mockResolvedValue({ operation: current, replay: false });
    reservePutCredits.mockImplementation(async () => {
      current = operation("reserved", "0.000000");
      return { operation: current, insufficient: false, available: 0 };
    });
    claimProviderLease.mockImplementation(async () => {
      current = operation("provider_started", "0.000000");
      return current;
    });
    commitObservedPut.mockResolvedValue(operation("committed", "0.000000"));

    await expect(
      executeNativeStoragePut({
        bucket,
        organizationId: ORG,
        logicalKey: "stream.bin",
        idempotencyKey: "stream-1",
        body,
        sizeBytes: 7,
        contentSha256: "239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5",
        contentType: "application/octet-stream",
        priceUsd: 0,
      }),
    ).resolves.toMatchObject({ size: 7, etag: "etag-1" });
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(preparePut).toHaveBeenCalledWith(
      expect.objectContaining({
        sizeBytes: 7n,
        contentSha256: "239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5",
      }),
    );
  });

  test("rejects streams without trustworthy length and digest metadata", async () => {
    const base = {
      bucket: fakeR2({ value: false }),
      organizationId: ORG,
      logicalKey: "stream.bin",
      idempotencyKey: "stream-invalid-1",
      body: new ReadableStream<Uint8Array>(),
      contentType: "application/octet-stream",
      priceUsd: 0,
    };
    await expect(executeNativeStoragePut(base)).rejects.toMatchObject({
      code: "CONTENT_LENGTH_INVALID",
    });
    await expect(executeNativeStoragePut({ ...base, sizeBytes: 7 })).rejects.toMatchObject({
      code: "CONTENT_SHA256_INVALID",
    });
    expect(preparePut).not.toHaveBeenCalled();
    expect(base.bucket.put).not.toHaveBeenCalled();
  });
});

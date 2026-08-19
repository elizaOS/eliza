/**
 * Failure-injects the native PUT orchestrator with a fake strongly consistent
 * R2 binding to prove ambiguous writes reconcile without refund or re-upload.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OrgStoragePutOperation } from "../../../db/schemas/org-storage-mutations";
import type { RuntimeR2Bucket, RuntimeR2ObjectMetadata } from "../../storage/r2-runtime-binding";

const ORG = "00000000-0000-4000-8000-000000021045";
const OP = "00000000-0000-4000-8000-000000021046";
const OBJECT = "00000000-0000-4000-8000-000000021047";
const PROVIDER_KEY = `__eliza_storage_authority/v2/org/${ORG}/${OBJECT}/1`;

const preparePut = mock();
const attachCreditReservation = mock();
const claimProviderLease = mock();
const commitObservedPut = mock();
const finalizeRefund = mock();
const listDueOperations = mock();
const listDueGc = mock();
const completeGc = mock();
const prepareDelete = mock();
const claimDeleteLease = mock();
const commitObservedDelete = mock();
const listDueDeletes = mock();
const findUnattachedCreditReservation = mock();
const reserve = mock();
const reconcile = mock();
const loggerWarn = mock();

class TestInsufficientCreditsError extends Error {}
class TestStoragePutConflictError extends Error {}

mock.module("../../../db/repositories/org-storage-mutations", () => ({
  orgStorageMutationsRepository: {
    preparePut,
    attachCreditReservation,
    claimProviderLease,
    commitObservedPut,
    finalizeRefund,
    listDueOperations,
    listDueGc,
    completeGc,
    prepareDelete,
    claimDeleteLease,
    commitObservedDelete,
    listDueDeletes,
    findUnattachedCreditReservation,
  },
  StoragePutConflictError: TestStoragePutConflictError,
}));
mock.module("../credits", () => ({
  creditsService: { reserve, reconcile },
  InsufficientCreditsError: TestInsufficientCreditsError,
}));
mock.module("../../utils/logger", () => ({ logger: { warn: loggerWarn } }));

const {
  calculateStoragePutPrice,
  executeNativeStorageDelete,
  executeNativeStoragePut,
  reconcileNativeStoragePuts,
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
    lease_token: state === "provider_started" ? OBJECT : null,
    lease_expires_at: state === "provider_started" ? new Date(Date.now() - 1) : null,
    result_etag: state === "committed" ? "etag-1" : null,
    result_uploaded_at: state === "committed" ? new Date() : null,
    response_json: state === "committed" ? "{}" : null,
    completed_at: state === "committed" ? new Date() : null,
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
    attachCreditReservation,
    claimProviderLease,
    commitObservedPut,
    finalizeRefund,
    listDueOperations,
    listDueGc,
    completeGc,
    prepareDelete,
    claimDeleteLease,
    commitObservedDelete,
    listDueDeletes,
    findUnattachedCreditReservation,
    reserve,
    reconcile,
    loggerWarn,
  ]) {
    fn.mockReset();
  }
  listDueOperations.mockResolvedValue([]);
  listDueGc.mockResolvedValue([]);
  listDueDeletes.mockResolvedValue([]);
  findUnattachedCreditReservation.mockResolvedValue(undefined);
  reserve.mockResolvedValue({ reservationTransactionId: OP });
  reconcile.mockResolvedValue({ adjustmentType: "none" });
});

describe("executeNativeStoragePut", () => {
  test("preserves the authoritative per-byte rate while rounding to ledger precision", () => {
    expect(calculateStoragePutPrice(0.0001, 0.000000001, 1)).toBe(0.000101);
    expect(calculateStoragePutPrice(0.0001, 0.000000001, 50_000_000)).toBe(0.0501);
  });

  test("keeps the hold on commit-then-ack-loss and reconciles by immutable-key HEAD", async () => {
    let current = operation("prepared");
    preparePut.mockImplementation(async () => ({
      operation: current,
      replay: current.state !== "prepared",
    }));
    attachCreditReservation.mockImplementation(async () => {
      current = operation("reserved");
      return current;
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
    expect(reconcile).not.toHaveBeenCalled();
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
    expect(reconcile).not.toHaveBeenCalled();
    expect(finalizeRefund).not.toHaveBeenCalled();
  });

  test("persists a zero-cost terminal receipt without creating a credit transaction", async () => {
    let current = operation("prepared", "0.000000");
    preparePut.mockResolvedValue({ operation: current, replay: false });
    attachCreditReservation.mockImplementation(async ({ creditTransactionId }) => {
      expect(creditTransactionId).toBeNull();
      current = operation("reserved", "0.000000");
      return current;
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
    expect(reserve).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(commitObservedPut).toHaveBeenCalledTimes(1);
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
    finalizeRefund.mockResolvedValue(operation("refunded"));
    const result = await reconcileNativeStoragePuts(fakeR2({ value: false }));
    expect(result.refunded).toBe(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(finalizeRefund).toHaveBeenCalledWith({
      operationId: OP,
      organizationId: ORG,
      responseJson: JSON.stringify({ error: "Storage PUT did not reach R2" }),
    });
  });

  test("recovers and refunds a hold created just before the operation link crashed", async () => {
    const pending = operation("prepared");
    pending.created_at = new Date(Date.now() - 11 * 60_000);
    listDueOperations.mockResolvedValue([pending]);
    findUnattachedCreditReservation.mockResolvedValue(OP);
    attachCreditReservation.mockResolvedValue(operation("reserved"));
    finalizeRefund.mockResolvedValue(operation("refunded"));
    await reconcileNativeStoragePuts(fakeR2({ value: false }));
    expect(attachCreditReservation).toHaveBeenCalledWith({
      operationId: OP,
      organizationId: ORG,
      creditTransactionId: OP,
    });
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, reservedAmount: 1, actualCost: 0 }),
    );
    expect(finalizeRefund).toHaveBeenCalledTimes(1);
  });
});

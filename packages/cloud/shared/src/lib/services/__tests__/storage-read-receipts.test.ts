/**
 * Contract tests for durable paid storage-read receipts.
 *
 * These tests keep the credit dependency hermetic while exercising the full
 * receipt state machine, including ambiguous post-commit failures and races.
 */

import { describe, expect, test } from "bun:test";
import type { CreditTransaction } from "../../../db/schemas/credit-transactions";
import type { CreditsService, DeductCreditsParams } from "../credits";
import {
  type NewPreparedStorageReadReceipt,
  type PrepareStorageReadReceiptInput,
  StorageReadReceiptConflictError,
  type StorageReadReceiptCredits,
  StorageReadReceiptInsufficientCreditsError,
  StorageReadReceiptInvalidIdempotencyKeyError,
  StorageReadReceiptService,
  StorageReadReceiptUnavailableError,
} from "../storage-read-receipts";

const ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000a1";
const OTHER_ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000a2";
const CAPABILITY_HOST = "blob.example.test";
const PRIVATE_SCOPED_KEY = `org/${ORGANIZATION_ID}/private/message.wav`;
const RAW_IDEMPOTENCY_KEY = "voice-attachment request 42";
const START_SECONDS = 2_000_000_000;

type DeductResult = Awaited<ReturnType<CreditsService["deductCredits"]>>;

function request(
  overrides: Partial<PrepareStorageReadReceiptInput> = {},
): PrepareStorageReadReceiptInput {
  return {
    rawIdempotencyKey: RAW_IDEMPOTENCY_KEY,
    organizationId: ORGANIZATION_ID,
    scopedKey: PRIVATE_SCOPED_KEY,
    ttlSeconds: 300,
    capabilityHost: CAPABILITY_HOST,
    ...overrides,
  };
}

function newReceipt(
  prepared: Awaited<ReturnType<StorageReadReceiptService["prepare"]>>,
): NewPreparedStorageReadReceipt {
  expect(prepared.status).toBe("new");
  if (prepared.status !== "new") {
    throw new Error("Expected a new receipt candidate");
  }
  return prepared;
}

class FakeCredits implements StorageReadReceiptCredits {
  readonly committed = new Map<string, CreditTransaction>();
  readonly lookups: string[] = [];
  readonly deductions: DeductCreditsParams[] = [];
  insufficient = false;
  lookupFailure: Error | undefined;
  throwBeforeCommitOnce: Error | undefined;
  throwAfterCommitOnce: Error | undefined;
  private transactionSequence = 0;

  async getCommittedTransactionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CreditTransaction | undefined> {
    this.lookups.push(idempotencyKey);
    if (this.lookupFailure) {
      throw this.lookupFailure;
    }
    return this.committed.get(idempotencyKey);
  }

  async deductCredits(params: DeductCreditsParams): Promise<DeductResult> {
    this.deductions.push(params);
    if (this.throwBeforeCommitOnce) {
      const error = this.throwBeforeCommitOnce;
      this.throwBeforeCommitOnce = undefined;
      throw error;
    }
    if (this.insufficient) {
      return {
        success: false,
        newBalance: 0,
        transaction: null,
        reason: "insufficient_balance",
      };
    }
    if (!params.stripePaymentIntentId) {
      throw new Error("Test credit dependency requires an idempotency key");
    }
    const existing = this.committed.get(params.stripePaymentIntentId);
    if (existing) {
      return { success: true, newBalance: 9, transaction: existing };
    }

    this.transactionSequence += 1;
    const transaction: CreditTransaction = {
      id: `00000000-0000-0000-0000-${this.transactionSequence.toString().padStart(12, "0")}`,
      organization_id: params.organizationId,
      user_id: null,
      amount: (-params.amount).toFixed(6),
      type: "debit",
      description: params.description,
      metadata: params.metadata ?? {},
      stripe_payment_intent_id: params.stripePaymentIntentId,
      created_at: new Date(START_SECONDS * 1000),
      settled_at: null,
    };
    this.committed.set(params.stripePaymentIntentId, transaction);
    if (this.throwAfterCommitOnce) {
      const error = this.throwAfterCommitOnce;
      this.throwAfterCommitOnce = undefined;
      throw error;
    }
    return { success: true, newBalance: 9, transaction };
  }
}

function serviceAt(fake: FakeCredits, readNow: () => number): StorageReadReceiptService {
  return new StorageReadReceiptService(fake, readNow);
}

describe("StorageReadReceiptService boundary validation", () => {
  test("the conflict error exposes only a canonical UUID for expiration", () => {
    const transactionId = "00000000-0000-0000-0000-000000000001";

    expect(
      new StorageReadReceiptConflictError("idempotency_key_reused", transactionId).transactionId,
    ).toBeUndefined();
    expect(
      new StorageReadReceiptConflictError("receipt_expired", PRIVATE_SCOPED_KEY).transactionId,
    ).toBeUndefined();
    expect(
      new StorageReadReceiptConflictError("receipt_expired", transactionId).transactionId,
    ).toBe(transactionId);
  });

  for (const [label, rawIdempotencyKey] of [
    ["missing", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
    ["leading OWS", " key"],
    ["trailing OWS", "key "],
    ["control character", "key\u001fvalue"],
    ["DEL", "key\u007fvalue"],
    ["non-ASCII", "clé"],
    ["over 128 characters", "k".repeat(129)],
  ] as const) {
    test(`rejects a ${label} Idempotency-Key before any primary read`, async () => {
      const fake = new FakeCredits();
      const service = serviceAt(fake, () => START_SECONDS);

      await expect(service.prepare(request({ rawIdempotencyKey }))).rejects.toBeInstanceOf(
        StorageReadReceiptInvalidIdempotencyKeyError,
      );
      expect(fake.lookups).toHaveLength(0);
      expect(fake.deductions).toHaveLength(0);
    });
  }

  test("accepts internal printable ASCII spaces without preserving private input", async () => {
    const fake = new FakeCredits();
    const service = serviceAt(fake, () => START_SECONDS);

    const prepared = await service.prepare(request());

    expect(prepared.status).toBe("new");
    expect(prepared.ledgerIdempotencyKey).toStartWith(`storage-presign:v1:${ORGANIZATION_ID}:`);
    expect(prepared.ledgerIdempotencyKey).not.toContain(RAW_IDEMPOTENCY_KEY);
    expect(fake.lookups).toEqual([prepared.ledgerIdempotencyKey]);
  });

  test("translates a primary lookup failure into a private unavailable error", async () => {
    const fake = new FakeCredits();
    fake.lookupFailure = new Error("private database details");
    const service = serviceAt(fake, () => START_SECONDS);

    await expect(service.prepare(request())).rejects.toBeInstanceOf(
      StorageReadReceiptUnavailableError,
    );
    expect(fake.deductions).toHaveLength(0);
  });
});

describe("StorageReadReceiptService durable charge", () => {
  test("stores only exact versioned, privacy-safe metadata and parses the durable row", async () => {
    const fake = new FakeCredits();
    const service = serviceAt(fake, () => START_SECONDS);
    const prepared = newReceipt(await service.prepare(request()));

    const result = await service.chargeOrReplay(prepared, { chargeAmountUsd: 0.1234567 });

    expect(result).toEqual({
      claims: {
        issuedAt: START_SECONDS,
        expiresAt: START_SECONDS + 300,
        capabilityHost: CAPABILITY_HOST,
        chargeAmountUsd: "0.123457",
      },
      transactionId: "00000000-0000-0000-0000-000000000001",
      replayed: false,
    });
    expect(fake.deductions).toHaveLength(1);
    const deduction = fake.deductions[0];
    expect(deduction.amount).toBe(0.123457);
    expect(deduction.stripePaymentIntentId).toBe(prepared.ledgerIdempotencyKey);
    expect(deduction.metadata).toEqual({
      type: "proxy_storage",
      storagePresignReceipt: "storage_presign_receipt_v1",
      version: 1,
      service: "storage",
      method: "presign",
      operation: "get",
      requestDigest: prepared.requestDigest,
      capabilityHost: CAPABILITY_HOST,
      issuedAt: START_SECONDS,
      expiresAt: START_SECONDS + 300,
      chargeAmountUsd: "0.123457",
    });
    const persisted = fake.committed.get(prepared.ledgerIdempotencyKey);
    expect(persisted?.amount).toBe("-0.123457");
    const serializedMetadata = JSON.stringify(persisted?.metadata);
    expect(serializedMetadata).not.toContain(RAW_IDEMPOTENCY_KEY);
    expect(serializedMetadata).not.toContain(PRIVATE_SCOPED_KEY);
    expect(serializedMetadata).not.toContain("token");
    expect(serializedMetadata).not.toContain("url");
  });

  test("recovers a commit followed by an exception and later replays without another debit", async () => {
    let now = START_SECONDS;
    const fake = new FakeCredits();
    const postCommitFailure = new Error("cache invalidation failed after commit");
    fake.throwAfterCommitOnce = postCommitFailure;
    const service = serviceAt(fake, () => now);
    const prepared = newReceipt(await service.prepare(request()));

    const recovered = await service.chargeOrReplay(prepared, { chargeAmountUsd: 0.25 });

    expect(recovered.replayed).toBe(true);
    expect(recovered.claims.chargeAmountUsd).toBe("0.250000");
    expect(fake.committed).toHaveLength(1);
    expect(fake.deductions).toHaveLength(1);
    expect(fake.lookups).toHaveLength(2);

    now += 5;
    const retry = await service.prepare(request());
    expect(retry.status).toBe("replay");
    if (retry.status !== "replay") {
      throw new Error("Expected a committed receipt replay");
    }
    expect(retry.claims).toEqual(recovered.claims);
    expect(retry.transactionId).toBe(recovered.transactionId);
    expect(fake.deductions).toHaveLength(1);
  });

  test("rethrows the original debit failure when the recovery read proves no commit", async () => {
    const fake = new FakeCredits();
    const preCommitFailure = new Error("database unavailable before commit");
    fake.throwBeforeCommitOnce = preCommitFailure;
    const service = serviceAt(fake, () => START_SECONDS);
    const prepared = newReceipt(await service.prepare(request()));

    await expect(service.chargeOrReplay(prepared, { chargeAmountUsd: 0.25 })).rejects.toBe(
      preCommitFailure,
    );
    expect(fake.committed).toHaveLength(0);
    expect(fake.lookups).toHaveLength(2);
  });

  test("returns the concurrent winner's durable claims instead of the losing candidate", async () => {
    let now = START_SECONDS;
    const fake = new FakeCredits();
    const service = serviceAt(fake, () => now);
    const firstCandidate = newReceipt(await service.prepare(request()));
    now += 7;
    const winningCandidate = newReceipt(await service.prepare(request()));

    const winner = await service.chargeOrReplay(winningCandidate, { chargeAmountUsd: 0.35 });
    const loser = await service.chargeOrReplay(firstCandidate, { chargeAmountUsd: 0.45 });

    expect(winner.claims.issuedAt).toBe(START_SECONDS + 7);
    expect(loser.claims).toEqual(winner.claims);
    expect(loser.claims).not.toEqual({
      ...firstCandidate.candidateClaims,
      chargeAmountUsd: "0.450000",
    });
    expect(loser.replayed).toBe(true);
    expect(fake.committed).toHaveLength(1);
  });

  test("rejects a concurrent winner for a different request digest", async () => {
    const fake = new FakeCredits();
    const service = serviceAt(fake, () => START_SECONDS);
    const firstRequest = newReceipt(await service.prepare(request()));
    const conflictingRequest = newReceipt(
      await service.prepare(request({ scopedKey: `org/${ORGANIZATION_ID}/private/other.wav` })),
    );

    await service.chargeOrReplay(firstRequest, { chargeAmountUsd: 0.25 });
    const conflict = await service
      .chargeOrReplay(conflictingRequest, { chargeAmountUsd: 0.25 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(conflict).toMatchObject({
      name: StorageReadReceiptConflictError.name,
      reason: "idempotency_key_reused",
      statusCode: 409,
      transactionId: undefined,
    });
    expect(JSON.stringify(conflict)).not.toContain(PRIVATE_SCOPED_KEY);
    expect(JSON.stringify(conflict)).not.toContain(RAW_IDEMPOTENCY_KEY);
    expect(fake.committed).toHaveLength(1);
  });

  test("an insufficient first attempt leaves the key reusable", async () => {
    const fake = new FakeCredits();
    fake.insufficient = true;
    const service = serviceAt(fake, () => START_SECONDS);
    const first = newReceipt(await service.prepare(request()));

    await expect(service.chargeOrReplay(first, { chargeAmountUsd: 0.25 })).rejects.toBeInstanceOf(
      StorageReadReceiptInsufficientCreditsError,
    );
    expect(fake.committed).toHaveLength(0);

    fake.insufficient = false;
    const retry = newReceipt(await service.prepare(request()));
    const charged = await service.chargeOrReplay(retry, { chargeAmountUsd: 0.25 });
    expect(charged.claims.chargeAmountUsd).toBe("0.250000");
    expect(fake.committed).toHaveLength(1);
  });

  for (const [label, amount] of [
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["below one micro-dollar after quantization", 0.0000004],
    ["above the ledger precision", 1_000_000],
  ] as const) {
    test(`rejects a ${label} paid-path amount before a debit`, async () => {
      const fake = new FakeCredits();
      const service = serviceAt(fake, () => START_SECONDS);
      const prepared = newReceipt(await service.prepare(request()));

      await expect(
        service.chargeOrReplay(prepared, { chargeAmountUsd: amount }),
      ).rejects.toBeInstanceOf(StorageReadReceiptUnavailableError);
      expect(fake.deductions).toHaveLength(0);
      expect(fake.committed).toHaveLength(0);
    });
  }
});

describe("StorageReadReceiptService committed receipt validation", () => {
  test("an expired receipt conflicts and requires a new idempotency key", async () => {
    let now = START_SECONDS;
    const fake = new FakeCredits();
    const service = serviceAt(fake, () => now);
    const prepared = newReceipt(await service.prepare(request({ ttlSeconds: 60 })));
    await service.chargeOrReplay(prepared, { chargeAmountUsd: 0.25 });

    now += 60;
    const conflict = await service.prepare(request({ ttlSeconds: 60 })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(conflict).toMatchObject({
      name: StorageReadReceiptConflictError.name,
      reason: "receipt_expired",
      statusCode: 409,
      transactionId: "00000000-0000-0000-0000-000000000001",
    });
    const serializedConflict = JSON.stringify(conflict);
    expect(serializedConflict).toContain("00000000-0000-0000-0000-000000000001");
    expect(serializedConflict).not.toContain(PRIVATE_SCOPED_KEY);
    expect(serializedConflict).not.toContain(RAW_IDEMPOTENCY_KEY);
    expect(fake.deductions).toHaveLength(1);
  });

  test("a capability-host cutover fails unavailable instead of charging again", async () => {
    const fake = new FakeCredits();
    const service = serviceAt(fake, () => START_SECONDS);
    const prepared = newReceipt(await service.prepare(request()));
    await service.chargeOrReplay(prepared, { chargeAmountUsd: 0.25 });

    await expect(
      service.prepare(request({ capabilityHost: "new-blob.example.test" })),
    ).rejects.toBeInstanceOf(StorageReadReceiptUnavailableError);
    expect(fake.deductions).toHaveLength(1);
  });

  for (const [label, corrupt] of [
    [
      "ledger identity",
      (transaction: CreditTransaction) => {
        transaction.stripe_payment_intent_id = "storage-presign:v1:wrong";
      },
    ],
    [
      "transaction UUID",
      (transaction: CreditTransaction) => {
        transaction.id = "private-object-key";
      },
    ],
    [
      "organization",
      (transaction: CreditTransaction) => {
        transaction.organization_id = OTHER_ORGANIZATION_ID;
      },
    ],
    [
      "transaction type",
      (transaction: CreditTransaction) => {
        transaction.type = "credit";
      },
    ],
    [
      "metadata marker",
      (transaction: CreditTransaction) => {
        transaction.metadata.storagePresignReceipt = "storage_presign_receipt_v2";
      },
    ],
    [
      "storage classification",
      (transaction: CreditTransaction) => {
        transaction.metadata.type = "storage_presign_receipt";
      },
    ],
    [
      "unknown metadata property",
      (transaction: CreditTransaction) => {
        transaction.metadata.objectKey = PRIVATE_SCOPED_KEY;
      },
    ],
    [
      "capability host",
      (transaction: CreditTransaction) => {
        transaction.metadata.capabilityHost = "other.example.test";
      },
    ],
    [
      "non-integer issue time",
      (transaction: CreditTransaction) => {
        transaction.metadata.issuedAt = START_SECONDS + 0.5;
      },
    ],
    [
      "TTL",
      (transaction: CreditTransaction) => {
        transaction.metadata.expiresAt = START_SECONDS + 301;
      },
    ],
    [
      "future issue time",
      (transaction: CreditTransaction) => {
        transaction.metadata.issuedAt = START_SECONDS + 31;
        transaction.metadata.expiresAt = START_SECONDS + 331;
      },
    ],
    [
      "non-canonical charge amount",
      (transaction: CreditTransaction) => {
        transaction.metadata.chargeAmountUsd = "0.25";
      },
    ],
    [
      "positive ledger amount",
      (transaction: CreditTransaction) => {
        transaction.amount = "0.250000";
      },
    ],
    [
      "ledger amount equality",
      (transaction: CreditTransaction) => {
        transaction.amount = "-0.250001";
      },
    ],
    [
      "ledger precision overflow",
      (transaction: CreditTransaction) => {
        transaction.metadata.chargeAmountUsd = "1000000.000000";
        transaction.amount = "-1000000.000000";
      },
    ],
  ] as const) {
    test(`fails closed for corrupt ${label}`, async () => {
      const fake = new FakeCredits();
      const service = serviceAt(fake, () => START_SECONDS);
      const prepared = newReceipt(await service.prepare(request()));
      await service.chargeOrReplay(prepared, { chargeAmountUsd: 0.25 });
      const transaction = fake.committed.get(prepared.ledgerIdempotencyKey);
      if (!transaction) {
        throw new Error("Expected a committed test receipt");
      }
      corrupt(transaction);

      await expect(service.prepare(request())).rejects.toBeInstanceOf(
        StorageReadReceiptUnavailableError,
      );
      expect(fake.deductions).toHaveLength(1);
    });
  }
});

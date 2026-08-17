/**
 * Exercises native-storage HEAD receipt idempotency and billing against real PGlite transactions.
 * The suite applies the production 0239/0240 DDL and never mocks the money writes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbTransaction } from "../../client";
import type { writeTransaction as WriteTransaction } from "../../helpers";
import type {
  OrgStorageHeadReceiptIdentity,
  OrgStorageHeadReceiptRequest,
  OrgStorageHeadReceiptTransactionRunner,
  OrgStorageHeadTerminalResponse,
  PreparedOrgStorageHeadReceiptIdentity,
  OrgStorageHeadReceiptRepository as ReceiptRepository,
} from "../org-storage-head-receipts";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const USER_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const REPLAY_TTL_MS = 24 * 60 * 60 * 1_000;
const PURGE_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const TEST_TIMEOUT_MS = 60_000;

let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | null = null;
let getPgliteClientForTests: typeof import("../../client").getPgliteClientForTests;
let writeTransaction: typeof WriteTransaction;
let OrgStorageHeadReceiptRepository: typeof ReceiptRepository;
let repository: ReceiptRepository;
let INVALID_INPUT: string;
let CONFLICT: string;
let INSUFFICIENT: string;
let UNAVAILABLE: string;
let INVARIANT: string;
let sequence = 1;

function uuid(): string {
  const suffix = sequence.toString(16).padStart(12, "0");
  sequence += 1;
  return `10000000-0000-4000-8000-${suffix}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function request(
  organizationId = ORG_A,
  suffix = "voice/message.mp3",
  overrides: Partial<OrgStorageHeadReceiptRequest> = {},
): OrgStorageHeadReceiptRequest {
  return {
    objectKey: `org/${organizationId}/${suffix}`,
    ifMatch: null,
    ifNoneMatch: null,
    ifModifiedSince: null,
    ifUnmodifiedSince: null,
    ...overrides,
  };
}

function okResponse(
  seed = 1,
  overrides: Partial<Extract<OrgStorageHeadTerminalResponse, { kind: "ok" }>> = {},
): Extract<OrgStorageHeadTerminalResponse, { kind: "ok" }> {
  return {
    kind: "ok",
    objectId: `20000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
    objectGeneration: 7n,
    contentLength: 123n,
    contentType: "audio/mpeg",
    etag: `etag-${seed}`,
    lastModified: new Date("2026-08-17T09:00:37.000Z"),
    forceAttachment: false,
    ...overrides,
  };
}

function validatorResponse(
  kind: "not_modified" | "precondition_failed",
  seed: number,
): Extract<OrgStorageHeadTerminalResponse, { kind: typeof kind }> {
  return {
    kind,
    objectId: `30000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
    objectGeneration: 9n,
    etag: `validator-${seed}`,
    lastModified: new Date("2026-08-17T09:00:37.000Z"),
  } as Extract<OrgStorageHeadTerminalResponse, { kind: typeof kind }>;
}

async function preparedIdentity(
  rawIdempotencyKey: string,
  options: {
    organizationId?: string;
    request?: OrgStorageHeadReceiptRequest;
  } = {},
): Promise<PreparedOrgStorageHeadReceiptIdentity> {
  const organizationId = options.organizationId ?? ORG_A;
  const prepared = await repository.prepare({
    organizationId,
    rawIdempotencyKey,
    request: options.request ?? request(organizationId),
  });
  if (prepared.outcome !== "miss") throw new Error("Expected a receipt miss");
  return prepared.identity;
}

async function commit(
  rawIdempotencyKey: string,
  chargeAmountUsd = "0.000050",
  response: OrgStorageHeadTerminalResponse = okResponse(sequence),
): Promise<Awaited<ReturnType<ReceiptRepository["commitTerminal"]>>> {
  const identity = await preparedIdentity(rawIdempotencyKey);
  return await repository.commitTerminal({ identity, chargeAmountUsd, response });
}

async function captureError(
  promise: Promise<unknown>,
): Promise<Error & { code?: unknown; reason?: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected an Error rejection");
  }
  throw new Error("Expected promise to reject");
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<Error & { code?: unknown; reason?: unknown }> {
  const error = await captureError(promise);
  expect(error.code).toBe(code);
  return error;
}

async function tableCount(
  table: "credit_transactions" | "org_storage_head_receipts",
): Promise<number> {
  const result = await getPgliteClientForTests().query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return result.rows[0]?.count ?? -1;
}

function responseIdentity(response: OrgStorageHeadTerminalResponse): unknown[] {
  if (response.kind === "ok") {
    return [
      response.kind,
      response.objectId,
      response.objectGeneration.toString(10),
      response.contentLength.toString(10),
      response.contentType,
      response.etag,
      response.lastModified.toISOString(),
      response.forceAttachment,
    ];
  }
  if (response.kind === "not_found") return [response.kind];
  return [
    response.kind,
    response.objectId,
    response.objectGeneration.toString(10),
    response.etag,
    response.lastModified.toISOString(),
  ];
}

function manualReceiptDigest(input: {
  id: string;
  identity: OrgStorageHeadReceiptIdentity;
  chargeAmountUsd: string;
  response: OrgStorageHeadTerminalResponse;
  creditTransactionId: string | null;
  createdAt: Date;
  replayExpiresAt: Date;
  purgeAfter: Date;
}): string {
  return sha256(
    JSON.stringify([
      "org-storage-head-receipt:v1",
      input.id,
      input.identity.organizationId,
      input.identity.idempotencyKeyHash,
      input.identity.requestDigest,
      input.identity.ledgerIdempotencyMarker,
      input.chargeAmountUsd,
      responseIdentity(input.response),
      input.creditTransactionId,
      input.createdAt.toISOString(),
      input.replayExpiresAt.toISOString(),
      input.purgeAfter.toISOString(),
    ]),
  );
}

async function insertManualNotFoundReceipt(input: {
  id: string;
  identity: OrgStorageHeadReceiptIdentity;
  createdAt: Date;
  replayExpiresAt: Date;
  purgeAfter: Date;
  receiptDigest?: string;
}): Promise<void> {
  const response = { kind: "not_found" } as const;
  const receiptDigest =
    input.receiptDigest ??
    manualReceiptDigest({
      ...input,
      chargeAmountUsd: "0.000000",
      response,
      creditTransactionId: null,
    });
  await getPgliteClientForTests().query(
    `INSERT INTO org_storage_head_receipts (
       id, organization_id, idempotency_key_hash, request_digest, charge_amount_usd,
       response_kind, response_status, receipt_digest, replay_expires_at, purge_after, created_at
     ) VALUES ($1, $2, $3, $4, '0.000000', 'not_found', 404, $5, $6, $7, $8)`,
    [
      input.id,
      input.identity.organizationId,
      input.identity.idempotencyKeyHash,
      input.identity.requestDigest,
      receiptDigest,
      input.replayExpiresAt,
      input.purgeAfter,
      input.createdAt,
    ],
  );
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import("../../client"));
  ({ writeTransaction } = await import("../../helpers"));
  const repositoryModule = await import("../org-storage-head-receipts");
  ({ OrgStorageHeadReceiptRepository } = repositoryModule);
  repository = repositoryModule.orgStorageHeadReceiptRepository;
  INVALID_INPUT = repositoryModule.ORG_STORAGE_HEAD_RECEIPT_INVALID_INPUT;
  CONFLICT = repositoryModule.ORG_STORAGE_HEAD_RECEIPT_CONFLICT;
  INSUFFICIENT = repositoryModule.ORG_STORAGE_HEAD_RECEIPT_INSUFFICIENT_CREDITS;
  UNAVAILABLE = repositoryModule.ORG_STORAGE_HEAD_RECEIPT_UNAVAILABLE;
  INVARIANT = repositoryModule.ORG_STORAGE_HEAD_RECEIPT_INVARIANT_VIOLATION;

  const database = getPgliteClientForTests();
  await database.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      credit_balance numeric(16, 6) NOT NULL DEFAULT '0.000000',
      balance_revision bigint NOT NULL DEFAULT 0,
      balance_decrease_revision bigint NOT NULL DEFAULT 0,
      updated_at timestamp NOT NULL DEFAULT NOW()
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid,
      amount numeric(16, 6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      stripe_payment_intent_id text,
      created_at timestamp NOT NULL DEFAULT NOW(),
      settled_at timestamp
    );
    CREATE UNIQUE INDEX credit_transactions_stripe_payment_intent_idx
      ON credit_transactions(stripe_payment_intent_id);
  `);
  for (const tag of [
    "0239_org_storage_head_receipts",
    "0240_org_storage_head_receipt_response_shapes",
  ]) {
    await database.exec(readFileSync(join(import.meta.dir, `../../migrations/${tag}.sql`), "utf8"));
  }
}, TEST_TIMEOUT_MS);

beforeEach(async () => {
  sequence = 1;
  repository = new OrgStorageHeadReceiptRepository();
  await getPgliteClientForTests().exec(`
    DELETE FROM org_storage_head_receipts;
    DELETE FROM credit_transactions;
    DELETE FROM organizations;
    INSERT INTO organizations (id, name, slug, credit_balance) VALUES
      ('${ORG_A}', 'Org A', 'org-a', '10.000000'),
      ('${ORG_B}', 'Org B', 'org-b', '10.000000');
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("OrgStorageHeadReceiptRepository", () => {
  test("hashes tenant-scoped request identities without persisting raw request material", async () => {
    const rawKey = "private idempotency sentinel 6fd2f6";
    const objectKey = `org/${ORG_A}/private/customer-file-sentinel.mp3`;
    const conditional = '"private-etag-condition-sentinel"';
    const first = await repository.prepare({
      organizationId: ORG_A,
      rawIdempotencyKey: rawKey,
      request: request(ORG_A, "private/customer-file-sentinel.mp3", { ifMatch: conditional }),
    });
    const second = await repository.prepare({
      organizationId: ORG_B,
      rawIdempotencyKey: rawKey,
      request: request(ORG_B, "private/customer-file-sentinel.mp3", { ifMatch: conditional }),
    });
    if (first.outcome !== "miss" || second.outcome !== "miss") {
      throw new Error("Expected receipt misses");
    }
    expect(first.identity.idempotencyKeyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.identity.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.identity.ledgerIdempotencyMarker).toMatch(/^org-storage-head:v1:[0-9a-f]{64}$/);
    expect(first.identity.idempotencyKeyHash).not.toBe(second.identity.idempotencyKeyHash);
    expect(first.identity.requestDigest).not.toBe(second.identity.requestDigest);
    expect(first.identity.ledgerIdempotencyMarker).not.toBe(
      second.identity.ledgerIdempotencyMarker,
    );

    await repository.commitTerminal({
      identity: first.identity,
      chargeAmountUsd: "0.000000",
      response: { kind: "not_found" },
    });
    const rows = await getPgliteClientForTests().query("SELECT * FROM org_storage_head_receipts");
    const serialized = JSON.stringify(rows.rows);
    expect(serialized).not.toContain(rawKey);
    expect(serialized).not.toContain(objectKey);
    expect(serialized).not.toContain(conditional);
  });

  test("rejects ambiguous idempotency, tenant, key, header, price, and response inputs", async () => {
    for (const rawIdempotencyKey of [
      undefined,
      "",
      " leading",
      "trailing ",
      "tab\tkey",
      "é",
      "x".repeat(129),
    ]) {
      await expectCode(
        repository.prepare({
          organizationId: ORG_A,
          rawIdempotencyKey,
          request: request(),
        }),
        INVALID_INPUT,
      );
    }
    await expectCode(
      repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey: "wrong-tenant-key",
        request: request(ORG_B),
      }),
      INVALID_INPUT,
    );
    for (const objectKey of [
      `org/${ORG_A}/a//b`,
      `org/${ORG_A}/a/../b`,
      `org/${ORG_A}/cafe\u0301`,
      `org/${ORG_A}/bad\u0001key`,
      `org/${ORG_A}/${"🚀".repeat(300)}`,
      `org/${ORG_A}/bad\ud800`,
    ]) {
      await expectCode(
        repository.prepare({
          organizationId: ORG_A,
          rawIdempotencyKey: `invalid-object-${sha256(objectKey).slice(0, 8)}`,
          request: { ...request(), objectKey },
        }),
        INVALID_INPUT,
      );
    }
    await expectCode(
      repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey: "invalid-header",
        request: request(ORG_A, "valid", { ifMatch: "bad\nheader" }),
      }),
      INVALID_INPUT,
    );

    const identity = await preparedIdentity("invalid-candidate");
    for (const chargeAmountUsd of [
      "0",
      "0.00000",
      "00.000050",
      "-0.000001",
      "NaN",
      "1000000.000000",
    ]) {
      await expectCode(
        repository.commitTerminal({
          identity,
          chargeAmountUsd,
          response: { kind: "not_found" },
        }),
        INVALID_INPUT,
      );
    }
    await expectCode(
      repository.commitTerminal({
        identity,
        chargeAmountUsd: "0.000000",
        response: okResponse(1, { contentType: "audio/mpeg\u00a0" }),
      }),
      INVALID_INPUT,
    );
    await expectCode(
      repository.commitTerminal({
        identity,
        chargeAmountUsd: "0.000000",
        response: okResponse(1, { lastModified: new Date("2026-08-17T09:00:37.001Z") }),
      }),
      INVALID_INPUT,
    );
    await expectCode(
      repository.commitTerminal({
        identity: { ...identity },
        chargeAmountUsd: "0.000000",
        response: { kind: "not_found" },
      }),
      INVALID_INPUT,
    );
    const prototypeForgedIdentity = Object.assign(
      Object.create(Object.getPrototypeOf(identity)) as PreparedOrgStorageHeadReceiptIdentity,
      { ...identity },
    );
    await expectCode(
      repository.commitTerminal({
        identity: prototypeForgedIdentity,
        chargeAmountUsd: "0.000000",
        response: { kind: "not_found" },
      }),
      INVALID_INPUT,
    );
    expect(await tableCount("org_storage_head_receipts")).toBe(0);
    expect(await tableCount("credit_transactions")).toBe(0);
  });

  test("commits and reconstructs exact typed 200, 304, 404, and 412 responses", async () => {
    const responses: OrgStorageHeadTerminalResponse[] = [
      okResponse(1, { contentLength: 0n, forceAttachment: true }),
      validatorResponse("not_modified", 2),
      { kind: "not_found" },
      validatorResponse("precondition_failed", 3),
    ];
    for (const [index, response] of responses.entries()) {
      const rawIdempotencyKey = `typed-response-${index}`;
      const committed = await commit(rawIdempotencyKey, "0.000000", response);
      expect(committed.outcome).toBe("committed");
      expect(committed.receipt.response).toEqual(response);
      expect(committed.receipt.chargeAmountUsd).toBe("0.000000");
      expect(committed.receipt.creditTransactionId).toBeNull();

      const replay = await repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey,
        request: request(),
      });
      expect(replay).toEqual({ outcome: "replay", receipt: committed.receipt });
    }
    expect(await tableCount("org_storage_head_receipts")).toBe(4);
    expect(await tableCount("credit_transactions")).toBe(0);
  });

  test("uses the database clock and exact fixed replay and purge horizons", async () => {
    const before = Date.now();
    const committed = await commit("database-clock", "0.000000", { kind: "not_found" });
    const after = Date.now();
    expect(committed.receipt.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(committed.receipt.createdAt.getTime()).toBeLessThanOrEqual(after + 1_000);
    expect(
      committed.receipt.replayExpiresAt.getTime() - committed.receipt.createdAt.getTime(),
    ).toBe(REPLAY_TTL_MS);
    expect(
      committed.receipt.purgeAfter.getTime() - committed.receipt.replayExpiresAt.getTime(),
    ).toBe(PURGE_GRACE_MS);
  });

  test("rejects a correctly digested receipt whose creation time is in the future", async () => {
    const identity = await preparedIdentity("future-receipt");
    const createdAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000);
    createdAt.setMilliseconds(0);
    await insertManualNotFoundReceipt({
      id: uuid(),
      identity,
      createdAt,
      replayExpiresAt: new Date(createdAt.getTime() + REPLAY_TTL_MS),
      purgeAfter: new Date(createdAt.getTime() + REPLAY_TTL_MS + PURGE_GRACE_MS),
    });
    await expectCode(
      repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey: "future-receipt",
        request: request(),
      }),
      INVARIANT,
    );
  });

  test("atomically debits a canonical positive price and writes one exact private ledger link", async () => {
    const committed = await commit("positive-debit", "0.000050", okResponse(4));
    expect(committed.outcome).toBe("committed");
    expect(committed.balanceMutation).toMatchObject({ observedBalanceUsd: "9.999950" });
    expect(committed.receipt.creditTransactionId).toBe(
      committed.balanceMutation?.transactionId ?? null,
    );

    const ledger = await getPgliteClientForTests().query<{
      amount: string;
      type: string;
      description: string;
      metadata: Record<string, unknown>;
      stripe_payment_intent_id: string;
      user_id: string | null;
      settled_at: Date | null;
    }>(`SELECT amount::text, type, description, metadata, stripe_payment_intent_id,
               user_id, settled_at FROM credit_transactions`);
    expect(ledger.rows).toEqual([
      {
        amount: "-0.000050",
        type: "debit",
        description: "API proxy: storage — head",
        metadata: {
          type: "native_storage_head",
          receipt_id: committed.receipt.id,
          version: 1,
        },
        stripe_payment_intent_id: committed.receipt.identity.ledgerIdempotencyMarker,
        user_id: null,
        settled_at: null,
      },
    ]);
    expect(await tableCount("org_storage_head_receipts")).toBe(1);
  });

  test("accepts the full deployed numeric(16,6) organization balance range", async () => {
    await getPgliteClientForTests().query(
      "UPDATE organizations SET credit_balance = '1000001.000000' WHERE id = $1",
      [ORG_A],
    );
    const committed = await commit("large-production-balance", "0.000050", okResponse(41));
    expect(committed.outcome).toBe("committed");
    expect(committed.balanceMutation?.observedBalanceUsd).toBe("1000000.999950");
    expect(committed.receipt.chargeAmountUsd).toBe("0.000050");
  });

  test("leaves insufficient attempts unrecorded and lets the same key succeed after top-up", async () => {
    await getPgliteClientForTests().query(
      "UPDATE organizations SET credit_balance = '0.000040' WHERE id = $1",
      [ORG_A],
    );
    const identity = await preparedIdentity("reusable-insufficient");
    await expectCode(
      repository.commitTerminal({
        identity,
        chargeAmountUsd: "0.000050",
        response: okResponse(5),
      }),
      INSUFFICIENT,
    );
    expect(await tableCount("org_storage_head_receipts")).toBe(0);
    expect(await tableCount("credit_transactions")).toBe(0);
    await getPgliteClientForTests().query(
      "UPDATE organizations SET credit_balance = '1.000000' WHERE id = $1",
      [ORG_A],
    );
    const committed = await repository.commitTerminal({
      identity,
      chargeAmountUsd: "0.000050",
      response: okResponse(5),
    });
    expect(committed.outcome).toBe("committed");
    expect(committed.balanceMutation?.observedBalanceUsd).toBe("0.999950");
  });

  test("snapshots the validated price before the transaction begins", async () => {
    let enterTransaction!: () => void;
    let releaseTransaction!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterTransaction = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const delayedTransaction: OrgStorageHeadReceiptTransactionRunner = async <T>(
      callback: (transaction: DbTransaction) => Promise<T>,
    ): Promise<T> => {
      enterTransaction();
      await gate;
      return await writeTransaction(callback);
    };
    repository = new OrgStorageHeadReceiptRepository(delayedTransaction);
    const identity = await preparedIdentity("price-snapshot");
    const input = {
      identity,
      chargeAmountUsd: "0.000050",
      response: okResponse(51),
    };
    const pending = repository.commitTerminal(input);
    await entered;
    input.chargeAmountUsd = "0.000100";
    releaseTransaction();
    const committed = await pending;
    expect(committed.receipt.chargeAmountUsd).toBe("0.000050");
    expect(committed.balanceMutation?.observedBalanceUsd).toBe("9.999950");
  });

  test("converges concurrent identical requests onto one receipt and one debit", async () => {
    const identity = await preparedIdentity("sixteen-way-race");
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        repository.commitTerminal({
          identity,
          chargeAmountUsd: "0.000050",
          response: okResponse(6),
        }),
      ),
    );
    expect(results.filter((result) => result.outcome === "committed")).toHaveLength(1);
    expect(new Set(results.map((result) => result.receipt.id))).toEqual(
      new Set([results[0]?.receipt.id]),
    );
    expect(await tableCount("org_storage_head_receipts")).toBe(1);
    expect(await tableCount("credit_transactions")).toBe(1);
    const balance = await getPgliteClientForTests().query<{ credit_balance: string }>(
      "SELECT credit_balance::text FROM organizations WHERE id = $1",
      [ORG_A],
    );
    expect(balance.rows[0]?.credit_balance).toBe("9.999950");
  });

  test("pins the first zero-or-positive price decision under a stale pricing race", async () => {
    const identity = await preparedIdentity("stale-price-race");
    const results = await Promise.all([
      repository.commitTerminal({
        identity,
        chargeAmountUsd: "0.000000",
        response: okResponse(7),
      }),
      repository.commitTerminal({
        identity,
        chargeAmountUsd: "0.000050",
        response: okResponse(7),
      }),
    ]);
    expect(results.filter((result) => result.outcome === "committed")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "replayed")).toHaveLength(1);
    expect(results[0]?.receipt).toEqual(results[1]?.receipt);
    const charged = results[0]?.receipt.chargeAmountUsd === "0.000050";
    expect(await tableCount("credit_transactions")).toBe(charged ? 1 : 0);
    const balance = await getPgliteClientForTests().query<{ credit_balance: string }>(
      "SELECT credit_balance::text FROM organizations WHERE id = $1",
      [ORG_A],
    );
    expect(balance.rows[0]?.credit_balance).toBe(charged ? "9.999950" : "10.000000");
  });

  test("rejects the same idempotency key for a different request without another debit", async () => {
    await commit("request-conflict", "0.000050", okResponse(8));
    const error = await expectCode(
      repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey: "request-conflict",
        request: request(ORG_A, "different-object.mp3"),
      }),
      CONFLICT,
    );
    expect(error.reason).toBe("idempotency_key_reused");
    expect(await tableCount("credit_transactions")).toBe(1);
  });

  test("returns an explicit expired conflict throughout the purge grace", async () => {
    const identity = await preparedIdentity("expired-receipt");
    const createdAt = new Date(Date.now() - 2 * REPLAY_TTL_MS);
    createdAt.setMilliseconds(0);
    const replayExpiresAt = new Date(createdAt.getTime() + REPLAY_TTL_MS);
    const purgeAfter = new Date(replayExpiresAt.getTime() + PURGE_GRACE_MS);
    await insertManualNotFoundReceipt({
      id: uuid(),
      identity,
      createdAt,
      replayExpiresAt,
      purgeAfter,
    });
    const reused = await expectCode(
      repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey: "expired-receipt",
        request: request(ORG_A, "different-after-expiry.mp3"),
      }),
      CONFLICT,
    );
    expect(reused.reason).toBe("idempotency_key_reused");
    const error = await expectCode(
      repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey: "expired-receipt",
        request: request(),
      }),
      CONFLICT,
    );
    expect(error.reason).toBe("receipt_expired");
  });

  test("recovers a committed transaction whose acknowledgement is lost", async () => {
    const commitThenThrow: OrgStorageHeadReceiptTransactionRunner = async <T>(
      callback: (transaction: DbTransaction) => Promise<T>,
    ): Promise<T> => {
      await writeTransaction(callback);
      await getPgliteClientForTests().query(
        "UPDATE organizations SET credit_balance = credit_balance + '1.000000' WHERE id = $1",
        [ORG_A],
      );
      throw new Error("private commit acknowledgement sentinel");
    };
    repository = new OrgStorageHeadReceiptRepository(commitThenThrow);
    const identity = await preparedIdentity("ack-loss");
    const committed = await repository.commitTerminal({
      identity,
      chargeAmountUsd: "0.000050",
      response: okResponse(9),
    });
    expect(committed.outcome).toBe("committed");
    expect(committed.balanceMutation?.transactionId ?? null).toBe(
      committed.receipt.creditTransactionId,
    );
    expect(committed.balanceMutation?.observedBalanceUsd).toBe("10.999950");
    expect(await tableCount("org_storage_head_receipts")).toBe(1);
    expect(await tableCount("credit_transactions")).toBe(1);
  });

  test("does not mistake a rolled-back transaction for a commit", async () => {
    const rollbackThenThrow: OrgStorageHeadReceiptTransactionRunner = async <T>(
      callback: (transaction: DbTransaction) => Promise<T>,
    ): Promise<T> =>
      await writeTransaction(async (transaction) => {
        await callback(transaction);
        throw new Error("private rollback sentinel");
      });
    repository = new OrgStorageHeadReceiptRepository(rollbackThenThrow);
    const identity = await preparedIdentity("rollback");
    await expectCode(
      repository.commitTerminal({
        identity,
        chargeAmountUsd: "0.000050",
        response: okResponse(10),
      }),
      UNAVAILABLE,
    );
    expect(await tableCount("org_storage_head_receipts")).toBe(0);
    expect(await tableCount("credit_transactions")).toBe(0);
    const balance = await getPgliteClientForTests().query<{ credit_balance: string }>(
      "SELECT credit_balance::text FROM organizations WHERE id = $1",
      [ORG_A],
    );
    expect(balance.rows[0]?.credit_balance).toBe("10.000000");
  });

  test("fails closed on every malformed positive ledger link", async () => {
    const mutations = [
      `organization_id = '${ORG_B}'`,
      `amount = '0.000050'`,
      `amount = '-0.000049'`,
      `type = 'credit'`,
      `description = 'wrong description'`,
      `metadata = metadata || '{"extra":"forbidden"}'::jsonb`,
      `stripe_payment_intent_id = 'org-storage-head:v1:${"f".repeat(64)}'`,
      `user_id = '${USER_ID}'`,
      `settled_at = NOW()`,
      `created_at = created_at + interval '1 day'`,
    ];
    for (const [index, mutation] of mutations.entries()) {
      const rawIdempotencyKey = `corrupt-ledger-${index}`;
      const committed = await commit(rawIdempotencyKey, "0.000050", okResponse(20 + index));
      await getPgliteClientForTests().exec(
        `UPDATE credit_transactions SET ${mutation} WHERE id = '${committed.receipt.creditTransactionId}'`,
      );
      await expectCode(
        repository.prepare({
          organizationId: ORG_A,
          rawIdempotencyKey,
          request: request(),
        }),
        INVARIANT,
      );
    }
  });

  test("treats a valid paid marker as an expired tombstone after receipt compaction", async () => {
    const committed = await commit("paid-compacted", "0.000050", okResponse(70));
    await getPgliteClientForTests().query("DELETE FROM org_storage_head_receipts WHERE id = $1", [
      committed.receipt.id,
    ]);
    const error = await expectCode(
      repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey: "paid-compacted",
        request: request(),
      }),
      CONFLICT,
    );
    expect(error.reason).toBe("receipt_expired");
    expect(await tableCount("credit_transactions")).toBe(1);
  });

  test("fails closed on malformed detached markers and zero receipts with unexpected markers", async () => {
    const orphanIdentity = await preparedIdentity("orphan-marker");
    await getPgliteClientForTests().query(
      `INSERT INTO credit_transactions
        (id, organization_id, amount, type, description, metadata, stripe_payment_intent_id)
       VALUES ($1, $2, '-0.000050', 'debit', 'wrong detached marker',
        '{"type":"native_storage_head","receipt_id":"10000000-0000-4000-8000-000000000099","version":1}', $3)`,
      [uuid(), ORG_A, orphanIdentity.ledgerIdempotencyMarker],
    );
    await expectCode(
      repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey: "orphan-marker",
        request: request(),
      }),
      INVARIANT,
    );

    const zeroIdentity = await preparedIdentity("zero-plus-marker");
    await repository.commitTerminal({
      identity: zeroIdentity,
      chargeAmountUsd: "0.000000",
      response: { kind: "not_found" },
    });
    await getPgliteClientForTests().query(
      `INSERT INTO credit_transactions
        (id, organization_id, amount, type, description, metadata, stripe_payment_intent_id)
       VALUES ($1, $2, '-0.000050', 'debit', 'API proxy: storage — head',
        '{"type":"native_storage_head","receipt_id":"10000000-0000-4000-8000-000000000098","version":1}', $3)`,
      [uuid(), ORG_A, zeroIdentity.ledgerIdempotencyMarker],
    );
    await expectCode(
      repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey: "zero-plus-marker",
        request: request(),
      }),
      INVARIANT,
    );
  });

  test("rejects a structurally valid receipt whose application digest is corrupt", async () => {
    const identity = await preparedIdentity("bad-receipt-digest");
    const createdAt = new Date();
    createdAt.setMilliseconds(0);
    await insertManualNotFoundReceipt({
      id: uuid(),
      identity,
      createdAt,
      replayExpiresAt: new Date(createdAt.getTime() + REPLAY_TTL_MS),
      purgeAfter: new Date(createdAt.getTime() + REPLAY_TTL_MS + PURGE_GRACE_MS),
      receiptDigest: "f".repeat(64),
    });
    await expectCode(
      repository.prepare({
        organizationId: ORG_A,
        rawIdempotencyKey: "bad-receipt-digest",
        request: request(),
      }),
      INVARIANT,
    );
  });

  test("never serializes raw request material in typed failures", async () => {
    const rawIdempotencyKey = "private-failure-key-4f29";
    const privateObjectKey = `org/${ORG_A}/private-failure-object-8a31`;
    const identity = await preparedIdentity(rawIdempotencyKey, {
      request: { ...request(), objectKey: privateObjectKey },
    });
    const forgedIdentity = { ...identity };
    const error = await captureError(
      repository.commitTerminal({
        identity: forgedIdentity,
        chargeAmountUsd: "0.000050",
        response: okResponse(30),
      }),
    );
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(rawIdempotencyKey);
    expect(serialized).not.toContain(privateObjectKey);
    expect(error.code).toBe(INVALID_INPUT);
  });
});

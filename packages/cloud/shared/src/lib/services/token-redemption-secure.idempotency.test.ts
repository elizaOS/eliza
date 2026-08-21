/**
 * Regression coverage for user-scoped redemption idempotency. Exact retries
 * recover the original receipt before conflict gates, while reused keys with a
 * different intent are rejected.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const USER_ID = "00000000-0000-4000-8000-000000000101";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000102";
const IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000201";
const PAYOUT_ADDRESS = "0x0000000000000000000000000000000000000002";

let existingRow: Record<string, unknown> | undefined;
let capturedWhere: SQL | undefined;
let transactionClient: unknown;

const transaction = mock(async (callback: (tx: unknown) => Promise<unknown>) =>
  callback(transactionClient),
);
const getBalance = mock();
const findFirstByIdempotencyKey = async ({ where }: { where: SQL }) => {
  capturedWhere = where;
  if (!existingRow) return undefined;
  const query = new PgDialect().sqlToQuery(where);
  return query.params.includes(existingRow.user_id) ? existingRow : undefined;
};

mock.module("../../db/client", () => ({
  dbRead: {
    query: {
      tokenRedemptions: {
        findFirst: findFirstByIdempotencyKey,
      },
    },
  },
  dbWrite: {
    query: {
      tokenRedemptions: { findFirst: findFirstByIdempotencyKey },
    },
    transaction,
  },
}));

mock.module("./redeemable-earnings", () => ({
  redeemableEarningsService: { getBalance },
}));

const { SecureTokenRedemptionService } = await import("./token-redemption-secure");

type ServiceHarness = {
  createRedemption: (request: {
    userId: string;
    pointsAmount: number;
    network: "base";
    asset: "eliza" | "usdc";
    payoutAddress: string;
    idempotencyKey: string;
    metadata?: { ipAddress: string };
  }) => Promise<{
    success: boolean;
    redemptionId?: string;
    error?: string;
    quote?: Record<string, unknown>;
  }>;
  validateAddressSecure: () => Promise<{ valid: boolean }>;
  checkFraudPatterns: () => Promise<{ flagged: boolean }>;
  hasInFlightRedemption: () => Promise<boolean>;
  checkCooldown: () => Promise<{ valid: boolean }>;
  checkDailyLimitsUTC: () => Promise<{ valid: boolean }>;
  checkIPRateLimits: () => Promise<{ valid: boolean }>;
};

function makeExistingRow(userId = USER_ID) {
  return {
    id: "00000000-0000-4000-8000-000000000301",
    user_id: userId,
    app_id: null,
    points_amount: "1234.00",
    usd_value: "12.3400",
    eliza_price_usd: "0.25000000",
    eliza_amount: "49.36000000",
    price_quote_expires_at: new Date("2026-08-20T12:02:00.000Z"),
    asset: "eliza",
    network: "base",
    payout_address: PAYOUT_ADDRESS,
    requires_review: true,
    metadata: { idempotency_key: IDEMPOTENCY_KEY },
  };
}

function makeService(inFlight = true) {
  const service = new SecureTokenRedemptionService() as unknown as ServiceHarness;
  service.validateAddressSecure = mock(async () => ({ valid: true }));
  service.checkFraudPatterns = mock(async () => ({ flagged: false }));
  service.hasInFlightRedemption = mock(async () => inFlight);
  service.checkCooldown = mock(async () => ({ valid: true }));
  service.checkDailyLimitsUTC = mock(async () => ({ valid: true }));
  service.checkIPRateLimits = mock(async () => ({ valid: true }));
  return service;
}

function requestFor(userId = USER_ID) {
  return {
    userId,
    pointsAmount: 1_234,
    network: "base" as const,
    asset: "eliza" as const,
    payoutAddress: PAYOUT_ADDRESS,
    idempotencyKey: IDEMPOTENCY_KEY,
    metadata: { ipAddress: "198.51.100.44" },
  };
}

beforeEach(() => {
  existingRow = makeExistingRow();
  capturedWhere = undefined;
  transactionClient = undefined;
  transaction.mockClear();
  getBalance.mockReset();
});

describe("SecureTokenRedemptionService idempotency", () => {
  test("returns an exact replay before fraud and in-flight conflict gates", async () => {
    const service = makeService();

    const result = await service.createRedemption({
      ...requestFor(),
      metadata: undefined,
    });

    expect(result).toMatchObject({
      success: true,
      redemptionId: existingRow?.id,
      quote: {
        pointsAmount: 1_234,
        usdValue: "12.3400",
        elizaPriceUsd: "0.25000000",
        elizaAmount: "49.36000000",
        asset: "eliza",
        network: "base",
        payoutAddress: PAYOUT_ADDRESS,
        requiresReview: true,
      },
    });
    expect(service.checkFraudPatterns).not.toHaveBeenCalled();
    expect(service.hasInFlightRedemption).not.toHaveBeenCalled();
  });

  test("rejects reuse of a key when an intent field differs", async () => {
    const service = makeService();

    const result = await service.createRedemption({
      ...requestFor(),
      pointsAmount: 1_235,
    });

    expect(result).toEqual({
      success: false,
      error: "Idempotency key was already used for a different redemption request.",
    });
    expect(service.checkFraudPatterns).not.toHaveBeenCalled();
    expect(service.hasInFlightRedemption).not.toHaveBeenCalled();
  });

  test("binds both user and key in the lookup and never replays another user's receipt", async () => {
    const service = makeService();

    const result = await service.createRedemption(requestFor(OTHER_USER_ID));

    expect(result).toEqual({
      success: false,
      error: "You have an in-flight redemption. Please wait for it to complete or be rejected.",
    });
    expect(service.checkFraudPatterns).toHaveBeenCalledTimes(1);
    expect(service.hasInFlightRedemption).toHaveBeenCalledWith(OTHER_USER_ID);

    expect(capturedWhere).toBeDefined();
    const query = new PgDialect().sqlToQuery(capturedWhere!);
    expect(query.sql).toContain('"token_redemptions"."user_id" = $1');
    expect(query.sql).toContain("metadata");
    expect(query.params).toEqual([OTHER_USER_ID, IDEMPOTENCY_KEY]);
  });

  test("recovers a concurrent winner observed by the in-flight gate", async () => {
    existingRow = undefined;
    const winningRow = makeExistingRow();
    const service = makeService(false);
    service.hasInFlightRedemption = mock(async () => {
      // Simulate the first request committing after this request's initial
      // writer lookup but before the in-flight query completes.
      existingRow = winningRow;
      return true;
    });

    const result = await service.createRedemption(requestFor());

    expect(result).toMatchObject({
      success: true,
      redemptionId: winningRow.id,
      quote: {
        pointsAmount: 1_234,
        asset: "eliza",
      },
    });
    expect(service.hasInFlightRedemption).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });

  test("recovers a concurrent winner observed by a later mutable gate", async () => {
    existingRow = undefined;
    const winningRow = makeExistingRow();
    const service = makeService(false);
    service.checkCooldown = mock(async () => {
      // The in-flight query used an earlier snapshot; the winner becomes
      // visible before the next mutable gate rejects this duplicate.
      existingRow = winningRow;
      return { valid: false };
    });

    const result = await service.createRedemption(requestFor());

    expect(result).toMatchObject({
      success: true,
      redemptionId: winningRow.id,
    });
    expect(service.hasInFlightRedemption).toHaveBeenCalledTimes(1);
    expect(service.checkCooldown).toHaveBeenCalledTimes(1);
    expect(service.checkDailyLimitsUTC).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  test("rechecks the writer under the earnings lock before any concurrent mutation", async () => {
    existingRow = undefined;
    const winningRow = {
      ...makeExistingRow(),
      points_amount: "100.00",
      usd_value: "1.0000",
      eliza_price_usd: "1.00000000",
      eliza_amount: "1.00000000",
      asset: "usdc",
    };
    const service = makeService(false);
    getBalance.mockResolvedValue({ availableBalance: "100.00" });

    let selectCount = 0;
    let lockObserved = false;
    let writerWhere: SQL | undefined;
    const mutate = mock(() => {
      throw new Error("transaction mutated after an idempotent winner existed");
    });

    transactionClient = {
      select: () => ({
        from: () => ({
          where: (where: SQL) => {
            selectCount += 1;
            if (selectCount === 1) {
              return {
                for: async (mode: string) => {
                  lockObserved = mode === "update";
                  return [{ available_balance: "100.00", version: 1 }];
                },
              };
            }

            writerWhere = where;
            return { limit: async () => [winningRow] };
          },
        }),
      }),
      update: mutate,
      insert: mutate,
    };

    const result = await service.createRedemption({
      ...requestFor(),
      pointsAmount: 100,
      asset: "usdc",
    });

    expect(result).toMatchObject({
      success: true,
      redemptionId: winningRow.id,
      quote: {
        pointsAmount: 100,
        usdValue: "1.0000",
        asset: "usdc",
      },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(lockObserved).toBe(true);
    expect(selectCount).toBe(2);
    expect(mutate).not.toHaveBeenCalled();
    expect(service.checkDailyLimitsUTC).toHaveBeenCalledTimes(1);

    expect(writerWhere).toBeDefined();
    const query = new PgDialect().sqlToQuery(writerWhere!);
    expect(query.params).toEqual([USER_ID, IDEMPOTENCY_KEY]);
  });
});

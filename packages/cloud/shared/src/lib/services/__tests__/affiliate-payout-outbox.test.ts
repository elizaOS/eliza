/**
 * Affiliate payout settlement and retry behavior against a real in-memory
 * Postgres engine. The tests exercise atomic enqueue, owner pinning, lost
 * acknowledgements, and global source-id replay protection without mocks.
 */

import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const originalCacheEnabled = process.env.CACHE_ENABLED;
process.env.CACHE_ENABLED = "true";
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { affiliatePayoutOutbox } from "../../../db/schemas/affiliate-payout-outbox";
import { affiliateCodes } from "../../../db/schemas/affiliates";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import {
  organizationBalanceRevisionSequence,
  organizations,
} from "../../../db/schemas/organizations";
import {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
  redeemedEarningsTracking,
} from "../../../db/schemas/redeemable-earnings";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let payoutService: typeof import("../affiliate-payout-outbox");
let redeemableEarningsService: typeof import("../redeemable-earnings").redeemableEarningsService;
let creditsService: typeof import("../credits").creditsService;
let sequence = 0;

function uniq(prefix: string): string {
  sequence++;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedUser(label: string): Promise<string> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: label, slug: uniq(label.toLowerCase()) })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq(`${label}-user`), organization_id: org.id })
    .returning();
  return user.id;
}

async function seedAttribution(): Promise<{
  affiliateCodeId: string;
  affiliateUserId: string;
  affiliateCode: string;
  markupPercent: number;
}> {
  const affiliateUserId = await seedUser("Affiliate");
  const [affiliate] = await dbWrite
    .insert(affiliateCodes)
    .values({
      user_id: affiliateUserId,
      code: uniq("PARTNER"),
      markup_percent: "10.00",
    })
    .returning();
  return {
    affiliateCodeId: affiliate.id,
    affiliateUserId,
    affiliateCode: affiliate.code,
    markupPercent: 0.1,
  };
}

function reservationMetadata(
  sourceId: string,
  attribution: Awaited<ReturnType<typeof seedAttribution>>,
): Record<string, unknown> {
  return {
    affiliatePayout: {
      version: 1,
      sourceId,
      attribution,
      model: "openai/test-model",
    },
  };
}

function payoutLedgerMetadata(
  attribution: Awaited<ReturnType<typeof seedAttribution>>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    affiliatePayoutVersion: 1,
    affiliateCodeId: attribution.affiliateCodeId,
    affiliateCode: attribution.affiliateCode,
    model: "openai/test-model",
    actualTotalCost: "1.100000",
    collectedTotalCost: "1.100000",
    ...overrides,
  };
}

async function balance(userId: string): Promise<number> {
  const row = await dbWrite.query.redeemableEarnings.findFirst({
    where: eq(redeemableEarnings.user_id, userId),
  });
  return Number(row?.available_balance ?? 0);
}

beforeAll(async () => {
  try {
    payoutService = await import("../affiliate-payout-outbox");
    ({ redeemableEarningsService } = await import("../redeemable-earnings"));
    ({ creditsService } = await import("../credits"));
    const schema = {
      organizations,
      organizationBalanceRevisionSequence,
      users,
      affiliateCodes,
      affiliatePayoutOutbox,
      creditTransactions,
      redeemableEarnings,
      redeemableEarningsLedger,
      redeemedEarningsTracking,
      earningsSourceEnum,
      ledgerEntryTypeEnum,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    // pushSchema derives DDL from the drizzle schema, which cannot express the
    // 0177 balance-revision trigger. Apply the real migration file (its
    // statements are IF NOT EXISTS / OR REPLACE safe on top of pushSchema) so
    // the fenced settlement is proven against the same trigger production
    // deploys, and a real credit_balance debit advances balance_revision.
    const migration0177 = readFileSync(
      join(import.meta.dir, "../../../db/migrations/0177_organization_balance_revision.sql"),
      "utf8",
    );
    for (const statement of migration0177.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await dbWrite.execute(trimmed);
    }
  } catch (error) {
    pgliteReady = false;
    console.error("[affiliate-payout-outbox.test] PGlite schema initialization failed", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  try {
    await closeDatabaseConnectionsForTests();
  } finally {
    if (originalCacheEnabled === undefined) delete process.env.CACHE_ENABLED;
    else process.env.CACHE_ENABLED = originalCacheEnabled;
  }
});

describe("affiliate payout outbox", () => {
  test("pglite applied (loud, never a silent skip)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("lost ledger acknowledgement retries one globally keyed payout", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const sourceId = uniq("affiliate-request");
    await dbWrite.transaction((tx) =>
      payoutService.enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: reservationMetadata(sourceId, attribution),
        actualTotalCost: 1.1,
        collectedTotalCost: 1.1,
      }),
    );

    const originalAdd = redeemableEarningsService.addEarnings.bind(redeemableEarningsService);
    let loseAcknowledgement = true;
    const addSpy = spyOn(redeemableEarningsService, "addEarnings").mockImplementation(
      async (params) => {
        const result = await originalAdd(params);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("simulated affiliate ledger acknowledgement loss");
        }
        return result;
      },
    );
    try {
      await expect(payoutService.processAffiliatePayoutBySource(sourceId)).rejects.toThrow(
        "simulated affiliate ledger acknowledgement loss",
      );
      await expect(payoutService.processAffiliatePayoutBySource(sourceId)).resolves.toMatchObject({
        processed: true,
      });
    } finally {
      addSpy.mockRestore();
    }

    expect(await balance(attribution.affiliateUserId)).toBeCloseTo(0.1, 6);
    const [outbox] = await dbWrite
      .select()
      .from(affiliatePayoutOutbox)
      .where(eq(affiliatePayoutOutbox.source_id, sourceId));
    expect(outbox.processed_at).not.toBeNull();
    expect(Number(outbox.attempts)).toBe(1);
    const ledgerRows = await dbWrite
      .select()
      .from(redeemableEarningsLedger)
      .where(eq(redeemableEarningsLedger.id, outbox.ledger_entry_id!));
    expect(ledgerRows).toHaveLength(1);
    expect(outbox.ledger_entry_id).toBe(ledgerRows[0].id);
  });

  test("credit reservation settlement atomically creates the payout intent", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const [payerOrg] = await dbWrite
      .insert(organizations)
      .values({ name: "Payer", slug: uniq("payer"), credit_balance: "10.000000" })
      .returning();
    const [payer] = await dbWrite
      .insert(users)
      .values({ steward_user_id: uniq("payer-u"), organization_id: payerOrg.id })
      .returning();
    const sourceId = uniq("affiliate-reservation");
    const reservation = await creditsService.reserve({
      organizationId: payerOrg.id,
      userId: payer.id,
      description: "affiliate inference",
      amount: 1.1,
      metadata: reservationMetadata(sourceId, attribution),
    });

    expect(
      await dbWrite.query.affiliatePayoutOutbox.findFirst({
        where: eq(affiliatePayoutOutbox.source_id, sourceId),
      }),
    ).toBeUndefined();
    await reservation.reconcile(1.1);
    const row = await dbWrite.query.affiliatePayoutOutbox.findFirst({
      where: eq(affiliatePayoutOutbox.source_id, sourceId),
    });
    expect(Number(row?.amount)).toBeCloseTo(0.1, 6);

    await payoutService.processAffiliatePayoutBySource(sourceId);
    expect(await balance(attribution.affiliateUserId)).toBeCloseTo(0.1, 6);
    const [updatedPayer] = await dbWrite
      .select({ balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, payerOrg.id));
    expect(Number(updatedPayer.balance)).toBeCloseTo(8.9, 6);
  });

  test("code ownership changes cannot redirect an enqueued payout", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const successorUserId = await seedUser("Successor");
    const sourceId = uniq("affiliate-owner-transfer");
    await dbWrite.transaction((tx) =>
      payoutService.enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: reservationMetadata(sourceId, attribution),
        actualTotalCost: 2.2,
        collectedTotalCost: 2.2,
      }),
    );
    await dbWrite
      .update(affiliateCodes)
      .set({ user_id: successorUserId })
      .where(eq(affiliateCodes.id, attribution.affiliateCodeId));

    await payoutService.processAffiliatePayoutBySource(sourceId);

    expect(await balance(attribution.affiliateUserId)).toBeCloseTo(0.2, 6);
    expect(await balance(successorUserId)).toBe(0);
  });

  test("uncollected overage only enqueues affiliate markup actually collected", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const sourceId = uniq("affiliate-partial");
    const row = await dbWrite.transaction((tx) =>
      payoutService.enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: reservationMetadata(sourceId, attribution),
        actualTotalCost: 1.1,
        collectedTotalCost: 1.05,
      }),
    );
    expect(Number(row?.amount)).toBeCloseTo(0.05, 6);
    await payoutService.processAffiliatePayoutBySource(sourceId);
    expect(await balance(attribution.affiliateUserId)).toBeCloseTo(0.05, 6);
  });

  test("fractional payout precision always rounds down and never overpays", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const sourceId = uniq("affiliate-round-down");
    const row = await dbWrite.transaction((tx) =>
      payoutService.enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: reservationMetadata(sourceId, attribution),
        actualTotalCost: 0.00165,
        collectedTotalCost: 0.00165,
      }),
    );

    expect(Number(row?.amount)).toBe(0.0001);
    await payoutService.processAffiliatePayoutBySource(sourceId);
    expect(await balance(attribution.affiliateUserId)).toBe(0.0001);
  });

  test("refused deferred hold atomically collects a partial charge and payout", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const [payerOrg] = await dbWrite
      .insert(organizations)
      .values({ name: "Fallback payer", slug: uniq("fallback-payer"), credit_balance: "1.050000" })
      .returning();
    const [payer] = await dbWrite
      .insert(users)
      .values({ steward_user_id: uniq("fallback-u"), organization_id: payerOrg.id })
      .returning();
    const sourceId = uniq("affiliate-fallback-partial");
    const requestId = uniq("fallback-request");
    const params = {
      organizationId: payerOrg.id,
      userId: payer.id,
      requestId,
      model: "openai/test-model",
      provider: "openai",
      billingSource: "cloud",
      actualCost: 1.1,
      reservationMetadata: reservationMetadata(sourceId, attribution),
    };

    const first = await creditsService.collectAffiliateInferenceFallback(params);
    const replay = await creditsService.collectAffiliateInferenceFallback(params);
    expect(first).toMatchObject({
      reservedAmount: 1.05,
      actualCost: 1.1,
      adjustmentType: "uncollected_overage",
    });
    expect(replay.settlementTransactionIds).toEqual(first.settlementTransactionIds);

    const [outbox] = await dbWrite
      .select()
      .from(affiliatePayoutOutbox)
      .where(eq(affiliatePayoutOutbox.source_id, sourceId));
    expect(Number(outbox.amount)).toBeCloseTo(0.05, 6);
    const [updatedPayer] = await dbWrite
      .select({ balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, payerOrg.id));
    expect(Number(updatedPayer.balance)).toBe(0);
    await payoutService.processAffiliatePayoutBySource(sourceId);
    expect(await balance(attribution.affiliateUserId)).toBeCloseTo(0.05, 6);
  });

  test("fenced affiliate settlement publishes its committed debit result without a balance readback", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const [payerOrg] = await dbWrite
      .insert(organizations)
      .values({
        name: "Affiliate fenced handoff payer",
        slug: uniq("affiliate-fenced-handoff"),
        credit_balance: "1.000000",
      })
      .returning();
    const [payer] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: uniq("affiliate-fenced-user"),
        organization_id: payerOrg.id,
      })
      .returning();
    const { readOrgBalanceHint, writeOrgBalanceHint } = await import("../inference-auth-cache");
    const initial = await creditsService.getOrganizationBalanceSnapshot(payerOrg.id);
    await writeOrgBalanceHint(payerOrg.id, initial.balanceUsd, Date.now(), initial.revision);

    // The settlement path must publish the atomic debit's returned
    // balance/revision and issue NO balance readback. Count every snapshot read
    // and pause on the fence publication instead of the removed readback.
    const snapshotSpy = spyOn(creditsService, "getOrganizationBalanceSnapshot");
    const publicationStarted = Promise.withResolvers<void>();
    const releasePublication = Promise.withResolvers<void>();
    const inferenceBalanceFence = {
      lowerCommittedBalance: mock(async () => undefined),
      publishAuthoritativeBalance: mock(async () => {
        publicationStarted.resolve();
        await releasePublication.promise;
      }),
    };
    const params = {
      organizationId: payerOrg.id,
      userId: payer.id,
      requestId: uniq("affiliate-fenced-request"),
      model: "openai/test-model",
      provider: "openai",
      billingSource: "cloud",
      actualCost: 0.9,
      reservationMetadata: reservationMetadata(uniq("affiliate-fenced-source"), attribution),
      preserveInferenceBalanceHint: true,
      inferenceBalanceFence,
    };

    try {
      const settlement = creditsService.collectAffiliateInferenceFallback(params);
      await publicationStarted.promise;
      expect(inferenceBalanceFence.lowerCommittedBalance).toHaveBeenCalledWith(
        0.1,
        expect.stringMatching(/^(0|[1-9]\d*)$/),
      );

      // The debit committed and its authoritative publication is already in
      // flight, yet the settlement never issued a balance snapshot read. A
      // concurrent admission sees the committed lower balance, not the old $1
      // projection and not an absent warming key.
      expect(await readOrgBalanceHint(payerOrg.id)).toMatchObject({
        balanceUsd: 0.1,
        balanceRevision: initial.revision,
      });
      expect(snapshotSpy).not.toHaveBeenCalled();

      releasePublication.resolve();
      await expect(settlement).resolves.toMatchObject({
        actualCost: 0.9,
        collectedAmount: 0.9,
        adjustmentType: "none",
      });

      // The debit advanced the revision atomically. The published balance and
      // revision come straight from that transaction result: the lower and the
      // publish must carry the same committed revision, and it must be strictly
      // newer than the pre-debit revision.
      const publishCall = inferenceBalanceFence.publishAuthoritativeBalance.mock.calls[0] as [
        number,
        string,
      ];
      const committedRevision = publishCall[1];
      expect(publishCall[0]).toBeCloseTo(0.1, 6);
      expect(BigInt(committedRevision) > BigInt(initial.revision)).toBe(true);
      expect(inferenceBalanceFence.lowerCommittedBalance).toHaveBeenLastCalledWith(
        0.1,
        committedRevision,
      );
      const published = await readOrgBalanceHint(payerOrg.id);
      expect(published?.balanceUsd).toBeCloseTo(0.1, 6);
      expect(published?.balanceRevision).toBe(committedRevision);
      // Zero balance readbacks across the entire settlement.
      expect(snapshotSpy).not.toHaveBeenCalled();
    } finally {
      releasePublication.resolve();
      snapshotSpy.mockRestore();
    }

    // The published revision matches the true authoritative DB revision,
    // confirming the transaction result was itself authoritative.
    const authoritative = await creditsService.getOrganizationBalanceSnapshot(payerOrg.id);
    expect((await readOrgBalanceHint(payerOrg.id))?.balanceRevision).toBe(authoritative.revision);

    // Alarm/live replay of the same identity retains a present authoritative
    // hint instead of repeating the post-stream billing_cache_warming flap, and
    // still performs no balance readback.
    const replaySpy = spyOn(creditsService, "getOrganizationBalanceSnapshot");
    try {
      await creditsService.collectAffiliateInferenceFallback(params);
      expect(replaySpy).not.toHaveBeenCalled();
    } finally {
      replaySpy.mockRestore();
    }
    expect((await readOrgBalanceHint(payerOrg.id))?.balanceUsd).toBeCloseTo(0.1, 6);
  });

  test("concurrent newer-revision debit cannot leak into a fenced affiliate publication", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const [payerOrg] = await dbWrite
      .insert(organizations)
      .values({
        name: "Affiliate revision-fence payer",
        slug: uniq("affiliate-revision-fence"),
        credit_balance: "1.000000",
      })
      .returning();
    const [payer] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: uniq("affiliate-revision-user"),
        organization_id: payerOrg.id,
      })
      .returning();
    const { writeOrgBalanceHint } = await import("../inference-auth-cache");
    // Bind the real snapshot before spying so the test's own reads never count
    // against the settlement's must-be-zero readback budget.
    const originalSnapshot = creditsService.getOrganizationBalanceSnapshot.bind(creditsService);
    const initial = await originalSnapshot(payerOrg.id);
    await writeOrgBalanceHint(payerOrg.id, initial.balanceUsd, Date.now(), initial.revision);

    const snapshotSpy = spyOn(creditsService, "getOrganizationBalanceSnapshot");
    const publicationStarted = Promise.withResolvers<void>();
    const releasePublication = Promise.withResolvers<void>();
    const inferenceBalanceFence = {
      lowerCommittedBalance: mock(async () => undefined),
      publishAuthoritativeBalance: mock(async () => {
        publicationStarted.resolve();
        await releasePublication.promise;
      }),
    };
    const params = {
      organizationId: payerOrg.id,
      userId: payer.id,
      requestId: uniq("affiliate-revision-request"),
      model: "openai/test-model",
      provider: "openai",
      billingSource: "cloud",
      actualCost: 0.9,
      reservationMetadata: reservationMetadata(uniq("affiliate-revision-source"), attribution),
      preserveInferenceBalanceHint: true,
      inferenceBalanceFence,
    };

    try {
      const settlement = creditsService.collectAffiliateInferenceFallback(params);
      await publicationStarted.promise;
      const committedRevision = (
        inferenceBalanceFence.lowerCommittedBalance.mock.calls[0] as [number, string]
      )[1];

      // An unrelated debit commits while the fenced publication is paused,
      // advancing the organization to a strictly newer revision and a different
      // balance. A balance readback would observe this newer state; the pinned
      // transaction result must not.
      await dbWrite
        .update(organizations)
        .set({ credit_balance: "0.030000" })
        .where(eq(organizations.id, payerOrg.id));
      const concurrent = await originalSnapshot(payerOrg.id);
      expect(BigInt(concurrent.revision) > BigInt(committedRevision)).toBe(true);
      expect(concurrent.balanceUsd).toBeCloseTo(0.03, 6);

      releasePublication.resolve();
      await settlement;

      // The publication carried this debit's own committed balance/revision,
      // never the concurrent newer revision or its 0.03 balance.
      expect(inferenceBalanceFence.publishAuthoritativeBalance).toHaveBeenCalledWith(
        0.1,
        committedRevision,
      );
      expect(inferenceBalanceFence.publishAuthoritativeBalance).not.toHaveBeenCalledWith(
        concurrent.balanceUsd,
        concurrent.revision,
      );
      // Removing the readback is precisely what keeps the concurrent revision
      // out of the publication: the settlement issued zero snapshot reads.
      expect(snapshotSpy).not.toHaveBeenCalled();
    } finally {
      releasePublication.resolve();
      snapshotSpy.mockRestore();
    }
  });

  test("alarm and late-settlement races retain the first committed affiliate amount", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const [payerOrg] = await dbWrite
      .insert(organizations)
      .values({
        name: "Affiliate replay payer",
        slug: uniq("affiliate-replay-payer"),
        credit_balance: "5.000000",
      })
      .returning();
    const [payer] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: uniq("affiliate-replay-user"),
        organization_id: payerOrg.id,
      })
      .returning();
    const sourceId = uniq("affiliate-replay-source");
    const requestId = uniq("affiliate-replay-request");
    const shared = {
      organizationId: payerOrg.id,
      userId: payer.id,
      requestId,
      model: "openai/test-model",
      provider: "openai",
      billingSource: "cloud",
      reservationMetadata: reservationMetadata(sourceId, attribution),
    };

    const alarm = await creditsService.collectAffiliateInferenceFallback({
      ...shared,
      actualCost: 1.1,
    });
    const late = await creditsService.collectAffiliateInferenceFallback({
      ...shared,
      actualCost: 0.9,
    });

    expect(alarm).toMatchObject({
      reservedAmount: 1.1,
      actualCost: 1.1,
      collectedAmount: 1.1,
      adjustmentType: "none",
    });
    expect(late).toEqual(alarm);
    const debitRows = await dbWrite.execute(
      `SELECT count(*)::int AS count
       FROM credit_transactions
       WHERE stripe_payment_intent_id =
         'inference-debit:${payerOrg.id}:${requestId}'`,
    );
    expect(Number((debitRows.rows[0] as { count: number }).count)).toBe(1);
    const outboxRows = await dbWrite
      .select()
      .from(affiliatePayoutOutbox)
      .where(eq(affiliatePayoutOutbox.source_id, sourceId));
    expect(outboxRows).toHaveLength(1);
  });

  test("deleted affiliate code cannot unwind a pinned full fallback payout", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const [payerOrg] = await dbWrite
      .insert(organizations)
      .values({
        name: "Deleted-code payer",
        slug: uniq("deleted-code"),
        credit_balance: "2.000000",
      })
      .returning();
    const [payer] = await dbWrite
      .insert(users)
      .values({ steward_user_id: uniq("deleted-code-u"), organization_id: payerOrg.id })
      .returning();
    await dbWrite.delete(affiliateCodes).where(eq(affiliateCodes.id, attribution.affiliateCodeId));
    const sourceId = uniq("affiliate-deleted-code");

    const result = await creditsService.collectAffiliateInferenceFallback({
      organizationId: payerOrg.id,
      userId: payer.id,
      requestId: uniq("deleted-code-request"),
      model: "openai/test-model",
      provider: "openai",
      billingSource: "cloud",
      actualCost: 1.1,
      reservationMetadata: reservationMetadata(sourceId, attribution),
    });
    expect(result).toMatchObject({
      reservedAmount: 1.1,
      actualCost: 1.1,
      adjustmentType: "none",
    });
    await payoutService.processAffiliatePayoutBySource(sourceId);
    expect(await balance(attribution.affiliateUserId)).toBeCloseTo(0.1, 6);
  });

  test("sub-ledger-unit markup is not recorded as a successful zero payout", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const sourceId = uniq("affiliate-dust");
    const row = await dbWrite.transaction((tx) =>
      payoutService.enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: reservationMetadata(sourceId, attribution),
        actualTotalCost: 0.000011,
        collectedTotalCost: 0.000011,
      }),
    );
    expect(row).toBeNull();
    expect(
      await dbWrite.query.affiliatePayoutOutbox.findFirst({
        where: eq(affiliatePayoutOutbox.source_id, sourceId),
      }),
    ).toBeUndefined();
  });

  test("blank source identities fail at both service and database boundaries", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    await expect(
      dbWrite.transaction((tx) =>
        payoutService.enqueueCollectedAffiliatePayout(tx, {
          reservationMetadata: reservationMetadata(" \t ", attribution),
          actualTotalCost: 1.1,
          collectedTotalCost: 1.1,
        }),
      ),
    ).rejects.toThrow("required settlement fields are missing");
    await expect(
      dbWrite.transaction((tx) =>
        payoutService.enqueueCollectedAffiliatePayout(tx, {
          reservationMetadata: reservationMetadata(` ${uniq("edge-space")}`, attribution),
          actualTotalCost: 1.1,
          collectedTotalCost: 1.1,
        }),
      ),
    ).rejects.toThrow("required settlement fields are missing");
    await expect(payoutService.processAffiliatePayoutBySource(" \t ")).rejects.toThrow(
      "source id must not be blank",
    );
    await expect(
      (async () => {
        await dbWrite
          .insert(affiliatePayoutOutbox)
          .values({
            source_id: " \t ",
            affiliate_code_id: attribution.affiliateCodeId,
            affiliate_user_id: attribution.affiliateUserId,
            amount: "0.1000",
            description: "invalid blank identity",
            metadata: {},
          })
          .returning();
      })(),
    ).rejects.toThrow();
  });

  test("deduplicated ledger replay validates owner, amount, description, and metadata", async () => {
    if (!pgliteReady) return;
    const cases = [
      {
        label: "owner",
        amount: 0.1,
        description: "Affiliate markup earnings from model: openai/test-model",
        metadataOverrides: {},
        useDifferentOwner: true,
        mismatch: "affiliate owner differs",
      },
      {
        label: "amount",
        amount: 0.2,
        description: "Affiliate markup earnings from model: openai/test-model",
        metadataOverrides: {},
        useDifferentOwner: false,
        mismatch: "amount differs",
      },
      {
        label: "description",
        amount: 0.1,
        description: "wrong payout description",
        metadataOverrides: {},
        useDifferentOwner: false,
        mismatch: "description differs",
      },
      {
        label: "metadata",
        amount: 0.1,
        description: "Affiliate markup earnings from model: openai/test-model",
        metadataOverrides: { collectedTotalCost: "1.000000" },
        useDifferentOwner: false,
        mismatch: "metadata differs",
      },
    ] as const;

    for (const replay of cases) {
      const attribution = await seedAttribution();
      const sourceId = uniq(`affiliate-ledger-${replay.label}`);
      await dbWrite.transaction((tx) =>
        payoutService.enqueueCollectedAffiliatePayout(tx, {
          reservationMetadata: reservationMetadata(sourceId, attribution),
          actualTotalCost: 1.1,
          collectedTotalCost: 1.1,
        }),
      );
      const ledgerOwner = replay.useDifferentOwner
        ? await seedUser("Conflicting affiliate owner")
        : attribution.affiliateUserId;
      await redeemableEarningsService.addEarnings({
        userId: ledgerOwner,
        amount: replay.amount,
        source: "affiliate",
        sourceId,
        description: replay.description,
        metadata: payoutLedgerMetadata(attribution, replay.metadataOverrides),
        dedupeBySourceId: true,
      });

      await expect(payoutService.processAffiliatePayoutBySource(sourceId)).rejects.toThrow(
        replay.mismatch,
      );
      const row = await dbWrite.query.affiliatePayoutOutbox.findFirst({
        where: eq(affiliatePayoutOutbox.source_id, sourceId),
      });
      expect(row?.processed_at).toBeNull();
      expect(Number(row?.attempts)).toBe(1);
    }
  });

  test("two concurrent processors report exactly one completed transition", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const sourceId = uniq("affiliate-concurrent");
    await dbWrite.transaction((tx) =>
      payoutService.enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: reservationMetadata(sourceId, attribution),
        actualTotalCost: 1.1,
        collectedTotalCost: 1.1,
      }),
    );

    const results = await Promise.all([
      payoutService.processAffiliatePayoutBySource(sourceId),
      payoutService.processAffiliatePayoutBySource(sourceId),
    ]);
    expect(results.filter((result) => result.processed)).toHaveLength(1);
    expect(results.filter((result) => !result.processed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.ledgerEntryId)).size).toBe(1);
    expect(await balance(attribution.affiliateUserId)).toBe(0.1);
  });

  test("an already-processed outbox replay revalidates its immutable ledger projection", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const sourceId = uniq("affiliate-processed-replay");
    await dbWrite.transaction((tx) =>
      payoutService.enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: reservationMetadata(sourceId, attribution),
        actualTotalCost: 1.1,
        collectedTotalCost: 1.1,
      }),
    );
    const processed = await payoutService.processAffiliatePayoutBySource(sourceId);
    await dbWrite
      .update(redeemableEarningsLedger)
      .set({ description: "tampered projection" })
      .where(eq(redeemableEarningsLedger.id, processed.ledgerEntryId));

    await expect(payoutService.processAffiliatePayoutBySource(sourceId)).rejects.toThrow(
      "Affiliate payout replay mismatch",
    );
  });

  test("a pending payout prevents beneficiary deletion instead of erasing the liability", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const sourceId = uniq("affiliate-delete-restrict");
    await dbWrite.transaction((tx) =>
      payoutService.enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: reservationMetadata(sourceId, attribution),
        actualTotalCost: 1.1,
        collectedTotalCost: 1.1,
      }),
    );

    await expect(
      (async () => {
        await dbWrite.delete(users).where(eq(users.id, attribution.affiliateUserId));
      })(),
    ).rejects.toThrow();
    const pending = await dbWrite.query.affiliatePayoutOutbox.findFirst({
      where: eq(affiliatePayoutOutbox.source_id, sourceId),
    });
    expect(pending?.affiliate_user_id).toBe(attribution.affiliateUserId);
    expect(pending?.processed_at).toBeNull();
  });

  test("an exact enqueue replay returns the original single intent", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const sourceId = uniq("affiliate-exact-replay");
    const enqueue = () =>
      dbWrite.transaction((tx) =>
        payoutService.enqueueCollectedAffiliatePayout(tx, {
          reservationMetadata: reservationMetadata(sourceId, attribution),
          actualTotalCost: 1.1,
          collectedTotalCost: 1.1,
        }),
      );

    const first = await enqueue();
    const replay = await enqueue();
    expect(replay?.id).toBe(first?.id);
    const rows = await dbWrite
      .select()
      .from(affiliatePayoutOutbox)
      .where(eq(affiliatePayoutOutbox.source_id, sourceId));
    expect(rows).toHaveLength(1);
  });

  test("a conflicting replay fails the surrounding transaction", async () => {
    if (!pgliteReady) return;
    const attribution = await seedAttribution();
    const sourceId = uniq("affiliate-conflict");
    await dbWrite.transaction((tx) =>
      payoutService.enqueueCollectedAffiliatePayout(tx, {
        reservationMetadata: reservationMetadata(sourceId, attribution),
        actualTotalCost: 1.1,
        collectedTotalCost: 1.05,
      }),
    );
    await expect(
      dbWrite.transaction((tx) =>
        payoutService.enqueueCollectedAffiliatePayout(tx, {
          reservationMetadata: reservationMetadata(sourceId, attribution),
          actualTotalCost: 2.2,
          collectedTotalCost: 2.05,
        }),
      ),
    ).rejects.toThrow("Affiliate payout replay mismatch");
  });
});

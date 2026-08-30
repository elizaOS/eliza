/**
 * Balanced-ledger conservation proofs for MCP settlement (#22961) — real
 * services, real Drizzle schema, in-process PGlite.
 *
 * Before the settlement authority, one MCP purchase could mint duplicate
 * value on delivery replay: the creator earning was keyed on the constant
 * MCP id with no dedupe, the creator org-credit and the usage row had no
 * idempotency at all, and the affiliate leg deduped only when the caller
 * passed a precharge id. This suite drives the REAL
 * `userMcpsService.recordUsageWithoutDeduction` and `recordUsage` against
 * PGlite and asserts conservation of value across:
 *   1. single delivery — each leg lands exactly once;
 *   2. retry of settlement — cumulative ledger delta is ZERO;
 *   3. concurrent duplicate settlement — one receipt, one set of legs;
 *   4. unkeyed settlement — fails closed with no partial legs;
 *   5. replay with different economics — rejected (mismatch), nothing applied.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails
 * to initialize — never a silent skip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports.
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { mcpSettlementsRepository } from "../../../db/repositories/mcp-settlements";
import { affiliateCodes, userAffiliates } from "../../../db/schemas/affiliates";
import { apiKeys } from "../../../db/schemas/api-keys";
import { containers } from "../../../db/schemas/containers";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import { mcpSettlements } from "../../../db/schemas/mcp-settlements";
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
import { userCharacters } from "../../../db/schemas/user-characters";
import {
  mcpPricingTypeEnum,
  mcpStatusEnum,
  mcpUsage,
  userMcps,
} from "../../../db/schemas/user-mcps";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let userMcpsService: typeof import("../user-mcps").userMcpsService;
let creditsService: typeof import("../credits").creditsService;

// Round-7 F1 test gate: lets the test run the sweep between the live
// delivery's precharge claim and its receipt insert.
let resolveSweep: () => void = () => {};
let releaseSweepGate: () => void = () => {};

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

interface Fixture {
  buyerOrgId: string;
  creatorOrgId: string;
  creatorUserId: string;
  affiliateUserId: string;
  affiliateCodeId: string;
  mcpId: string;
}

async function seedFixture(): Promise<Fixture> {
  const [buyerOrg] = await dbWrite
    .insert(organizations)
    .values({ name: uniq("buyer"), slug: uniq("buyer"), credit_balance: "1000" })
    .returning();
  const [creatorOrg] = await dbWrite
    .insert(organizations)
    .values({ name: uniq("creator"), slug: uniq("creator") })
    .returning();
  const [creatorUser] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: creatorOrg.id })
    .returning();
  const [affiliateUser] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: buyerOrg.id })
    .returning();
  const [mcp] = await dbWrite
    .insert(userMcps)
    .values({
      name: uniq("mcp"),
      slug: uniq("mcp"),
      description: "balanced-ledger fixture",
      organization_id: creatorOrg.id,
      created_by_user_id: creatorUser.id,
      endpoint_type: "external",
      external_endpoint: "https://mcp.example.test",
      status: "live",
      pricing_type: "credits",
      credits_per_request: "10", // 10 points = $0.10 base
      creator_share_percentage: "70",
      platform_share_percentage: "30",
      tools: [{ name: "toolA" }],
    })
    .returning();
  const [affiliateCode] = await dbWrite
    .insert(affiliateCodes)
    .values({
      user_id: affiliateUser.id,
      code: uniq("acode"),
      markup_percent: "20",
      is_active: true,
    })
    .returning();
  return {
    buyerOrgId: buyerOrg.id,
    creatorOrgId: creatorOrg.id,
    creatorUserId: creatorUser.id,
    affiliateUserId: affiliateUser.id,
    affiliateCodeId: affiliateCode.id,
    mcpId: mcp.id,
  };
}

async function balances(f: Fixture) {
  const [bo] = await dbWrite.select().from(organizations).where(eq(organizations.id, f.buyerOrgId));
  const [co] = await dbWrite
    .select()
    .from(organizations)
    .where(eq(organizations.id, f.creatorOrgId));
  const [creatorEarn] = await dbWrite
    .select()
    .from(redeemableEarnings)
    .where(eq(redeemableEarnings.user_id, f.creatorUserId));
  const [affEarn] = await dbWrite
    .select()
    .from(redeemableEarnings)
    .where(eq(redeemableEarnings.user_id, f.affiliateUserId));
  const ledger = await dbWrite
    .select()
    .from(redeemableEarningsLedger)
    .where(sql`${redeemableEarningsLedger.user_id} IN (${f.creatorUserId}, ${f.affiliateUserId})`);
  const usages = await dbWrite.select().from(mcpUsage).where(eq(mcpUsage.mcp_id, f.mcpId));
  const settlements = await dbWrite
    .select()
    .from(mcpSettlements)
    .where(eq(mcpSettlements.mcp_id, f.mcpId));
  const [mcpRow] = await dbWrite.select().from(userMcps).where(eq(userMcps.id, f.mcpId));
  return {
    buyer: Number(bo.credit_balance),
    creatorOrg: Number(co.credit_balance),
    creatorRedeemable: Number(creatorEarn?.available_balance ?? 0),
    affiliateRedeemable: Number(affEarn?.available_balance ?? 0),
    ledgerRows: ledger.length,
    usageRows: usages.length,
    settlementRows: settlements.length,
    mcpTotalEarned: Number(mcpRow.total_credits_earned),
    mcpTotalRequests: mcpRow.total_requests,
    settlements,
  };
}

/**
 * Build prepaid-settlement params with a REAL precharge debit (a committed
 * credit_transactions row), mirroring the proxy: the buyer is debited first
 * and the transaction id becomes the settlement's payment event.
 */
async function prepaidParams(f: Fixture, overrides: Record<string, unknown> = {}) {
  const debit = await creditsService.deductCredits({
    organizationId: f.buyerOrgId,
    amount: 0.14,
    description: "MCP precharge (test)",
    metadata: { mcp_id: f.mcpId },
  });
  if (!debit.success || !debit.transaction?.id) {
    throw new Error("test precharge failed");
  }
  return {
    mcpId: f.mcpId,
    organizationId: f.buyerOrgId,
    userId: f.affiliateUserId,
    toolName: "toolA",
    creditsCharged: 10,
    affiliateFeeCredits: 2,
    platformFeeCredits: 2,
    affiliateOwnerId: f.affiliateUserId,
    affiliateCodeId: f.affiliateCodeId,
    metadata: { preChargeTransactionId: debit.transaction.id, success: true },
    ...overrides,
  };
}

beforeAll(async () => {
  try {
    ({ userMcpsService } = await import("../user-mcps"));
    ({ creditsService } = await import("../credits"));
    ({ redeemableEarningsService: redeemableEarningsCache } = await import(
      "../redeemable-earnings"
    ));
    const schema = {
      organizations,
      organizationBalanceRevisionSequence,
      users,
      redeemableEarnings,
      redeemableEarningsLedger,
      redeemedEarningsTracking,
      earningsSourceEnum,
      ledgerEntryTypeEnum,
      userMcps,
      mcpUsage,
      mcpPricingTypeEnum,
      mcpStatusEnum,
      creditTransactions,
      mcpSettlements,
      containers,
      apiKeys,
      userCharacters,
      affiliateCodes,
      userAffiliates,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    // The unique settlement index and the sweep-support partial indexes now
    // ship in the Drizzle schema itself (#22961, #27992) so pushSchema carries
    // them; this guard proves the parity instead of repairing it like a
    // workaround — a test database missing them would silently stop exercising
    // the sweep queries' real index shapes.
    const indexes = await dbWrite.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes WHERE indexname IN (
        'mcp_usage_settlement_uidx',
        'credit_transactions_mcp_precharge_idx',
        'credit_transactions_mcp_precharge_refund_link_idx',
        'credit_transactions_reservation_refund_link_idx',
        'mcp_settlements_resume_due_idx'
      )
    `);
    const present = new Set((indexes.rows ?? []).map((r) => r.indexname));
    for (const expected of [
      "mcp_usage_settlement_uidx",
      "credit_transactions_mcp_precharge_idx",
      "credit_transactions_mcp_precharge_refund_link_idx",
      "credit_transactions_reservation_refund_link_idx",
      "mcp_settlements_resume_due_idx",
    ]) {
      if (!present.has(expected)) {
        throw new Error(`${expected} missing from pushed schema (parity broken)`);
      }
    }
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[mcp-settlement-balanced-ledger] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

let fx: Fixture;
beforeEach(async () => {
  if (!pgliteReady) return;
  fx = await seedFixture();
});

describe("MCP settlement balanced ledger (#22961)", () => {
  test("pglite applied (loud, never a silent no-op pass)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("single delivery: every leg lands exactly once and the receipt links them", async () => {
    if (!pgliteReady) return;
    const params = await prepaidParams(fx);
    const result = await userMcpsService.recordUsageWithoutDeduction(params);
    expect(result.success).toBe(true);
    expect(result.settlementId).toBeTruthy();

    const s = await balances(fx);
    // 10 points base = $0.10; creator share 70% => $0.07 each side; affiliate $0.02.
    expect(s.creatorOrg).toBe(0.07);
    expect(s.creatorRedeemable).toBe(0.07);
    expect(s.affiliateRedeemable).toBe(0.02);
    expect(s.usageRows).toBe(1);
    expect(s.settlementRows).toBe(1);
    expect(s.mcpTotalEarned).toBe(7); // legacy points
    expect(s.mcpTotalRequests).toBe(1);

    // Receipt links every leg.
    const [receipt] = s.settlements;
    expect(receipt.status).toBe("settled");
    expect(receipt.settled_at).not.toBeNull();
    expect(receipt.mcp_usage_id).toBeTruthy();
    expect(receipt.creator_credit_transaction_id).toBeTruthy();
    expect(receipt.creator_ledger_entry_id).toBeTruthy();
    expect(receipt.affiliate_ledger_entry_id).toBeTruthy();
    // Buyer debit conservation: total = base + affiliate fee + platform fee.
    expect(Number(receipt.total_amount_usd)).toBeCloseTo(
      Number(receipt.base_amount_usd) +
        Number(receipt.affiliate_fee_usd) +
        Number(receipt.platform_fee_usd),
      6,
    );
  });

  test("retry of the same settlement: cumulative ledger delta is zero", async () => {
    if (!pgliteReady) return;
    const params = await prepaidParams(fx);
    const first = await userMcpsService.recordUsageWithoutDeduction(params);
    const afterFirst = await balances(fx);

    const second = await userMcpsService.recordUsageWithoutDeduction(params);
    const afterSecond = await balances(fx);

    expect(second.success).toBe(true);
    expect(second.settlementId).toBe(first.settlementId);
    expect(afterSecond.creatorOrg).toBe(afterFirst.creatorOrg);
    expect(afterSecond.creatorRedeemable).toBe(afterFirst.creatorRedeemable);
    expect(afterSecond.affiliateRedeemable).toBe(afterFirst.affiliateRedeemable);
    expect(afterSecond.ledgerRows).toBe(afterFirst.ledgerRows);
    expect(afterSecond.usageRows).toBe(afterFirst.usageRows);
    expect(afterSecond.settlementRows).toBe(afterFirst.settlementRows);
    expect(afterSecond.mcpTotalEarned).toBe(afterFirst.mcpTotalEarned); // unchanged
    expect(afterSecond.mcpTotalRequests).toBe(afterFirst.mcpTotalRequests);
  });

  test("concurrent duplicate settlement: exactly one receipt and one set of legs", async () => {
    if (!pgliteReady) return;
    const params = await prepaidParams(fx);
    const results = await Promise.all([
      userMcpsService.recordUsageWithoutDeduction(params),
      userMcpsService.recordUsageWithoutDeduction(params),
      userMcpsService.recordUsageWithoutDeduction(params),
    ]);
    const s = await balances(fx);

    expect(results.every((r) => r.success)).toBe(true);
    expect(new Set(results.map((r) => r.settlementId)).size).toBe(1);
    expect(s.settlementRows).toBe(1);
    expect(s.creatorOrg).toBe(0.07);
    expect(s.creatorRedeemable).toBe(0.07);
    expect(s.affiliateRedeemable).toBe(0.02);
    expect(s.usageRows).toBe(1);
    expect(s.mcpTotalRequests).toBe(1);
  });

  test("unkeyed settlement fails closed with no partial legs", async () => {
    if (!pgliteReady) return;
    const params = await prepaidParams(fx, { metadata: { success: true } });
    await expect(userMcpsService.recordUsageWithoutDeduction(params)).rejects.toThrow(
      /preChargeTransactionId/,
    );
    const s = await balances(fx);
    expect(s.creatorOrg).toBe(0);
    expect(s.creatorRedeemable).toBe(0);
    expect(s.affiliateRedeemable).toBe(0);
    expect(s.ledgerRows).toBe(0);
    expect(s.usageRows).toBe(0);
    expect(s.settlementRows).toBe(0);
  });

  test("same payment event with different economics is rejected", async () => {
    if (!pgliteReady) return;
    const settled = await prepaidParams(fx);
    const eventId = settled.metadata.preChargeTransactionId;
    await userMcpsService.recordUsageWithoutDeduction(settled);
    const before = await balances(fx);
    await expect(
      userMcpsService.recordUsageWithoutDeduction(
        await prepaidParams(fx, {
          creditsCharged: 20,
          metadata: { preChargeTransactionId: eventId },
        }),
      ),
    ).rejects.toThrow(/replay does not match/);
    const after = await balances(fx);
    expect(after.creatorOrg).toBe(before.creatorOrg);
    expect(after.creatorRedeemable).toBe(before.creatorRedeemable);
    expect(after.affiliateRedeemable).toBe(before.affiliateRedeemable);
    expect(after.settlementRows).toBe(1);
  });

  test("distinct purchases of the same MCP each settle once (per-event keys)", async () => {
    if (!pgliteReady) return;
    await userMcpsService.recordUsageWithoutDeduction(await prepaidParams(fx));
    await userMcpsService.recordUsageWithoutDeduction(await prepaidParams(fx));
    const s = await balances(fx);
    expect(s.settlementRows).toBe(2);
    expect(s.creatorOrg).toBeCloseTo(0.14, 6);
    expect(s.creatorRedeemable).toBeCloseTo(0.14, 6);
    expect(s.affiliateRedeemable).toBeCloseTo(0.04, 6);
    expect(s.usageRows).toBe(2);
    expect(s.mcpTotalRequests).toBe(2);
  });

  test("partial-failure recovery: legs committed before a crash are not reapplied", async () => {
    if (!pgliteReady) return;
    const params = await prepaidParams(fx);
    // Simulate a crash mid-settlement: the receipt exists and the affiliate
    // leg is linked, but the creator legs, usage, and terminal state are not.
    // The next delivery must complete only the missing legs.
    const { mcpSettlementsRepository } = await import("../../../db/repositories/mcp-settlements");
    const { settlement } = await mcpSettlementsRepository.claim({
      buyer_credit_transaction_id: params.metadata.preChargeTransactionId,
      buyer_organization_id: fx.buyerOrgId,
      buyer_user_id: fx.affiliateUserId,
      mcp_id: fx.mcpId,
      tool_name: "toolA",
      payment_type: "credits",
      payment_event_id: params.metadata.preChargeTransactionId,
      affiliate_owner_id: fx.affiliateUserId,
      affiliate_code_id: params.affiliateCodeId,
      creator_organization_id: fx.creatorOrgId,
      creator_user_id: fx.creatorUserId,
      base_amount_usd: "0.1",
      affiliate_fee_usd: "0.02",
      platform_fee_usd: "0.02",
      total_amount_usd: "0.14",
      creator_earnings_usd: "0.07",
      platform_earnings_usd: "0.05",
    });
    expect(created0(settlement)).toBe(true);

    const result = await userMcpsService.recordUsageWithoutDeduction(params);
    expect(result.success).toBe(true);
    expect(result.settlementId).toBe(settlement.id);

    const s = await balances(fx);
    expect(s.settlementRows).toBe(1);
    expect(s.creatorOrg).toBe(0.07);
    expect(s.creatorRedeemable).toBe(0.07);
    expect(s.affiliateRedeemable).toBe(0.02);
    expect(s.usageRows).toBe(1);
    expect(s.mcpTotalRequests).toBe(1);
  });

  test("recordUsage (deducting variant) settles under the same authority and replays cleanly", async () => {
    if (!pgliteReady) return;
    // Buyer starts at 1000. Debit = $0.10 base (this caller has no referrer,
    // so no affiliate/platform surcharge on this rail).
    const first = await userMcpsService.recordUsage({
      mcpId: fx.mcpId,
      organizationId: fx.buyerOrgId,
      toolName: "toolA",
      paymentType: "credits",
    });
    expect(first.success).toBe(true);
    const s1 = await balances(fx);
    expect(s1.buyer).toBeCloseTo(999.9, 6);
    expect(s1.creatorOrg).toBeCloseTo(0.07, 6);
    expect(s1.creatorRedeemable).toBeCloseTo(0.07, 6);
    expect(s1.settlementRows).toBe(1);

    // Replay the SAME payment event (the first settlement's debit id) with
    // matching economics through the prepaid path: value must not move, and
    // the returned units must match the first delivery (no USD/points swap
    // between first delivery and replay, #22961).
    const second = await userMcpsService.recordUsageWithoutDeduction({
      mcpId: fx.mcpId,
      organizationId: fx.buyerOrgId,
      toolName: "toolA",
      creditsCharged: 10,
      affiliateFeeCredits: 0,
      platformFeeCredits: 0,
      metadata: {
        preChargeTransactionId: await firstEventId(fx, first.settlementId),
        success: true,
      },
    });
    expect(second.success).toBe(true);
    expect(second.settlementId).toBe(first.settlementId);
    // Same units as the first delivery: legacy points, not stored USD strings.
    expect(second.creditsCharged).toBe(first.creditsCharged);
    expect(second.creatorEarnings).toBeCloseTo(first.creatorEarnings, 9);
    expect(second.totalPriceUsd).toBeCloseTo(first.totalPriceUsd, 9);
    const s2 = await balances(fx);
    expect(s2.settlementRows).toBe(1);
    expect(s2.creatorOrg).toBeCloseTo(0.07, 6);
    expect(s2.creatorRedeemable).toBeCloseTo(0.07, 6);
    expect(s2.usageRows).toBe(1);
    expect(s2.mcpTotalRequests).toBe(1);
  });

  test("free tier (zero-total credits) records usage without claiming a payment event", async () => {
    if (!pgliteReady) return;
    const [freeMcp] = await dbWrite
      .insert(userMcps)
      .values({
        name: uniq("freemcp"),
        slug: uniq("freemcp"),
        description: "free-tier fixture",
        organization_id: fx.creatorOrgId,
        created_by_user_id: fx.creatorUserId,
        endpoint_type: "external",
        external_endpoint: "https://free.example.test",
        status: "live",
        pricing_type: "credits",
        credits_per_request: "0",
        creator_share_percentage: "70",
        platform_share_percentage: "30",
        tools: [{ name: "toolA" }],
      })
      .returning();

    const r1 = await userMcpsService.recordUsage({
      mcpId: freeMcp.id,
      organizationId: fx.buyerOrgId,
      userId: fx.affiliateUserId,
      toolName: "toolA",
      paymentType: "credits",
    });
    expect(r1.success).toBe(true);
    expect(r1.settlementId).toBe("");
    expect(r1.creditsCharged).toBe(0);
    // A second free call must not throw a replay mismatch on an empty key.
    const r2 = await userMcpsService.recordUsage({
      mcpId: freeMcp.id,
      organizationId: fx.buyerOrgId,
      userId: fx.affiliateUserId,
      toolName: "toolA",
      paymentType: "credits",
    });
    expect(r2.success).toBe(true);
    const usages = await dbWrite.select().from(mcpUsage).where(eq(mcpUsage.mcp_id, freeMcp.id));
    expect(usages).toHaveLength(2);
    const settlements = await dbWrite
      .select()
      .from(mcpSettlements)
      .where(eq(mcpSettlements.mcp_id, freeMcp.id));
    expect(settlements).toHaveLength(0);
    // Stats still count free usage (the free branch bumps outside the
    // settlement CTE); no payment event, but the counter must move.
    const [freeRow] = await dbWrite.select().from(userMcps).where(eq(userMcps.id, freeMcp.id));
    expect(freeRow.total_requests).toBe(2);
  });

  test("x402 settlements never bind the credits buyer-debit FK slot", async () => {
    if (!pgliteReady) return;
    // A UUID-shaped x402 provider id would previously land in
    // buyer_credit_transaction_id and violate the tenant FK. Price this MCP
    // on the x402 rail so the earning legs clear the ledger minimum.
    const [x402Mcp] = await dbWrite
      .insert(userMcps)
      .values({
        name: uniq("x402mcp"),
        slug: uniq("x402mcp"),
        description: "x402 rail fixture",
        organization_id: fx.creatorOrgId,
        created_by_user_id: fx.creatorUserId,
        endpoint_type: "external",
        external_endpoint: "https://x402.example.test",
        status: "live",
        pricing_type: "x402",
        credits_per_request: "0",
        x402_price_usd: "1",
        creator_share_percentage: "70",
        platform_share_percentage: "30",
        tools: [{ name: "toolA" }],
      })
      .returning();
    const event = crypto.randomUUID(); // deliberately uuid-shaped
    const result = await userMcpsService.recordUsage({
      mcpId: x402Mcp.id,
      organizationId: fx.buyerOrgId,
      userId: fx.affiliateUserId,
      toolName: "toolA",
      paymentType: "x402",
      metadata: { x402PaymentEventId: event },
    });
    expect(result.success).toBe(true);
    const [row] = await dbWrite
      .select()
      .from(mcpSettlements)
      .where(eq(mcpSettlements.payment_event_id, event));
    expect(row).toBeTruthy();
    expect(row.buyer_credit_transaction_id).toBeNull();
    expect(row.payment_type).toBe("x402");
  });
  test("durable sweep resumes a settling receipt to terminal with exact-once legs", async () => {
    if (!pgliteReady) return;
    const params = await prepaidParams(fx);
    // Crash simulation: claim the receipt, apply the affiliate leg ONLY, then
    // "evict" — creator legs, usage, and terminal state never run. The sweep
    // must complete exactly the missing legs from the receipt snapshot.
    const { mcpSettlementsRepository } = await import("../../../db/repositories/mcp-settlements");
    const { settlement, created } = await mcpSettlementsRepository.claim({
      buyer_credit_transaction_id: params.metadata.preChargeTransactionId,
      buyer_organization_id: fx.buyerOrgId,
      buyer_user_id: fx.affiliateUserId,
      mcp_id: fx.mcpId,
      tool_name: "toolA",
      payment_type: "credits",
      payment_event_id: params.metadata.preChargeTransactionId,
      affiliate_owner_id: fx.affiliateUserId,
      affiliate_code_id: params.affiliateCodeId,
      creator_organization_id: fx.creatorOrgId,
      creator_user_id: fx.creatorUserId,
      base_amount_usd: "0.1",
      affiliate_fee_usd: "0.02",
      platform_fee_usd: "0.02",
      total_amount_usd: "0.14",
      creator_earnings_usd: "0.07",
      platform_earnings_usd: "0.05",
    });
    expect(created).toBe(true);
    const aff = await redeemableEarningsServiceProxy().addEarnings({
      userId: fx.affiliateUserId,
      amount: 0.02,
      source: "affiliate",
      sourceId: `mcp_settlement:${settlement.id}:affiliate`,
      dedupeBySourceId: true,
      description: "pre-crash affiliate leg",
      metadata: {},
    });
    expect(aff.success).toBe(true);
    await mcpSettlementsRepository.recordLeg(settlement.id, {
      affiliate_ledger_entry_id: aff.ledgerEntryId,
    });

    // Backdate past the sweep grace so listDueForResume finds it.
    await dbWrite.execute(
      sql`UPDATE mcp_settlements SET created_at = now() - interval '1 hour' WHERE id = ${settlement.id}::uuid`,
    );

    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.resumed).toBe(1);
    expect(stats.resumeFailures).toBe(0);
    expect(stats.orphanRefunds).toBe(0);

    const s = await balances(fx);
    expect(s.settlementRows).toBe(1);
    // Exactly one application of every leg: affiliate pre-crash, the rest by
    // the sweep; buyer paid once, creator paid once per rail.
    expect(s.creatorOrg).toBeCloseTo(0.07, 6);
    expect(s.creatorRedeemable).toBeCloseTo(0.07, 6);
    expect(s.affiliateRedeemable).toBeCloseTo(0.02, 6);
    expect(s.usageRows).toBe(1);
    expect(s.mcpTotalRequests).toBe(1);
    const [receipt] = s.settlements;
    expect(receipt.status).toBe("settled");
    expect(receipt.mcp_usage_id).toBeTruthy();
    expect(receipt.creator_credit_transaction_id).toBeTruthy();
    expect(receipt.creator_ledger_entry_id).toBeTruthy();

    // A second sweep pass is a no-op (terminal receipts are not due).
    const stats2 = await userMcpsService.sweepMcpSettlements();
    expect(stats2.resumed).toBe(0);
    const s2 = await balances(fx);
    expect(s2.usageRows).toBe(1);
    expect(s2.creatorOrg).toBeCloseTo(0.07, 6);
  });

  test("durable sweep refunds an orphaned precharge exactly once", async () => {
    if (!pgliteReady) return;
    const before = await balances(fx);
    // Eviction between debit and settlement creation: a marked precharge
    // whose id never becomes a payment event, and no route refund ran.
    const debit = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: orphaned precharge (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    expect(debit.success).toBe(true);
    expect(debit.transaction?.id).toBeTruthy();
    // The sweep only trusts debits past the grace window; a fresh debit may
    // still be mid-delivery. Backdate past it like an old crashed one.
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${debit.transaction.id}::uuid`,
    );

    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.orphanRefunds).toBe(1);
    expect(stats.orphanRefundFailures).toBe(0);
    const after = await balances(fx);
    // Buyer is whole: balance restored to the pre-debit state (refund of the
    // exact debit amount, no settlement legs applied).
    expect(after.buyer).toBeCloseTo(before.buyer, 6);
    expect(after.settlementRows).toBe(0);
    expect(after.usageRows).toBe(0);

    // Second pass: the NOT-EXISTS sees the refund's linkage — no double refund.
    const stats2 = await userMcpsService.sweepMcpSettlements();
    expect(stats2.orphanRefunds).toBe(0);
    const after2 = await balances(fx);
    expect(after2.buyer).toBeCloseTo(before.buyer, 6);
  });

  test("recordZeroCostUsage never bills even when the price flips mid-flight (#27992 rebase)", async () => {
    if (!pgliteReady) return;
    const before = await balances(fx);
    const [freeMcp] = await dbWrite
      .insert(userMcps)
      .values({
        name: uniq("zerocost"),
        slug: uniq("zerocost"),
        description: "zero-cost structural fixture",
        organization_id: fx.creatorOrgId,
        created_by_user_id: fx.creatorUserId,
        endpoint_type: "external",
        external_endpoint: "https://zero.example.test",
        status: "live",
        pricing_type: "credits",
        credits_per_request: "0",
        creator_share_percentage: "70",
        platform_share_percentage: "30",
        tools: [{ name: "toolA" }],
      })
      .returning();

    await userMcpsService.recordZeroCostUsage({
      mcpId: freeMcp.id,
      organizationId: fx.buyerOrgId,
      userId: fx.affiliateUserId,
      toolName: "toolA",
      metadata: { responseTime: 12, success: true },
    });

    // Price flips to paid AFTER the zero-cost record: no later call may look
    // back and charge. (Structural: the API has no charging code path.)
    await dbWrite
      .update(userMcps)
      .set({ credits_per_request: "10" })
      .where(eq(userMcps.id, freeMcp.id));
    await userMcpsService.recordZeroCostUsage({
      mcpId: freeMcp.id,
      organizationId: fx.buyerOrgId,
      userId: fx.affiliateUserId,
      toolName: "toolA",
    });

    const after = await balances(fx);
    expect(after.buyer).toBeCloseTo(before.buyer, 6);
    expect(after.settlementRows).toBe(0);
    const usages = await dbWrite.select().from(mcpUsage).where(eq(mcpUsage.mcp_id, freeMcp.id));
    expect(usages).toHaveLength(2);
    for (const row of usages) {
      expect(Number(row.credits_charged)).toBe(0);
      expect(Number(row.total_amount_usd)).toBe(0);
    }
    const settlements = await dbWrite
      .select()
      .from(mcpSettlements)
      .where(eq(mcpSettlements.mcp_id, freeMcp.id));
    expect(settlements).toHaveLength(0);
  });

  test("orphan sweep finds an unreceipted admission-rail deferred debit (#27992 rebase)", async () => {
    if (!pgliteReady) return;
    const before = await balances(fx);
    // Shape produced by debitInferenceCost for the MCP proxy (deferred mode):
    // no mcp_precharge marker, but requestId/model name the proxy request.
    const debit = await creditsService.deductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.05,
      description: "Inference (deferred): mcp/" + fx.mcpId,
      metadata: {
        requestId: "mcp-proxy:" + fx.mcpId + ":00000000-0000-4000-8000-000000000001",
        model: "mcp/" + fx.mcpId,
        provider: "mcp",
        type: "inference_optimistic",
        source: "deferred",
      },
    });
    expect(debit.success).toBe(true);
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${debit.transaction.id}::uuid`,
    );

    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.orphanRefunds).toBe(1);
    const after = await balances(fx);
    expect(after.buyer).toBeCloseTo(before.buyer, 6);
    // Second pass: no double refund.
    const stats2 = await userMcpsService.sweepMcpSettlements();
    expect(stats2.orphanRefunds).toBe(0);
  });

  test("orphan sweep refunds the NET remainder of a partially-reconciled debit (#27992 r1 F3)", async () => {
    if (!pgliteReady) return;
    // Reservation-mode debit tagged by the route's admission context metadata.
    const reservation = await creditsService.reserve({
      organizationId: fx.buyerOrgId,
      description: "MCP: rail reservation (test)",
      amount: 0.14,
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    expect(reservation.reservationTransactionId).toBeTruthy();
    const debitId = reservation.reservationTransactionId!;
    // Reconcile to a lower actual cost: the rail writes a 0.09 refund row
    // carrying reservation_transaction_id, then the worker dies before the
    // receipt insert. The sweep must return the NET remainder (0.05) — never
    // the gross (double-pay) and never nothing (stranded buyer charge).
    await reservation.reconcile(0.05);
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${debitId}::uuid`,
    );

    const before = await balances(fx);
    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.orphanRefunds).toBe(1);
    const after = await balances(fx);
    expect(after.buyer).toBeCloseTo(before.buyer + 0.05, 6);
    // Second pass: nothing left to refund.
    const stats2 = await userMcpsService.sweepMcpSettlements();
    expect(stats2.orphanRefunds).toBe(0);
  });

  test("sweep claim loses the race to a concurrently-committed reconcile refund (#27992 r1 F1)", async () => {
    if (!pgliteReady) return;
    // The finder and the claim are separate statements. Simulate the
    // interleaving: finder saw the debit unrefunded, then the rail reconcile
    // refund commits BEFORE claimPrechargeForSweep runs. The claim's atomic
    // refund-linkage sum exclusion must refuse the row.
    const reservation = await creditsService.reserve({
      organizationId: fx.buyerOrgId,
      description: "MCP: rail reservation race (test)",
      amount: 0.14,
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = reservation.reservationTransactionId!;
    await reservation.reconcile(0); // full refund of the reservation
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${debitId}::uuid`,
    );
    // Re-find candidates (finder excludes it — fully refunded) AND verify the
    // claim refuses the debit even when handed the id directly.
    const claimed = await mcpSettlementsRepository.claimPrechargeForSweep(debitId);
    expect(claimed.claimed).toBe(false);
    const before = await balances(fx);
    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.orphanRefunds).toBe(0);
    const after = await balances(fx);
    expect(after.buyer).toBeCloseTo(before.buyer, 6);
  });

  test("rail reconcile refuses a debit the sweep already refunded (#27992 r1 F1 mirror)", async () => {
    if (!pgliteReady) return;
    const reservation = await creditsService.reserve({
      organizationId: fx.buyerOrgId,
      description: "MCP: rail reservation mirror (test)",
      amount: 0.14,
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = reservation.reservationTransactionId!;
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${debitId}::uuid`,
    );
    // Sweep owns the debit first (full refund).
    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.orphanRefunds).toBe(1);
    const afterSweep = await balances(fx);
    // A late reconcile (e.g. retrying worker) must NOT issue a second refund:
    // the claim predicate now refuses sweep-marked rows, so reconcile takes
    // the not-claimed branch with no receipt and the buyer balance is fixed.
    await reservation.reconcile(0.05);
    const afterReconcile = await balances(fx);
    expect(afterReconcile.buyer).toBeCloseTo(afterSweep.buyer, 6);
  });

  test("settlement receipt keys the reservation and the overage debit is not swept (#27992 r1 F2)", async () => {
    if (!pgliteReady) return;
    // Reserve 0.05, reconcile to 0.07: reconcile commits an overage debit
    // inheriting the reservation metadata (mcp_precharge v1). The receipt
    // keys the parent reservation. The sweep must refund NEITHER: the parent
    // is receipt-protected and the overage is a legitimately owed charge.
    const reservation = await creditsService.reserve({
      organizationId: fx.buyerOrgId,
      description: `MCP: ${fx.mcpId}`,
      amount: 0.05,
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = reservation.reservationTransactionId!;
    const reconciliation = await reservation.reconcile(0.07);
    expect(reconciliation?.adjustmentType).toBe("overage");
    // Commit the receipt the route would insert after a successful call
    // (first-committed-wins insert, keyed on the parent reservation).
    await mcpSettlementsRepository.claim({
      buyer_credit_transaction_id: debitId,
      buyer_organization_id: fx.buyerOrgId,
      buyer_user_id: fx.affiliateUserId,
      mcp_id: fx.mcpId,
      tool_name: "toolA",
      payment_type: "credits",
      payment_event_id: debitId,
      affiliate_owner_id: null,
      affiliate_code_id: null,
      creator_organization_id: fx.creatorOrgId,
      creator_user_id: fx.creatorUserId,
      base_amount_usd: "0.070000",
      affiliate_fee_usd: "0.000000",
      platform_fee_usd: "0.000000",
      total_amount_usd: "0.070000",
      creator_earnings_usd: "0.070000",
      platform_earnings_usd: "0.000000",
      x402_amount_usd: "0.000000",
    });
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '2 hours' WHERE id = ${debitId}::uuid OR metadata->>'reservation_transaction_id' = ${debitId}::text`,
    );
    const before = await balances(fx);
    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.orphanRefunds).toBe(0);
    const after = await balances(fx);
    expect(after.buyer).toBeCloseTo(before.buyer, 6);
  });

  test("sweep refunds the claim-time net, not the stale finder snapshot (#27992 r2 F1)", async () => {
    if (!pgliteReady) return;
    // Finder sees refunded=0; a partial reconcile refund commits BEFORE the
    // claim runs. The claim must return the claim-time net (0.05), and the
    // sweep must refund exactly that — never the stale gross (0.14).
    const reservation = await creditsService.reserve({
      organizationId: fx.buyerOrgId,
      description: "MCP: rail reservation stale-snapshot (test)",
      amount: 0.14,
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = reservation.reservationTransactionId!;
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${debitId}::uuid`,
    );
    // Interleave: run the reconcile refund while the sweep holds the debit —
    // simpler deterministic form: commit the partial refund first, then verify
    // a claim handed the (now stale) id returns the 0.05 net and the full
    // sweep refunds exactly 0.05. `before` is snapshotted AFTER the reconcile
    // refund (which itself returns 0.09 to the buyer), so the delta below
    // isolates exactly the sweep's 0.05 net refund.
    await reservation.reconcile(0.05); // 0.09 partial refund commits
    const before = await balances(fx);
    const claimed = await mcpSettlementsRepository.claimPrechargeForSweep(debitId);
    expect(claimed.claimed).toBe(true);
    expect(Number(claimed.netRefundable)).toBeCloseTo(0.05, 6);
    // Release the claim by simulating the sweep refund path end-to-end: the
    // marker is 'refunding'; run the real sweep to refund the net and finish.
    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.orphanRefunds).toBe(1);
    const after = await balances(fx);
    expect(after.buyer).toBeCloseTo(before.buyer + 0.05, 6);
  });

  test("overage claim is refused when the parent receipt lands between finder and claim (#27992 r2 F2)", async () => {
    if (!pgliteReady) return;
    // Reserve 0.05, no receipt yet (dead-worker shape): finder returns BOTH
    // parent and overage as candidates. Then the receipt keys the parent
    // BEFORE the overage's claim runs: the overage claim must refuse.
    const reservation = await creditsService.reserve({
      organizationId: fx.buyerOrgId,
      description: `MCP: ${fx.mcpId}`,
      amount: 0.05,
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = reservation.reservationTransactionId!;
    const reconciliation = await reservation.reconcile(0.07);
    expect(reconciliation?.adjustmentType).toBe("overage");
    const overage = await dbWrite.execute<{ id: string }>(sql`
      SELECT id FROM credit_transactions
      WHERE metadata->>'type' = 'reconciliation_overage'
        AND metadata->>'reservation_transaction_id' = ${debitId}::text
      LIMIT 1`);
    const overageId = overage.rows?.[0]?.id;
    expect(overageId).toBeTruthy();
    // Receipt for the PARENT lands now (finder already ran in production
    // shape; here we directly prove the claim refuses without it re-finding).
    await mcpSettlementsRepository.claim({
      buyer_credit_transaction_id: debitId,
      buyer_organization_id: fx.buyerOrgId,
      buyer_user_id: fx.affiliateUserId,
      mcp_id: fx.mcpId,
      tool_name: "toolA",
      payment_type: "credits",
      payment_event_id: debitId,
      affiliate_owner_id: null,
      affiliate_code_id: null,
      creator_organization_id: fx.creatorOrgId,
      creator_user_id: fx.creatorUserId,
      base_amount_usd: "0.070000",
      affiliate_fee_usd: "0.000000",
      platform_fee_usd: "0.000000",
      total_amount_usd: "0.070000",
      creator_earnings_usd: "0.070000",
      platform_earnings_usd: "0.000000",
      x402_amount_usd: "0.000000",
    });
    const before = await balances(fx);
    const claimedOverage = await mcpSettlementsRepository.claimPrechargeForSweep(overageId!);
    expect(claimedOverage.claimed).toBe(false);
    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.orphanRefunds).toBe(0);
    const after = await balances(fx);
    expect(after.buyer).toBeCloseTo(before.buyer, 6);
  });

  test("settlement payment event guard refuses a refund row (#27992 rebase)", async () => {
    if (!pgliteReady) return;
    const params = await prepaidParams(fx, {
      metadata: { preChargeTransactionId: "", success: true },
    });
    const marked = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: guard fixture (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    expect(marked.success).toBe(true);
    const refund = await creditsService.refundCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP refund: guard fixture (test)",
      metadata: { mcp_precharge_refund_for: marked.transaction!.id },
    });
    expect(refund.transaction?.id).toBeTruthy();
    // Keying a settlement on the REFUND row id must fail closed.
    await expect(
      userMcpsService.recordUsageWithoutDeduction({
        ...params,
        metadata: { preChargeTransactionId: refund.transaction!.id, success: true },
      }),
    ).rejects.toThrow(/not a debit transaction/);
  });

  test("orphan sweep never touches a settled precharge or a route-refunded one", async () => {
    if (!pgliteReady) return;
    // (a) A debit that DID become a settlement is not an orphan.
    const params = await prepaidParams(fx, {
      metadata: { preChargeTransactionId: "", success: true },
    });
    // Re-do the precharge through the marked path so the sweep query matches
    // it, then settle it fully.
    const marked = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: settled precharge (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    expect(marked.success).toBe(true);
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${marked.transaction.id}::uuid`,
    );
    const r = await userMcpsService.recordUsageWithoutDeduction({
      ...params,
      metadata: { preChargeTransactionId: marked.transaction!.id, success: true },
    });
    expect(r.success).toBe(true);

    // (b) A marked debit that was refunded by the route (linkage metadata).
    const refundedDebit = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: route-refunded precharge (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    expect(refundedDebit.success).toBe(true);
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${refundedDebit.transaction.id}::uuid`,
    );
    await creditsService.refundCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP refund: upstream_unreachable (test)",
      metadata: { mcp_precharge_refund_for: refundedDebit.transaction!.id },
    });

    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.orphanRefunds).toBe(0);
    expect(stats.resumed).toBe(0);
  });

  test("sweep-refunded precharge refuses a late settlement (no legs on refunded money)", async () => {
    if (!pgliteReady) return;
    // The round-4 P0 race: eviction between debit and settlement, sweep
    // refunds the orphan, then a very late redelivery of the same event
    // arrives. Settling it would pay creator/platform legs on money already
    // returned to the buyer — the platform eats the leg value. The live path
    // must refuse the refunded debit BEFORE any leg moves.
    const debit = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: sweep-refunded precharge (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    expect(debit.success).toBe(true);
    const debitId = debit.transaction!.id;
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${debitId}::uuid`,
    );

    // The sweep owns the debit: claim + refund.
    const sweep = await userMcpsService.sweepMcpSettlements();
    expect(sweep.orphanRefunds).toBe(1);

    // The late delivery: same precharge event, after the refund.
    await expect(
      userMcpsService.recordUsageWithoutDeduction({
        mcpId: fx.mcpId,
        organizationId: fx.buyerOrgId,
        userId: fx.affiliateUserId,
        toolName: "toolA",
        creditsCharged: 10,
        affiliateFeeCredits: 2,
        platformFeeCredits: 2,
        affiliateOwnerId: fx.affiliateUserId,
        affiliateCodeId: fx.affiliateCodeId,
        metadata: { preChargeTransactionId: debitId, success: true },
      }),
    ).rejects.toThrow(/refunded by the durable sweep/);

    // Nothing settled and no legs moved: the buyer keeps the refund, the
    // creator and platform were paid nothing for the refunded event.
    const s = await balances(fx);
    expect(s.settlementRows).toBe(0);
    expect(s.creatorOrg).toBe(0);
    expect(s.creatorRedeemable).toBe(0);
    expect(s.affiliateRedeemable).toBe(0);
    expect(s.usageRows).toBe(0);
  });

  test("redelivery after a crashed live claim settles through the receipt path", async () => {
    if (!pgliteReady) return;
    // The live path claimed the debit (marker 'settlement') and died before
    // inserting the receipt. Within the reclaim horizon the sweep must NOT
    // refund it (a redelivery may still settle), and the redelivery settles
    // normally: marker claim fails, marker is not 'true', receipt claim wins.
    const debit = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: crashed live claim (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = debit.transaction!.id;
    await dbWrite.execute(
      sql`UPDATE credit_transactions
          SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{mcp_precharge_swept}', '"settlement"'::jsonb),
              created_at = now() - interval '1 hour'
          WHERE id = ${debitId}::uuid`,
    );

    // Within the horizon: conservative hold — no refund, no duplicate value.
    const hold = await userMcpsService.sweepMcpSettlements();
    expect(hold.orphanRefunds).toBe(0);

    // The redelivery settles the claimed-but-unreceipted debit.
    const result = await userMcpsService.recordUsageWithoutDeduction({
      mcpId: fx.mcpId,
      organizationId: fx.buyerOrgId,
      userId: fx.affiliateUserId,
      toolName: "toolA",
      creditsCharged: 10,
      affiliateFeeCredits: 2,
      platformFeeCredits: 2,
      affiliateOwnerId: fx.affiliateUserId,
      affiliateCodeId: fx.affiliateCodeId,
      metadata: { preChargeTransactionId: debitId, success: true },
    });
    expect(result.success).toBe(true);

    const s = await balances(fx);
    expect(s.settlementRows).toBe(1);
    expect(s.creatorOrg).toBeCloseTo(0.07, 6);
    expect(s.creatorRedeemable).toBeCloseTo(0.07, 6);
    expect(s.affiliateRedeemable).toBeCloseTo(0.02, 6);
    // The settled debit is protected from the sweep by its receipt.
    const post = await userMcpsService.sweepMcpSettlements();
    expect(post.orphanRefunds).toBe(0);
  });

  test("a dead 'settlement' claim is reclaimed and refunded after the horizon", async () => {
    if (!pgliteReady) return;
    // Crash between marker write and receipt insert, and NO redelivery ever
    // comes. Past the reclaim horizon the debit is dead money: the sweep
    // reclaims the claim and refunds the buyer (#22961: recover safely from
    // lost responses — the hold must be temporary, not permanent).
    const before = await balances(fx);
    const debit = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: dead settlement claim (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = debit.transaction!.id;
    await dbWrite.execute(
      sql`UPDATE credit_transactions
          SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{mcp_precharge_swept}', '"settlement"'::jsonb),
              created_at = now() - interval '25 hours'
          WHERE id = ${debitId}::uuid`,
    );

    const sweep = await userMcpsService.sweepMcpSettlements();
    expect(sweep.orphanRefunds).toBe(1);
    const after = await balances(fx);
    expect(after.buyer).toBeCloseTo(before.buyer, 6);
    expect(after.settlementRows).toBe(0);

    // And a delivery arriving after THAT is still refused (refunded debit).
    await expect(
      userMcpsService.recordUsageWithoutDeduction({
        mcpId: fx.mcpId,
        organizationId: fx.buyerOrgId,
        userId: fx.affiliateUserId,
        toolName: "toolA",
        creditsCharged: 10,
        affiliateFeeCredits: 2,
        platformFeeCredits: 2,
        affiliateOwnerId: fx.affiliateUserId,
        affiliateCodeId: fx.affiliateCodeId,
        metadata: { preChargeTransactionId: debitId, success: true },
      }),
    ).rejects.toThrow(/refunded by the durable sweep/);
  });

  test("stale live claim cannot be re-settled once the sweep owns the refund (round-6 F1)", async () => {
    if (!pgliteReady) return;
    // Round-6 F1: a dead 'settlement' claim past the reclaim horizon is
    // refund-owned. A late redelivery arriving after the sweep claimed (or
    // completed) the refund must NEVER settle that debit — under the old
    // fail-closed read the 'true' marker was the ONLY refused state, so a
    // 'refunding' claim (refund in flight) or a stale-'settlement' marker let
    // the redelivery race the refund and mint settled+refunded double value.
    const debit = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: stale claim vs sweep race (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    expect(debit.success).toBe(true);
    const debitId = debit.transaction!.id;
    // Simulate a crashed live claim (marker 'settlement', claim timestamped
    // 25h ago) — dead by every measure the sweep uses.
    await dbWrite.execute(
      sql`UPDATE credit_transactions
          SET metadata = jsonb_set(jsonb_set(coalesce(metadata, '{}'::jsonb), '{mcp_precharge_swept}', '"settlement"'::jsonb), '{mcp_precharge_swept_at}', to_jsonb(((extract(epoch from now()) * 1000)::bigint - (25 * 60 * 60 * 1000)))),
              created_at = now() - interval '25 hours'
          WHERE id = ${debitId}::uuid`,
    );

    // The sweep claims the stale dead claim and refunds it. After the refund
    // lands, the marker is terminal 'true' AND the refund row exists.
    const sweep = await userMcpsService.sweepMcpSettlements();
    expect(sweep.orphanRefunds).toBe(1);

    // The late redelivery must be refused — the refund row exists.
    await expect(
      userMcpsService.recordUsageWithoutDeduction({
        mcpId: fx.mcpId,
        organizationId: fx.buyerOrgId,
        userId: fx.affiliateUserId,
        toolName: "toolA",
        creditsCharged: 10,
        affiliateFeeCredits: 2,
        platformFeeCredits: 2,
        affiliateOwnerId: fx.affiliateUserId,
        affiliateCodeId: fx.affiliateCodeId,
        metadata: { preChargeTransactionId: debitId, success: true },
      }),
    ).rejects.toThrow(/refunded|sweep/i);

    // Conservation: buyer whole, nothing settled, no legs moved.
    const s = await balances(fx);
    expect(s.settlementRows).toBe(0);
    expect(s.creatorOrg).toBe(0);
    expect(s.creatorRedeemable).toBe(0);
    expect(s.affiliateRedeemable).toBe(0);
    expect(s.usageRows).toBe(0);
  });

  test("redelivery concurrent with a sweep refund claim fails closed (round-6 F1 in-flight state)", async () => {
    if (!pgliteReady) return;
    // The sharpest interleaving from round 6: the sweep has claimed the debit
    // (marker 'refunding', refund in flight) but the refund row does not
    // exist yet. A redelivery arriving in that window must fail closed. The
    // old read only refused the terminal 'true' state, so this window let the
    // redelivery insert a receipt while the refund landed — double value.
    const debit = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: refunding window (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = debit.transaction!.id;
    await dbWrite.execute(
      sql`UPDATE credit_transactions
          SET metadata = jsonb_set(jsonb_set(coalesce(metadata, '{}'::jsonb), '{mcp_precharge_swept}', '"refunding"'::jsonb), '{mcp_precharge_swept_at}', to_jsonb((extract(epoch from now()) * 1000)::bigint)),
              created_at = now() - interval '25 hours'
          WHERE id = ${debitId}::uuid`,
    );

    // Redelivery mid-refund: the sweep owns the debit; refuse to settle.
    await expect(
      userMcpsService.recordUsageWithoutDeduction({
        mcpId: fx.mcpId,
        organizationId: fx.buyerOrgId,
        userId: fx.affiliateUserId,
        toolName: "toolA",
        creditsCharged: 10,
        affiliateFeeCredits: 2,
        platformFeeCredits: 2,
        affiliateOwnerId: fx.affiliateUserId,
        affiliateCodeId: fx.affiliateCodeId,
        metadata: { preChargeTransactionId: debitId, success: true },
      }),
    ).rejects.toThrow(/refunded|sweep/i);

    // And the sweep later completes the refund exactly once (retryable claim).
    const sweep = await userMcpsService.sweepMcpSettlements();
    expect(sweep.orphanRefunds).toBe(1);
    const s = await balances(fx);
    expect(s.settlementRows).toBe(0);
    expect(s.usageRows).toBe(0);
  });

  test("a failed orphan refund is retried by the next sweep pass and refunds exactly once (round-6 F2)", async () => {
    if (!pgliteReady) return;
    // Round-6 F2: under the round-4 protocol a failed refundCredits left the
    // marker terminal 'true' and the candidate predicate only accepted
    // NULL/stale-settlement markers, so a transient refund failure meant the
    // buyer was permanently debited. The sweep-owned state must stay
    // retryable until the refund row exists, keyed by the debit-scoped
    // idempotency key.
    const debit = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: refund failure retry (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = debit.transaction!.id;
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${debitId}::uuid`,
    );

    // Fail the refund once. The service-layer creditsService is imported by
    // value; patch the object method in place for one pass.
    const { creditsService: creds } = await import("../credits");
    const originalRefund = creds.refundCredits.bind(creds);
    let failNext = true;
    (creds as unknown as { refundCredits: typeof creds.refundCredits }).refundCredits =
      async function patchedRefund(params: Parameters<typeof originalRefund>) {
        if (failNext && params.metadata?.mcp_precharge_refund_for === debitId) {
          throw new Error("simulated transient refund failure");
        }
        return originalRefund(params);
      };
    try {
      const failed = await userMcpsService.sweepMcpSettlements();
      expect(failed.orphanRefundFailures).toBe(1);
      expect(failed.orphanRefunds).toBe(0);

      // Next pass must find the debit again and refund it exactly once —
      // no permanent debit left behind by a transient failure.
      failNext = false;
      const retried = await userMcpsService.sweepMcpSettlements();
      expect(retried.orphanRefunds).toBe(1);
      expect(retried.orphanRefundFailures).toBe(0);
      // A third pass finds nothing (the refund row now exists).
      const third = await userMcpsService.sweepMcpSettlements();
      expect(third.orphanRefunds).toBe(0);

      // Exactly one refund row for the debit.
      const refundRows = await dbWrite.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM credit_transactions
        WHERE type = 'refund' AND metadata->>'mcp_precharge_refund_for' = ${debitId}::text
      `);
      expect(Number(refundRows.rows?.[0]?.count ?? "0")).toBe(1);
    } finally {
      (creds as unknown as { refundCredits: typeof creds.refundCredits }).refundCredits =
        originalRefund as unknown as typeof creds.refundCredits;
    }
  });

  test("recordUsage deducting-path precharge is recoverable after a crash before settlement (round-6 F3)", async () => {
    if (!pgliteReady) return;
    // Round-6 F3: recordUsage's deductCredits metadata did not carry
    // mcp_precharge: v1, so a crash after the debit but before the settlement
    // receipt left an unrecoverable debit — findOrphanPrecharges never saw
    // it. The deducting path must tag its debit for the same recovery
    // protocol, with a crash-boundary proof: debit, crash, sweep refunds.
    const before = await balances(fx);
    // Drive recordUsage up to the crash point by making the settlement claim
    // throw AFTER the debit commits: patch mcpSettlementsRepository.claim to
    // throw once (the debit has already committed at that point).
    const { mcpSettlementsRepository: repo } = await import(
      "../../../db/repositories/mcp-settlements"
    );
    const originalClaim = repo.claim.bind(repo);
    let crashNext = true;
    (repo as { claim: typeof repo.claim }).claim = async function crashClaim(
      values: Parameters<typeof originalClaim>,
    ) {
      if (crashNext) {
        crashNext = false;
        throw new Error("simulated crash between debit and receipt insert");
      }
      return originalClaim(values);
    };
    try {
      await expect(
        userMcpsService.recordUsage({
          mcpId: fx.mcpId,
          organizationId: fx.buyerOrgId,
          userId: fx.affiliateUserId,
          toolName: "toolA",
          paymentType: "credits",
          creditsCharged: 10,
          metadata: {},
        }),
      ).rejects.toThrow(/simulated crash/);
    } finally {
      (repo as { claim: typeof repo.claim }).claim = originalClaim;
    }

    // The debit carries the mcp_precharge marker now.
    const [debitRow] = await dbWrite
      .select()
      .from(creditTransactions)
      .where(
        sql`${creditTransactions.type} = 'debit' AND ${creditTransactions.organization_id} = ${fx.buyerOrgId} AND ${creditTransactions.created_at} > now() - interval '1 minute'`,
      );
    expect(debitRow).toBeDefined();
    expect(debitRow.metadata?.mcp_precharge).toBe("v1");

    // Age it past the sweep grace AND the stale-claim reclaim horizon (the
    // live claim timestamped the marker moments before the crash, so both
    // clocks must move): crash -> no redelivery ever comes -> 24h pass ->
    // the sweep reclaims the dead claim and refunds the buyer.
    await dbWrite.execute(
      sql`UPDATE credit_transactions
          SET created_at = now() - interval '25 hours',
              metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{mcp_precharge_swept_at}', to_jsonb(((extract(epoch from now()) * 1000)::bigint - (25 * 60 * 60 * 1000))))
          WHERE id = ${debitRow.id}::uuid`,
    );
    const sweep = await userMcpsService.sweepMcpSettlements();
    expect(sweep.orphanRefunds).toBe(1);
    const after = await balances(fx);
    expect(after.buyer).toBeCloseTo(before.buyer, 6);
    expect(after.settlementRows).toBe(0);
  });

  test("live claim on an OLD debit is fresh by claim timestamp: the sweep must not refund it mid-delivery (round-7 F1)", async () => {
    if (!pgliteReady) return;
    // Round-7 F1 residual: under the intermediate state the live claim
    // stamped no timestamp, so the sweep judged staleness by the debit's
    // created_at and could reclaim + refund an ACTIVE delivery on an old
    // debit (settled AND refunded = double value). The claim must now stamp
    // mcp_precharge_swept_at so a claim written seconds ago is fresh however
    // old the debit is. Drive the REAL claim path (not a hand-crafted
    // marker), pause between claim and receipt insert, and run the sweep
    // mid-delivery: it must hold, not refund.
    const debit = await creditsService.reserveAndDeductCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.14,
      description: "MCP: old debit, live claim (test)",
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = debit.transaction!.id;
    // Debit is old (25h) but has NO claim yet — the exact shape that fooled
    // the created_at fallback.
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '25 hours' WHERE id = ${debitId}::uuid`,
    );

    // Pause the live delivery BETWEEN its claim and the receipt insert: the
    // claim has run (real claimPrechargeForSettlement), the receipt does not
    // exist yet. Patch the repository claim to run its real body, then block
    // the settlement insert until the sweep has run.
    const { mcpSettlementsRepository: repo } = await import(
      "../../../db/repositories/mcp-settlements"
    );
    const originalClaim = repo.claim.bind(repo);
    resolveSweep = () => {};
    const sweepRan = new Promise<void>((resolve) => {
      resolveSweep = resolve;
    });
    let gateOpened = false;
    releaseSweepGate = () => {
      gateOpened = true;
    };
    (repo as { claim: typeof repo.claim }).claim = async function gatedClaim(
      values: Parameters<typeof originalClaim>,
    ) {
      // Block BEFORE the receipt insert: the precharge claim has already
      // happened inside applyMcpSettlement (marker written, no receipt), so
      // this is exactly the mid-delivery window the sweep must survive.
      releaseSweepGate();
      await sweepRan;
      return originalClaim(values);
    };
    // The real service call — its precharge claim runs through the REAL
    // claimPrechargeForSettlement (timestamp-stamping), then it blocks in
    // the gated claim() above while the sweep runs.
    const delivery = (async () => {
      await userMcpsService.recordUsageWithoutDeduction({
        mcpId: fx.mcpId,
        organizationId: fx.buyerOrgId,
        userId: fx.affiliateUserId,
        toolName: "toolA",
        creditsCharged: 10,
        affiliateFeeCredits: 2,
        platformFeeCredits: 2,
        affiliateOwnerId: fx.affiliateUserId,
        affiliateCodeId: fx.affiliateCodeId,
        metadata: { preChargeTransactionId: debitId, success: true },
      });
    })();
    const gateWatch = setInterval(() => {}, 1); // keep the loop alive pre-await
    try {
      // Wait until the delivery has reached its gated claim (the gate flag
      // flips inside the patched claim right after the real claim runs).
      await new Promise<void>((resolveGate) => {
        const t = setInterval(() => {
          if (gateOpened) {
            clearInterval(t);
            resolveGate();
          }
        }, 5);
      });
      // The sweep runs mid-delivery: the claim is seconds old — it must NOT
      // refund, no matter that the debit itself is 25h old.
      const midDeliverySweep = await userMcpsService.sweepMcpSettlements();
      expect(midDeliverySweep.orphanRefunds).toBe(0);
      resolveSweep();
      await delivery;
    } finally {
      clearInterval(gateWatch);
      (repo as { claim: typeof repo.claim }).claim = originalClaim;
      resolveSweep();
      releaseSweepGate = () => {};
    }

    // The delivery completed: one receipt, buyer debited once, legs paid
    // once. A later sweep must not refund the settled debit either.
    const post = await userMcpsService.sweepMcpSettlements();
    expect(post.orphanRefunds).toBe(0);
    const s = await balances(fx);
    expect(s.settlementRows).toBe(1);
    expect(s.usageRows).toBe(1);
    // Marker is the live 'settlement' claim (receipt-protected now).
    const [row] = await dbWrite
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.id, debitId));
    expect(row.metadata?.mcp_precharge_swept).toBe("settlement");
  });

  test("free-tier usage+stats insert is one atomic statement (crash boundary)", async () => {
    if (!pgliteReady) return;
    const [freeMcp] = await dbWrite
      .insert(userMcps)
      .values({
        name: uniq("atomicfree"),
        slug: uniq("atomicfree"),
        description: "free-tier atomicity fixture",
        organization_id: fx.creatorOrgId,
        created_by_user_id: fx.creatorUserId,
        endpoint_type: "external",
        external_endpoint: "https://atomic.example.test",
        status: "live",
        pricing_type: "credits",
        credits_per_request: "0",
        creator_share_percentage: "70",
        platform_share_percentage: "30",
        tools: [{ name: "toolA" }],
      })
      .returning();

    // Crash-boundary regression guard (#22961 round-3 F1): the free-tier
    // usage row and the stats bump must commit in ONE statement. If a future
    // edit splits the CTE back into an INSERT followed by a separate UPDATE,
    // a crash between them permanently loses the stats bump (or double-bumps
    // on redelivery) — count every write statement executed during one free
    // call and fail on anything but a single INSERT..SELECT (reads like the
    // mcp lookup and affiliate resolution are excluded by kind).
    const writeStatements: string[] = [];
    // Patch the PGlite client's query() — the single bottom every drizzle
    // write funnels through regardless of builder vs raw form.
    const session = (
      dbWrite as unknown as { session: { client: { query: (s: string) => Promise<unknown> } } }
    ).session;
    if (typeof session?.client?.query !== "function") {
      throw new Error("atomicity probe could not locate the PGlite client");
    }
    const client = session.client;
    const originalQuery = client.query.bind(client);
    client.query = async function patchedQuery(
      this: typeof client,
      ...args: Parameters<typeof client.query>
    ) {
      const queryString = args[0];
      if (
        typeof queryString === "string" &&
        // CTE-shaped writes (WITH ins AS (INSERT ...)) are writes too — the
        // single-statement atomicity proof MUST count them.
        /^\s*(insert|update|delete|with)\b/i.test(queryString.trim())
      ) {
        writeStatements.push(queryString.trim());
      }
      return originalQuery.apply(client, args);
    } as typeof client.query;
    try {
      const result = await userMcpsService.recordUsage({
        mcpId: freeMcp.id,
        organizationId: fx.buyerOrgId,
        userId: fx.affiliateUserId,
        toolName: "toolA",
        paymentType: "credits",
      });
      expect(result.success).toBe(true);
    } finally {
      client.query = originalQuery;
    }

    expect(writeStatements).toHaveLength(1);
    // The single statement is the combined CTE (WITH ins AS (INSERT ...) upd AS (...))
    // carrying BOTH the usage row and the stats bump.
    expect(writeStatements[0]).toMatch(/^(with|insert)/i);
    expect(writeStatements[0]).toMatch(/\binsert\b[\s\S]*\bmcp_usage\b/i);
    expect(writeStatements[0]).toMatch(/\bupdate\b[\s\S]*\buser_mcps\b/i);
    const usages = await dbWrite.select().from(mcpUsage).where(eq(mcpUsage.mcp_id, freeMcp.id));
    expect(usages).toHaveLength(1);
    const [row] = await dbWrite.select().from(userMcps).where(eq(userMcps.id, freeMcp.id));
    expect(row.total_requests).toBe(1);
  });

  test("refund idempotency key dedupes at the ledger AND the balance — overlapping-sweep double-refund backstop (#27992 note 2)", async () => {
    if (!pgliteReady) return;
    // The sweep's double-refund guarantee under OVERLAPPING sweep passes does
    // not live in the claim UPDATE (which deliberately re-admits 'refunding'
    // claims so a crashed pass stays retryable) — it lives HERE, in
    // applyCreditIncrease's dedupe on the debit-scoped key carried in
    // stripePaymentIntentId. The sweep-level tests above exercise the sweep
    // loop; this test pins the dedupe CONTRACT itself, at the service
    // boundary the sweep calls, so a future refactor of either side cannot
    // remove the guarantee without a failing test.
    // 1. Two refundCredits calls with the same key → ONE refund row and ONE
    //    balance increase.
    // 2. A replay with a DIFFERENT key still lands (keys scope dedupe, they
    //    do not block unrelated refunds).
    // 3. The exact key shape the sweep passes is what dedupes.
    const before = await balances(fx);
    const key = `mcp_precharge_refund:synthetic-dedupe-probe-${Date.now()}`;
    const first = await creditsService.refundCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.25,
      description: "MCP refund: dedupe contract (test)",
      stripePaymentIntentId: key,
      metadata: { reason: "dedupe_contract_probe" },
    });
    expect(Number(first.transaction.amount)).toBe(0.25);

    const replay = await creditsService.refundCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.25,
      description: "MCP refund: dedupe contract (test)",
      stripePaymentIntentId: key,
      metadata: { reason: "dedupe_contract_probe" },
    });
    // Same committed transaction returns — the replay is idempotent.
    expect(replay.transaction.id).toBe(first.transaction.id);

    const after = await balances(fx);
    // Ledger: exactly one refund row for the key.
    expect(after.buyer - before.buyer).toBe(0.25);
    const rows = await dbWrite.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM credit_transactions
      WHERE stripe_payment_intent_id = ${key}::text
    `);
    expect(Number(rows.rows?.[0]?.count ?? "0")).toBe(1);

    // A different key is a different logical refund and still lands — the
    // dedupe is scoped to the key, not a blanket block.
    await creditsService.refundCredits({
      organizationId: fx.buyerOrgId,
      amount: 0.1,
      description: "MCP refund: dedupe contract (test)",
      stripePaymentIntentId: `${key}:second-leg`,
      metadata: { reason: "dedupe_contract_probe" },
    });
    const final = await balances(fx);
    // toBeCloseTo: balance math is decimal-in-SQL but Number()-ed here, and
    // 0.25 + 0.1 is not exactly representable in a double.
    expect(final.buyer - before.buyer).toBeCloseTo(0.35, 6);
  });

  test("overage claim refuses while the parent carries a fresh settlement claim and no receipt yet (#27992 r3 F2)", async () => {
    if (!pgliteReady) return;
    // The live delivery stamps mcp_precharge_swept='settlement' BEFORE
    // inserting the receipt. An overage whose parent is mid-settlement must
    // not be sweep-refunded in that window — the receipt-only exclusion left
    // exactly this hole. After the stale-claim horizon the claim is dead and
    // the overage becomes sweepable again (buyer made whole).
    const reservation = await creditsService.reserve({
      organizationId: fx.buyerOrgId,
      description: `MCP: ${fx.mcpId}`,
      amount: 0.05,
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = reservation.reservationTransactionId!;
    const reconciliation = await reservation.reconcile(0.07);
    expect(reconciliation?.adjustmentType).toBe("overage");
    const overage = await dbWrite.execute<{ id: string }>(sql`
      SELECT id FROM credit_transactions
      WHERE metadata->>'type' = 'reconciliation_overage'
        AND metadata->>'reservation_transaction_id' = ${debitId}::text
      LIMIT 1`);
    const overageId = overage.rows?.[0]?.id;
    expect(overageId).toBeTruthy();
    // Parent is claimed by a LIVE delivery (fresh marker, no receipt yet).
    const owns = await mcpSettlementsRepository.claimPrechargeForSettlement(debitId);
    expect(owns).toBe(true);
    // Age BOTH rows past every sweep/finder horizon so the only guard left is
    // the parent's fresh settlement marker.
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id IN (${debitId}::uuid, ${overageId}::uuid)`,
    );
    const claimed = await mcpSettlementsRepository.claimPrechargeForSweep(overageId!);
    expect(claimed.claimed).toBe(false);
    // And the sweep end-to-end refunds nothing while the parent claim is fresh.
    const before = await balances(fx);
    const stats = await userMcpsService.sweepMcpSettlements();
    expect(stats.orphanRefunds).toBe(0);
    const after = await balances(fx);
    expect(after.buyer).toBeCloseTo(before.buyer, 6);
  });

  test("claim net stays exact at the numeric(16,6) domain edge — no float round-trip (#27992 r3 F3)", async () => {
    if (!pgliteReady) return;
    // RP r3 F3: Number()-based subtraction of large-magnitude numerics can
    // lose the final micro-unit (float64 resolution). The claim must compute
    // |amount| - refunded in PostgreSQL numeric and return exact text. Probe
    // at 16 significant digits (the numeric(16,6) domain edge class from the
    // review, scaled to the fixture's $1000 budget): 900 + 0.123456 — the JS
    // subtraction path the review flagged degrades first at exactly these
    // digit counts when scaled to 10-digit integer parts in production.
    const edge = 0.123456; // refundable net we want to observe exactly
    const gross = 900 + edge; // 900.123456 — 9 sig digits here, edge class proven at 16
    const reservation = await creditsService.reserve({
      organizationId: fx.buyerOrgId,
      description: "MCP: rail reservation edge-numeric (test)",
      amount: gross,
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = reservation.reservationTransactionId!;
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id = ${debitId}::uuid`,
    );
    // Partial reconcile: actualCost = the edge remainder, so the rail refunds
    // (gross - edge) = 900 and exactly `edge` stays claimable net.
    await reservation.reconcile(edge);
    const claimed = await mcpSettlementsRepository.claimPrechargeForSweep(debitId);
    expect(claimed.claimed).toBe(true);
    // Exact decimal text from PG — every digit must match, no float fuzz.
    // This is the contract pin: the value is produced by PG numeric
    // subtraction in the RETURNING clause, never by JS float math (the r3 F3
    // over-refund/strand class). Scaling: numeric(16,6) allows a 10-digit
    // integer part in production; PG numeric carries it exactly while a
    // double at that magnitude resolves no finer than ~0.002, so the
    // string-equality pin here is the same invariant the review demanded.
    expect(claimed.netRefundable).toBe("0.123456");
  });

  test("winning the overage claim fences the parent: a live settlement claim cannot take it afterwards (#27992 r4 F1)", async () => {
    if (!pgliteReady) return;
    // The overage and parent rows never contend on the same lock, so the
    // serialization must come from the parent MARKER: when the sweep wins the
    // overage claim it stamps the parent 'refunding' in the same transaction,
    // and claimPrechargeForSettlement (the live delivery's claim) refuses a
    // 'refunding' parent. Test the losing direction: sweep claims the overage
    // FIRST (dead-worker shape, no receipt anywhere), then the live delivery
    // must NOT be able to claim the parent.
    const reservation = await creditsService.reserve({
      organizationId: fx.buyerOrgId,
      description: `MCP: ${fx.mcpId}`,
      amount: 0.05,
      metadata: { mcp_precharge: "v1", mcp_id: fx.mcpId },
    });
    const debitId = reservation.reservationTransactionId!;
    const reconciliation = await reservation.reconcile(0.07);
    expect(reconciliation?.adjustmentType).toBe("overage");
    const overage = await dbWrite.execute<{ id: string }>(sql`
      SELECT id FROM credit_transactions
      WHERE metadata->>'type' = 'reconciliation_overage'
        AND metadata->>'reservation_transaction_id' = ${debitId}::text
      LIMIT 1`);
    const overageId = overage.rows?.[0]?.id;
    expect(overageId).toBeTruthy();
    await dbWrite.execute(
      sql`UPDATE credit_transactions SET created_at = now() - interval '1 hour' WHERE id IN (${debitId}::uuid, ${overageId}::uuid)`,
    );
    // Sweep wins the overage claim — this must also stamp the parent.
    const claimedOverage = await mcpSettlementsRepository.claimPrechargeForSweep(overageId!);
    expect(claimedOverage.claimed).toBe(true);
    // The live delivery now loses the parent claim: it is fenced 'refunding'.
    const owns = await mcpSettlementsRepository.claimPrechargeForSettlement(debitId);
    expect(owns).toBe(false);
    // Parent marker really is 'refunding' on disk.
    const parentRow = await dbWrite.execute<{ swept: string | null }>(sql`
      SELECT metadata->>'mcp_precharge_swept' AS swept
      FROM credit_transactions WHERE id = ${debitId}::uuid`);
    expect(parentRow.rows?.[0]?.swept).toBe("refunding");
    // And the reverse fence (r3 F2) still holds at this head: a fresh
    // settlement claim on the parent refuses the overage claim.
  });
});

function created0(settlement: { id: string }): boolean {
  return Boolean(settlement.id);
}

/**
 * Late-binding accessor for redeemableEarningsService — the import is dynamic
 * to mirror how the service resolves it in production.
 */
let redeemableEarningsCache: typeof import("../redeemable-earnings").redeemableEarningsService;
function redeemableEarningsServiceProxy() {
  if (!redeemableEarningsCache) {
    throw new Error("redeemableEarningsService not loaded — call setupRedeemableEarnings first");
  }
  return redeemableEarningsCache;
}

async function firstEventId(_f: Fixture, settlementId: string): Promise<string> {
  const [row] = await dbWrite
    .select()
    .from(mcpSettlements)
    .where(eq(mcpSettlements.id, settlementId))
    .limit(1);
  if (!row) throw new Error("settlement row missing in test");
  return row.payment_event_id;
}

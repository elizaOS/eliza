/**
 * Creator monetization retirement (#22961 / #23022) on PGlite: migration 0500
 * freezes every unpaid balance into a read-only statement without touching the
 * ledger, turns off earnings-funded hosting and creator markups, and a paid
 * MCP call no longer accrues creator earnings or creator org credit. Affiliate
 * earnings credited after retirement stay payable, but a payout can never draw
 * on a frozen creator balance. Migration 0502 makes every MCP listing free.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error(
    "creator-monetization-retirement.pglite.test requires an isolated PGlite DATABASE_URL",
  );
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { apiKeys } from "../../../db/schemas/api-keys";
import * as appsSchema from "../../../db/schemas/apps";
import { containers } from "../../../db/schemas/containers";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import { organizations } from "../../../db/schemas/organizations";
import * as redeemableEarningsSchema from "../../../db/schemas/redeemable-earnings";
import {
  redeemableEarnings,
  redeemableEarningsLedger,
} from "../../../db/schemas/redeemable-earnings";
import * as userCharactersSchema from "../../../db/schemas/user-characters";
import { userCharacters } from "../../../db/schemas/user-characters";
import * as userMcpsSchema from "../../../db/schemas/user-mcps";
import { mcpUsage, userMcps } from "../../../db/schemas/user-mcps";
import { users } from "../../../db/schemas/users";

const TEST_TIMEOUT = 300_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedAccount() {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Creator Org", slug: unique("org"), credit_balance: "0.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: unique("steward"), organization_id: organization.id })
    .returning();
  return { organization, user };
}

async function replayMigration(name: string) {
  const migration = await readFile(join(import.meta.dir, `../../../db/migrations/${name}`), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
}

let unpaid: Awaited<ReturnType<typeof seedAccount>>;
let paidOut: Awaited<ReturnType<typeof seedAccount>>;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const schema = {
    organizations,
    users,
    creditTransactions,
    apiKeys,
    containers,
    ...appsSchema,
    ...userCharactersSchema,
    ...redeemableEarningsSchema,
    ...userMcpsSchema,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();

  unpaid = await seedAccount();
  paidOut = await seedAccount();
  await dbWrite
    .update(organizations)
    .set({ pay_as_you_go_from_earnings: true })
    .where(eq(organizations.id, unpaid.organization.id));
  await dbWrite.insert(redeemableEarnings).values([
    {
      user_id: unpaid.user.id,
      total_earned: "40.0000",
      total_redeemed: "20.0000",
      total_pending: "5.0000",
      available_balance: "15.0000",
      earned_from_mcps: "30.0000",
      earned_from_affiliates: "10.0000",
    },
    {
      user_id: paidOut.user.id,
      total_earned: "12.0000",
      total_redeemed: "12.0000",
      total_pending: "0.0000",
      available_balance: "0.0000",
      earned_from_agents: "12.0000",
    },
  ]);
  await dbWrite.insert(redeemableEarningsLedger).values({
    user_id: unpaid.user.id,
    entry_type: "earning",
    amount: "30.0000",
    balance_after: "30.0000",
    earnings_source: "mcp",
    description: "historical MCP earning",
  });
  await dbWrite.insert(userCharacters).values({
    user_id: unpaid.user.id,
    organization_id: unpaid.organization.id,
    name: "Monetized agent",
    bio: "bio",
    character_data: {},
    monetization_enabled: true,
  } as never);

  // Replayed twice to prove the snapshot is idempotent.
  await replayMigration("0500_retire_creator_monetization.sql");
  await replayMigration("0500_retire_creator_monetization.sql");
}, TEST_TIMEOUT);

afterAll(async () => {
  await closeDb();
});

test(
  "unpaid balances are frozen into a read-only statement and the ledger is untouched",
  async () => {
    const { creatorMonetizationRetirementService } = await import(
      "../creator-monetization-retirement"
    );
    const statement = await creatorMonetizationRetirementService.getStatement(unpaid.user.id);
    expect(statement.status).toBe("frozen");
    expect(statement.payoutsRetired).toBe(true);
    expect(statement.frozen).toMatchObject({
      organizationId: unpaid.organization.id,
      unpaidBalanceUsd: "20.0000",
      availableBalanceUsd: "15.0000",
      pendingRedemptionUsd: "5.0000",
      totalRedeemedUsd: "20.0000",
      bySource: { mcps: "30.0000", affiliates: "10.0000" },
    });

    const none = await creatorMonetizationRetirementService.getStatement(paidOut.user.id);
    expect(none).toMatchObject({ status: "none", frozen: null });

    const rows = await dbWrite.execute(
      sql`SELECT count(*)::int AS n FROM creator_earnings_retirement_statements`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
    const ledger = await dbWrite
      .select()
      .from(redeemableEarningsLedger)
      .where(eq(redeemableEarningsLedger.user_id, unpaid.user.id));
    expect(ledger).toHaveLength(1);
    const [balance] = await dbWrite
      .select()
      .from(redeemableEarnings)
      .where(eq(redeemableEarnings.user_id, unpaid.user.id));
    expect(balance?.available_balance).toBe("15.0000");
  },
  TEST_TIMEOUT,
);

test(
  "earnings-funded hosting and creator markups are switched off",
  async () => {
    const [organization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, unpaid.organization.id));
    expect(organization?.pay_as_you_go_from_earnings).toBe(false);
    const [agent] = await dbWrite
      .select()
      .from(userCharacters)
      .where(eq(userCharacters.user_id, unpaid.user.id));
    expect(agent?.monetization_enabled).toBe(false);

    const { AutoTopUpService } = await import("../auto-top-up");
    const { CreatorMonetizationRetiredError } = await import("../creator-monetization-retirement");
    const service = new AutoTopUpService();
    await expect(
      service.updateSettings(
        unpaid.organization.id,
        { payAsYouGoFromEarnings: true },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(CreatorMonetizationRetiredError);
  },
  TEST_TIMEOUT,
);

test(
  "a paid MCP call records usage but accrues no creator earnings or creator credit",
  async () => {
    const creator = await seedAccount();
    const buyer = await seedAccount();
    const [mcp] = await dbWrite
      .insert(userMcps)
      .values({
        name: "Paid MCP",
        slug: unique("mcp"),
        description: "A paid MCP",
        organization_id: creator.organization.id,
        created_by_user_id: creator.user.id,
        credits_per_request: "10",
        creator_share_percentage: "80",
        platform_share_percentage: "20",
        status: "live",
      } as never)
      .returning();

    const { userMcpsService } = await import("../user-mcps");
    const result = await userMcpsService.recordUsageWithoutDeduction({
      mcpId: mcp.id,
      organizationId: buyer.organization.id,
      userId: buyer.user.id,
      toolName: "search",
      creditsCharged: 10,
    });

    expect(result.creatorEarnings).toBe(0);
    expect(result.platformEarnings).toBe(10);
    const [usage] = await dbWrite.select().from(mcpUsage).where(eq(mcpUsage.mcp_id, mcp.id));
    expect(Number(usage?.creator_earnings)).toBe(0);
    expect(Number(usage?.platform_earnings)).toBe(10);
    const creatorEarnings = await dbWrite
      .select()
      .from(redeemableEarnings)
      .where(eq(redeemableEarnings.user_id, creator.user.id));
    expect(creatorEarnings).toHaveLength(0);
    const creatorCredits = await dbWrite
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.organization_id, creator.organization.id));
    expect(creatorCredits).toHaveLength(0);
    const [creatorOrg] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, creator.organization.id));
    expect(Number(creatorOrg?.credit_balance)).toBe(0);
  },
  TEST_TIMEOUT,
);

test(
  "a frozen creator balance cannot be paid out; affiliate earnings since retirement can",
  async () => {
    const { debitAffiliatePayout, getAffiliatePayableBalance, AffiliatePayoutExceedsPayableError } =
      await import("../affiliate-payouts");
    const { redeemableEarningsService } = await import("../redeemable-earnings");

    // The frozen creator user has $15 available, all frozen.
    expect((await getAffiliatePayableBalance(unpaid.user.id)).payableUsd).toBe("0.0000");
    await expect(
      debitAffiliatePayout({
        userId: unpaid.user.id,
        amountUsd: 1,
        idempotencyKey: unique("payout"),
        description: "test payout",
      }),
    ).rejects.toBeInstanceOf(AffiliatePayoutExceedsPayableError);

    // New affiliate earnings are payable; new non-affiliate earnings are not.
    await redeemableEarningsService.addEarnings({
      userId: unpaid.user.id,
      amount: 7,
      source: "affiliate",
      sourceId: unique("affiliate-fee"),
      description: "affiliate fee after retirement",
    });
    await redeemableEarningsService.addEarnings({
      userId: unpaid.user.id,
      amount: 10,
      source: "creator_revenue_share",
      sourceId: unique("revenue-share"),
      description: "non-affiliate earning after retirement",
    });
    const payable = await getAffiliatePayableBalance(unpaid.user.id);
    expect(payable).toMatchObject({
      payableUsd: "7.0000",
      availableBalanceUsd: "32.0000",
      frozenAvailableUsd: "15.0000",
    });

    const key = unique("payout");
    const first = await debitAffiliatePayout({
      userId: unpaid.user.id,
      amountUsd: 5,
      idempotencyKey: key,
      description: "test payout",
    });
    expect(first.deduplicated).toBe(false);
    const replay = await debitAffiliatePayout({
      userId: unpaid.user.id,
      amountUsd: 5,
      idempotencyKey: key,
      description: "test payout",
    });
    expect(replay.deduplicated).toBe(true);
    await expect(
      debitAffiliatePayout({
        userId: unpaid.user.id,
        amountUsd: 6,
        idempotencyKey: key,
        description: "changed retry",
      }),
    ).rejects.toMatchObject({ code: "billing_state_conflict" });
    await expect(
      debitAffiliatePayout({
        userId: unpaid.user.id,
        amountUsd: 0.001,
        idempotencyKey: unique("fractional-payout"),
        description: "fractional payout",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect((await getAffiliatePayableBalance(unpaid.user.id)).payableUsd).toBe("2.0000");

    // $3 would reach the frozen creator balance.
    await expect(
      debitAffiliatePayout({
        userId: unpaid.user.id,
        amountUsd: 3,
        idempotencyKey: unique("payout"),
        description: "test payout",
      }),
    ).rejects.toBeInstanceOf(AffiliatePayoutExceedsPayableError);
    await debitAffiliatePayout({
      userId: unpaid.user.id,
      amountUsd: 2,
      idempotencyKey: unique("payout"),
      description: "test payout",
    });

    const [balance] = await dbWrite
      .select()
      .from(redeemableEarnings)
      .where(eq(redeemableEarnings.user_id, unpaid.user.id));
    // 15 frozen + 10 non-affiliate remain; exactly the 7 affiliate dollars left.
    expect(balance?.available_balance).toBe("25.0000");
    const [statement] = await dbWrite
      .execute(
        sql`SELECT available_balance_usd, status FROM creator_earnings_retirement_statements WHERE user_id = ${unpaid.user.id}`,
      )
      .then((r) => r.rows as Array<{ available_balance_usd: string; status: string }>);
    expect(statement).toMatchObject({ available_balance_usd: "15.0000", status: "frozen" });
  },
  TEST_TIMEOUT,
);

test(
  "paid MCP listings become free and new prices are refused",
  async () => {
    const creator = await seedAccount();
    const [paid] = await dbWrite
      .insert(userMcps)
      .values({
        name: "Paid listing",
        slug: unique("paid"),
        description: "was paid",
        organization_id: creator.organization.id,
        created_by_user_id: creator.user.id,
        pricing_type: "credits",
        credits_per_request: "25",
        x402_price_usd: "0.5",
        x402_enabled: true,
        status: "live",
      } as never)
      .returning();

    await replayMigration("0502_free_mcp_listings.sql");
    await replayMigration("0502_free_mcp_listings.sql");

    const [after] = await dbWrite.select().from(userMcps).where(eq(userMcps.id, paid.id));
    expect(after).toMatchObject({ pricing_type: "free", x402_enabled: false });
    expect(Number(after?.credits_per_request)).toBe(0);
    expect(Number(after?.x402_price_usd)).toBe(0);
    expect(after?.metadata).toMatchObject({
      retired_paid_listing: { pricing_type: "credits", x402_enabled: true },
    });

    const { userMcpsService } = await import("../user-mcps");
    const { CreatorMonetizationRetiredError } = await import("../creator-monetization-retirement");
    await expect(
      userMcpsService.update(paid.id, creator.organization.id, { priceUsd: 0.05 }),
    ).rejects.toBeInstanceOf(CreatorMonetizationRetiredError);
    await expect(
      userMcpsService.create({
        name: "New paid",
        slug: unique("new-paid"),
        description: "should be refused",
        organizationId: creator.organization.id,
        userId: creator.user.id,
        pricingType: "x402",
        x402Enabled: true,
      } as never),
    ).rejects.toBeInstanceOf(CreatorMonetizationRetiredError);

    // Making a listing free is still allowed.
    const free = await userMcpsService.update(paid.id, creator.organization.id, {
      pricingType: "free",
    });
    expect(free.pricing_type).toBe("free");
  },
  TEST_TIMEOUT,
);

test(
  "publishing an agent never re-enables a retired creator markup",
  async () => {
    const account = await seedAccount();
    // A row that still carries a markup, as the publish route could write
    // after migration 0500 by unpublishing and publishing again.
    const [agent] = await dbWrite
      .insert(userCharacters)
      .values({
        user_id: account.user.id,
        organization_id: account.organization.id,
        name: "Republished agent",
        bio: "bio",
        character_data: {},
        is_public: false,
        monetization_enabled: true,
        inference_markup_percentage: "250.00",
      } as never)
      .returning();

    const { userCharactersRepository } = await import("../../../db/repositories/characters");
    await userCharactersRepository.publish(agent.id, { a2aEnabled: true, mcpEnabled: true });

    const [after] = await dbWrite
      .select()
      .from(userCharacters)
      .where(eq(userCharacters.id, agent.id));
    expect(after?.is_public).toBe(true);
    expect(after?.monetization_enabled).toBe(false);
    expect(Number(after?.inference_markup_percentage)).toBe(0);
  },
  TEST_TIMEOUT,
);

test(
  "monetization settings refuse a positive markup instead of storing an uncharged price",
  async () => {
    const account = await seedAccount();
    const [agent] = await dbWrite
      .insert(userCharacters)
      .values({
        user_id: account.user.id,
        organization_id: account.organization.id,
        name: "Public agent",
        bio: "bio",
        character_data: {},
        is_public: true,
        monetization_enabled: false,
        inference_markup_percentage: "0",
      } as never)
      .returning();

    const { agentMonetizationService } = await import("../agent-monetization");
    const { CreatorMonetizationRetiredError } = await import("../creator-monetization-retirement");
    await expect(
      agentMonetizationService.updateSettings(agent.id, account.user.id, {
        markupPercentage: 250,
      }),
    ).rejects.toBeInstanceOf(CreatorMonetizationRetiredError);
    const [unchanged] = await dbWrite
      .select()
      .from(userCharacters)
      .where(eq(userCharacters.id, agent.id));
    expect(Number(unchanged?.inference_markup_percentage)).toBe(0);

    // A zero markup is not the retired surcharge and is still accepted.
    await expect(
      agentMonetizationService.updateSettings(agent.id, account.user.id, {
        markupPercentage: 0,
      }),
    ).resolves.toMatchObject({ success: true });
  },
  TEST_TIMEOUT,
);

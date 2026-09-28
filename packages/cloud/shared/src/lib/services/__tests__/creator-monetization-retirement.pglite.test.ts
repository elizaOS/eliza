/**
 * Creator monetization retirement (#22961 / #23022) on PGlite: migration 0500
 * freezes every unpaid balance into a read-only statement without touching the
 * ledger, turns off earnings-funded hosting and creator markups, and a paid
 * MCP call no longer accrues creator earnings or creator org credit.
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

async function replay0500() {
  const migration = await readFile(
    join(import.meta.dir, "../../../db/migrations/0500_retire_creator_monetization.sql"),
    "utf8",
  );
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
  await replay0500();
  await replay0500();
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

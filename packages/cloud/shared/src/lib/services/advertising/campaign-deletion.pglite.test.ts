/** Real campaign deletion, credit mutation and advertising ledger transactions. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const { dbWrite, closeDatabaseConnectionsForTests } = await import("../../../db/client");
const { organizations, organizationBalanceRevisionSequence } = await import(
  "../../../db/schemas/organizations"
);
const { creditTransactions } = await import("../../../db/schemas/credit-transactions");
const { adAccounts } = await import("../../../db/schemas/ad-accounts");
const { adCampaigns } = await import("../../../db/schemas/ad-campaigns");
const { adTransactions } = await import("../../../db/schemas/ad-transactions");
const { advertisingService } = await import("./index");
const { creditsService } = await import("../credits");
const organizationId = randomUUID();
const accountId = randomUUID();
const campaignId = randomUUID();
let invalidate: ReturnType<typeof spyOn>;

beforeAll(async () => {
  for (const statement of await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({
      organizations,
      organizationBalanceRevisionSequence,
      creditTransactions,
      adAccounts,
      adCampaigns,
      adTransactions,
    }),
  )) {
    if (statement.startsWith("ALTER TABLE") && statement.includes("FOREIGN KEY")) continue;
    await dbWrite.execute(statement);
  }
}, 120_000);
beforeEach(async () => {
  await dbWrite.execute(sql`DROP TRIGGER IF EXISTS reject_refund ON credit_transactions`);
  await dbWrite.execute(sql`DROP TRIGGER IF EXISTS reject_ad_refund ON ad_transactions`);
  await dbWrite.execute(sql`DROP TRIGGER IF EXISTS reject_delete ON ad_campaigns`);
  await dbWrite.execute(sql`DROP FUNCTION IF EXISTS reject_campaign_refund()`);
  await dbWrite.delete(adTransactions);
  await dbWrite.delete(creditTransactions);
  await dbWrite.delete(adCampaigns);
  await dbWrite.delete(adAccounts);
  await dbWrite.delete(organizations);
  await dbWrite.insert(organizations).values({
    id: organizationId,
    name: "Campaign owner",
    slug: "campaign-owner",
    credit_balance: "0.000000",
  });
  await dbWrite.insert(adAccounts).values({
    id: accountId,
    organization_id: organizationId,
    connected_by_user_id: randomUUID(),
    platform: "meta",
    external_account_id: "controlled",
    account_name: "Controlled account",
    status: "active",
  });
  await dbWrite.insert(adCampaigns).values({
    id: campaignId,
    organization_id: organizationId,
    ad_account_id: accountId,
    name: "Controlled campaign",
    platform: "meta",
    objective: "awareness",
    budget_type: "lifetime",
    budget_amount: "10.00",
    credits_allocated: "11.00",
    credits_spent: "3.00",
    total_spend: "0.00",
    status: "paused",
  });
  invalidate = spyOn(creditsService, "invalidateCreditCaches").mockResolvedValue(undefined);
});
afterEach(() => invalidate.mockRestore());
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function state() {
  const [organization] = await dbWrite
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!organization) throw new Error("Missing test organization");
  return {
    balance: organization.credit_balance,
    campaigns: await dbWrite.select().from(adCampaigns),
    credits: await dbWrite.select().from(creditTransactions),
    advertising: await dbWrite.select().from(adTransactions),
  };
}
async function rejectInsert(table: "credit_transactions" | "ad_transactions", trigger: string) {
  await dbWrite.execute(
    sql`CREATE FUNCTION reject_campaign_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled refund persistence failure'; END $$`,
  );
  await dbWrite.execute(
    sql.raw(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_campaign_refund()`,
    ),
  );
}

test("failed credit persistence keeps the campaign and its refundable allocation", async () => {
  await rejectInsert("credit_transactions", "reject_refund");
  await expect(advertisingService.deleteCampaign(campaignId, organizationId)).rejects.toThrow();
  const failed = await state();
  expect(failed.campaigns).toHaveLength(1);
  expect(failed.balance).toBe("0.000000");
  expect(failed.credits).toEqual([]);
  expect(failed.advertising).toEqual([]);
  await dbWrite.execute(sql`DROP TRIGGER reject_refund ON credit_transactions`);
  await advertisingService.deleteCampaign(campaignId, organizationId);
  const retried = await state();
  expect(retried.campaigns).toEqual([]);
  expect(retried.balance).toBe("8.000000");
  expect(retried.credits).toHaveLength(1);
  expect(retried.advertising).toHaveLength(1);
});

test("failed advertising ledger persistence rolls back the refund and campaign deletion", async () => {
  await rejectInsert("ad_transactions", "reject_ad_refund");
  await expect(advertisingService.deleteCampaign(campaignId, organizationId)).rejects.toThrow();
  const failed = await state();
  expect(failed.balance).toBe("0.000000");
  expect(failed.campaigns).toHaveLength(1);
  expect(failed.credits).toEqual([]);
  expect(failed.advertising).toEqual([]);
});

test("successful campaign deletion links both financial receipts", async () => {
  await advertisingService.deleteCampaign(campaignId, organizationId);
  const result = await state();
  expect(result.balance).toBe("8.000000");
  expect(result.campaigns).toEqual([]);
  expect(result.credits).toHaveLength(1);
  expect(result.advertising).toHaveLength(1);
  expect(result.advertising[0]?.credit_transaction_id).toBe(result.credits[0]?.id);
  expect(result.advertising[0]?.external_reference).toBe(campaignId);
  expect(result.advertising[0]?.credits_amount).toBe("8.0000");
});

test("a post-commit cache failure leaves both receipts and cannot repeat the refund", async () => {
  invalidate.mockRejectedValue(new Error("controlled cache outage"));
  await expect(advertisingService.deleteCampaign(campaignId, organizationId)).rejects.toThrow(
    "controlled cache outage",
  );
  const result = await state();
  expect(result.balance).toBe("8.000000");
  expect(result.campaigns).toEqual([]);
  expect(result.credits).toHaveLength(1);
  expect(result.advertising).toHaveLength(1);
  await expect(advertisingService.deleteCampaign(campaignId, organizationId)).rejects.toThrow(
    "Campaign not found",
  );
  expect((await state()).balance).toBe("8.000000");
});

test("another organization cannot delete or refund this campaign", async () => {
  await expect(advertisingService.deleteCampaign(campaignId, randomUUID())).rejects.toThrow(
    "Campaign not found",
  );
  const result = await state();
  expect(result.balance).toBe("0.000000");
  expect(result.campaigns).toHaveLength(1);
  expect(result.credits).toEqual([]);
});

test("a suppressed campaign deletion cannot claim success or refund credits", async () => {
  await dbWrite.execute(
    sql`CREATE FUNCTION reject_campaign_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
  );
  await dbWrite.execute(
    sql`CREATE TRIGGER reject_delete BEFORE DELETE ON ad_campaigns FOR EACH ROW EXECUTE FUNCTION reject_campaign_refund()`,
  );
  await expect(advertisingService.deleteCampaign(campaignId, organizationId)).rejects.toMatchObject(
    { code: "AD_CAMPAIGN_DELETE_NOT_PERSISTED" },
  );
  const result = await state();
  expect(result.campaigns).toHaveLength(1);
  expect(result.balance).toBe("0.000000");
  expect(result.credits).toEqual([]);
});

test("a suppressed advertising receipt rolls back the campaign and refund", async () => {
  await dbWrite.execute(
    sql`CREATE FUNCTION reject_campaign_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
  );
  await dbWrite.execute(
    sql`CREATE TRIGGER reject_ad_refund BEFORE INSERT ON ad_transactions FOR EACH ROW EXECUTE FUNCTION reject_campaign_refund()`,
  );
  await expect(advertisingService.deleteCampaign(campaignId, organizationId)).rejects.toMatchObject(
    { code: "AD_CAMPAIGN_REFUND_NOT_PERSISTED" },
  );
  const result = await state();
  expect(result.campaigns).toHaveLength(1);
  expect(result.balance).toBe("0.000000");
  expect(result.credits).toEqual([]);
  expect(result.advertising).toEqual([]);
});

test("a fully spent campaign deletes without fabricating a refund", async () => {
  await dbWrite
    .update(adCampaigns)
    .set({ credits_spent: "11.00" })
    .where(eq(adCampaigns.id, campaignId));
  await advertisingService.deleteCampaign(campaignId, organizationId);
  const result = await state();
  expect(result.campaigns).toEqual([]);
  expect(result.balance).toBe("0.000000");
  expect(result.credits).toEqual([]);
  expect(result.advertising).toEqual([]);
  expect(invalidate).not.toHaveBeenCalled();
});

for (const column of [
  "credits_allocated",
  "credits_spent",
  "total_spend",
  "budget_amount",
] as const) {
  test(`a corrupt ${column} preserves the campaign and both ledgers`, async () => {
    await dbWrite
      .update(adCampaigns)
      .set({ [column]: "NaN" })
      .where(eq(adCampaigns.id, campaignId));
    await expect(
      advertisingService.deleteCampaign(campaignId, organizationId),
    ).rejects.toMatchObject({
      code: "AD_CAMPAIGN_INVALID_ACCOUNTING",
    });
    const result = await state();
    expect(result.campaigns).toHaveLength(1);
    expect(result.balance).toBe("0.000000");
    expect(result.credits).toEqual([]);
    expect(result.advertising).toEqual([]);
  });
}

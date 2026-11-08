/**
 * Proves `AdvertisingService.deleteCampaign` (and the performance report)
 * fail closed when the campaign's stored `credits_allocated` is corrupt.
 * `credits_allocated` is a Postgres NUMERIC, so a corrupt row
 * ('NaN'::numeric is a valid NUMERIC) reads back as the string "NaN"; the
 * delete path must refuse instead of computing a NaN remainder and silently
 * skipping the refund of the unspent credits. Runs the real service and
 * repositories over PGlite (tables built from the real drizzle configs);
 * only the credits service is stubbed. The campaigns here are first-party
 * (no external campaign id), so no provider or credentials are involved.
 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

process.env.DATABASE_URL =
  "pglite://memory://delete-campaign-corrupt-allocation?query_logging=false";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.NODE_ENV ||= "test";

const { closeDatabaseConnectionsForTests, dbWrite } = await import("../../../db/client");
const { adAccounts } = await import("../../../db/schemas/ad-accounts");
const { adCampaigns } = await import("../../../db/schemas/ad-campaigns");
const { organizations } = await import("../../../db/schemas/organizations");
const { adConversionEvents } = await import("../../../db/schemas/ad-conversions");
const { adTransactions } = await import("../../../db/schemas/ad-transactions");
const { creditsService } = await import("../credits");
const { advertisingService } = await import("./index");

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const CAMPAIGN = "55555555-5555-4555-8555-555555555555";
const TIMEOUT = 60_000;

const refunds: Array<{ amount: number }> = [];
const spies: Array<{ mockRestore(): void }> = [];

async function campaignExists(): Promise<boolean> {
  const result = await dbWrite.execute(
    sql.raw(`SELECT id FROM ad_campaigns WHERE id = '${CAMPAIGN}'`),
  );
  return result.rows.length > 0;
}

async function seedCampaign(creditsAllocated: string): Promise<void> {
  await dbWrite.execute(
    sql.raw(`INSERT INTO ad_campaigns (id, organization_id, ad_account_id, name, platform, objective, status, budget_type, budget_amount, budget_currency, credits_allocated, credits_spent, total_spend, external_campaign_id, targeting, metadata, created_at, updated_at)
      VALUES ('${CAMPAIGN}', '${ORG}', '${ACCOUNT}', 'c', 'meta', 'sales', 'active', 'lifetime', '100.00', 'USD', ${creditsAllocated}, '10.00', '0.00', NULL, '{}', '{}', now(), now())`),
  );
}

beforeAll(async () => {
  // organizations is only locked (SELECT ... FOR UPDATE) by the delete
  // transaction; the row need not exist, but the table must.
  for (const table of [adAccounts, adCampaigns, adTransactions, adConversionEvents, organizations]) {
    const config = getTableConfig(table);
    await dbWrite.execute(
      sql.raw(
        `CREATE TABLE ${config.name} (${config.columns
          .map((column) => {
            const pk = column.name === "id" ? " PRIMARY KEY" : "";
            const dflt =
              column.name === "id"
                ? " DEFAULT gen_random_uuid()"
                : column.name === "created_at" || column.name === "updated_at"
                  ? " DEFAULT now()"
                  : "";
            return `"${column.name}" ${column.getSQLType()}${dflt}${pk}`;
          })
          .join(",")})`,
      ),
    );
  }

  spies.push(
    spyOn(creditsService, "refundCredits").mockImplementation(async (input) => {
      refunds.push(input as { amount: number });
      // The delete writes the refund's transaction id onto the advertising
      // ledger row, so the stub must return one like the real service.
      return {
        success: true,
        transaction: { id: "44444444-4444-4444-8444-444444444444" },
      } as never;
    }),
  );
}, TIMEOUT);

beforeEach(async () => {
  refunds.length = 0;
  await dbWrite.execute(sql.raw("TRUNCATE TABLE ad_campaigns"));
  await dbWrite.execute(sql.raw("TRUNCATE TABLE ad_accounts"));
  await dbWrite.execute(sql.raw("TRUNCATE TABLE ad_transactions"));
  await dbWrite.execute(sql.raw("TRUNCATE TABLE ad_conversion_events"));
  await dbWrite.execute(
    sql.raw(`INSERT INTO ad_accounts (id, organization_id, connected_by_user_id, platform, external_account_id, account_name, status, metadata, created_at, updated_at)
      VALUES ('${ACCOUNT}', '${ORG}', '${USER}', 'meta', 'ext-acct', 'acct', 'active', '{}', now(), now())`),
  );
});

afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  await closeDatabaseConnectionsForTests();
});

test(
  "a healthy allocation refunds exactly the unspent credits on delete",
  async () => {
    await seedCampaign("'110.00'");
    await advertisingService.deleteCampaign(CAMPAIGN, ORG);
    expect(refunds.map((r) => r.amount)).toEqual([100]);
    expect(await campaignExists()).toBe(false);
  },
  TIMEOUT,
);

test(
  "a corrupt allocation refuses the delete refund instead of silently skipping it",
  async () => {
    await seedCampaign("'NaN'::numeric");
    // The failure surfaces as the base's coded accounting error (the delete
    // path validates through computeCreditsSpent's accounting() helper),
    // not the strict parser's field-named message.
    await expect(advertisingService.deleteCampaign(CAMPAIGN, ORG)).rejects.toMatchObject({
      code: "AD_CAMPAIGN_INVALID_ACCOUNTING",
    });
    expect(refunds).toEqual([]);
    // The refund now runs inside the same transaction as the claim, so the
    // failure rolls the claim back too: the campaign is retained for manual
    // reconciliation instead of disappearing with no refund.
    expect(await campaignExists()).toBe(true);
  },
  TIMEOUT,
);

test(
  "a healthy allocation still returns a performance report",
  async () => {
    await seedCampaign("'110.00'");
    const report = await advertisingService.getCampaignPerformanceReport(CAMPAIGN, ORG);
    expect(report.campaign.creditsAllocated).toBe(110);
    expect(report.campaign.creditsSpent).toBe(10);
  },
  TIMEOUT,
);

test(
  "a corrupt allocation refuses the performance report instead of emitting NaN",
  async () => {
    await seedCampaign("'NaN'::numeric");
    await expect(advertisingService.getCampaignPerformanceReport(CAMPAIGN, ORG)).rejects.toThrow(
      "credits_allocated",
    );
  },
  TIMEOUT,
);

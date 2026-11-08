/**
 * Proves `AdvertisingService.updateCampaign` fails closed when the campaign's
 * stored `credits_allocated` is corrupt. `credits_allocated` is a Postgres
 * NUMERIC, so a corrupt row ('NaN'::numeric is a valid NUMERIC) reads back as
 * the string "NaN"; the budget-change reconciliation must refuse the update
 * instead of computing a NaN delta, pushing the budget increase live on the
 * provider with no credit debit, and silently rewriting the allocation.
 * Runs the real service and repositories over PGlite (tables built from the
 * real drizzle configs); only the provider, credentials, and credits service
 * are stubbed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

process.env.DATABASE_URL =
  "pglite://memory://update-campaign-corrupt-allocation?query_logging=false";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.NODE_ENV ||= "test";

const { closeDatabaseConnectionsForTests, dbWrite } = await import("../../../db/client");
const { adAccounts } = await import("../../../db/schemas/ad-accounts");
const { adCampaigns } = await import("../../../db/schemas/ad-campaigns");
const { creditsService } = await import("../credits");
const { advertisingService } = await import("./index");

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const CAMPAIGN = "55555555-5555-4555-8555-555555555555";
const TIMEOUT = 60_000;

const debits: Array<{ amount: number }> = [];
let providerCalls = 0;
const spies: Array<{ mockRestore(): void }> = [];

async function storedCampaign(): Promise<{ credits_allocated: string; budget_amount: string }> {
  const result = await dbWrite.execute(
    sql.raw(
      `SELECT credits_allocated::text AS credits_allocated, budget_amount::text AS budget_amount FROM ad_campaigns WHERE id = '${CAMPAIGN}'`,
    ),
  );
  return result.rows[0] as { credits_allocated: string; budget_amount: string };
}

async function seedCampaign(creditsAllocated: string): Promise<void> {
  await dbWrite.execute(
    sql.raw(`INSERT INTO ad_campaigns (id, organization_id, ad_account_id, name, platform, objective, status, budget_type, budget_amount, budget_currency, credits_allocated, credits_spent, total_spend, external_campaign_id, targeting, metadata, created_at, updated_at)
      VALUES ('${CAMPAIGN}', '${ORG}', '${ACCOUNT}', 'c', 'meta', 'sales', 'active', 'lifetime', '100.00', 'USD', ${creditsAllocated}, '0.00', '0.00', 'ext-1', '{}', '{}', now(), now())`),
  );
}

beforeAll(async () => {
  for (const table of [adAccounts, adCampaigns]) {
    const config = getTableConfig(table);
    await dbWrite.execute(
      sql.raw(
        `CREATE TABLE ${config.name} (${config.columns
          .map(
            (column) =>
              `"${column.name}" ${column.getSQLType()}${column.name === "id" ? " PRIMARY KEY" : ""}`,
          )
          .join(",")})`,
      ),
    );
  }

  const fakeProvider = {
    updateCampaign: async () => {
      providerCalls += 1;
      return { success: true };
    },
  };
  spies.push(
    spyOn(advertisingService, "getProvider").mockReturnValue(fakeProvider as never),
    spyOn(
      advertisingService as unknown as {
        getCredentials(): Promise<{ accessToken: string }>;
      },
      "getCredentials",
    ).mockResolvedValue({ accessToken: "test-token" }),
    spyOn(creditsService, "deductCredits").mockImplementation(async (input) => {
      debits.push(input as { amount: number });
      return { success: true } as never;
    }),
    spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
  );
}, TIMEOUT);

beforeEach(async () => {
  debits.length = 0;
  providerCalls = 0;
  await dbWrite.execute(sql.raw("TRUNCATE TABLE ad_campaigns"));
  await dbWrite.execute(sql.raw("TRUNCATE TABLE ad_accounts"));
  await dbWrite.execute(
    sql.raw(`INSERT INTO ad_accounts (id, organization_id, connected_by_user_id, platform, external_account_id, account_name, status, metadata, created_at, updated_at)
      VALUES ('${ACCOUNT}', '${ORG}', '${USER}', 'meta', 'ext-acct', 'acct', 'active', '{}', now(), now())`),
  );
});

afterEach(() => {});

afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  await closeDatabaseConnectionsForTests();
});

test(
  "a healthy allocation charges exactly the budget-increase delta",
  async () => {
    await seedCampaign("'110.00'");
    const updated = await advertisingService.updateCampaign(CAMPAIGN, ORG, { budgetAmount: 200 });
    expect(debits.map((d) => d.amount)).toEqual([110]);
    expect(providerCalls).toBe(1);
    expect(updated.credits_allocated).toBe("220.00");
    const stored = await storedCampaign();
    expect(stored.credits_allocated).toBe("220.00");
    expect(stored.budget_amount).toBe("200.00");
  },
  TIMEOUT,
);

test(
  "a corrupt allocation refuses a budget increase before any debit or provider call",
  async () => {
    await seedCampaign("'NaN'::numeric");
    await expect(
      advertisingService.updateCampaign(CAMPAIGN, ORG, { budgetAmount: 200 }),
    ).rejects.toThrow("credits_allocated");
    expect(debits).toEqual([]);
    expect(providerCalls).toBe(0);
    const stored = await storedCampaign();
    expect(stored.credits_allocated).toBe("NaN");
    expect(stored.budget_amount).toBe("100.00");
  },
  TIMEOUT,
);

test(
  "a corrupt allocation refuses a spend-cap-only update instead of comparing against NaN",
  async () => {
    await seedCampaign("'NaN'::numeric");
    await expect(
      advertisingService.updateCampaign(CAMPAIGN, ORG, { spendCapCredits: 500 }),
    ).rejects.toThrow("credits_allocated");
    expect(debits).toEqual([]);
    expect(providerCalls).toBe(0);
  },
  TIMEOUT,
);

test(
  "a healthy allocation still allows a spend-cap-only update",
  async () => {
    await seedCampaign("'110.00'");
    const updated = await advertisingService.updateCampaign(CAMPAIGN, ORG, {
      spendCapCredits: 500,
    });
    expect(updated.spend_cap_credits).toBe("500.00");
    expect(providerCalls).toBe(1);
  },
  TIMEOUT,
);

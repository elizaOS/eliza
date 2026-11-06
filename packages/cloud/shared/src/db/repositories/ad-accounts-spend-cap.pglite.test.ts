/**
 * Proves the ad-account spend-cap lowering gate in
 * `AdAccountsRepository.updateSpendCapWithAllocationCheck` fails closed when
 * the stored SUM(credits_allocated) is corrupt. `credits_allocated` is a
 * Postgres NUMERIC, so one corrupt campaign row ('NaN'::numeric is a valid
 * NUMERIC) makes the driver return the total as the string "NaN"; the gate
 * must refuse the cap change instead of comparing against NaN and lowering
 * the cap anyway. Runs the real repository against the real `db` client on
 * in-process PGlite, with tables built from the real drizzle table configs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const ACCT_OVER = "33333333-3333-3333-3333-333333333333";
const ACCT_NAN = "44444444-4444-4444-4444-444444444444";
const ACCT_UNDER = "55555555-5555-5555-5555-555555555555";
const ACCT_EMPTY = "66666666-6666-6666-6666-666666666666";
const ACCT_NAN_CLEAR = "77777777-7777-7777-7777-777777777777";

let db: typeof import("../client").db;
let closeDb: typeof import("../client").closeDatabaseConnectionsForTests | undefined;
let repository: InstanceType<typeof import("./ad-accounts").AdAccountsRepository>;

function sqlType(columnType: string): string {
  if (columnType.includes("UUID")) return "uuid";
  if (columnType.includes("Numeric")) return "numeric(12,2)";
  if (columnType.includes("Json")) return "jsonb";
  if (columnType.includes("Timestamp")) return "timestamp";
  if (columnType.includes("Integer") || columnType.includes("Serial")) return "integer";
  if (columnType.includes("BigInt")) return "bigint";
  if (columnType.includes("Boolean")) return "boolean";
  if (columnType.includes("Double") || columnType.includes("Real")) return "double precision";
  return "text";
}

async function spendCapOf(accountId: string): Promise<string | null> {
  const { sql } = await import("drizzle-orm");
  const rows = await db.execute(
    sql.raw(`SELECT spend_cap_credits FROM ad_accounts WHERE id='${accountId}'`),
  );
  const list = (rows as unknown as { rows: Array<{ spend_cap_credits: string | null }> }).rows;
  return list[0]?.spend_cap_credits ?? null;
}

beforeAll(async () => {
  const { sql } = await import("drizzle-orm");
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  ({ closeDatabaseConnectionsForTests: closeDb, db } = await import("../client"));
  const { adAccounts } = await import("../schemas/ad-accounts");
  const { adCampaigns } = await import("../schemas/ad-campaigns");
  const { AdAccountsRepository } = await import("./ad-accounts");
  repository = new AdAccountsRepository();

  for (const table of [adAccounts, adCampaigns]) {
    const config = getTableConfig(table as never);
    const columns = config.columns
      .map(
        (column) =>
          `"${column.name}" ${sqlType(column.columnType)}${column.primary ? " PRIMARY KEY" : ""}`,
      )
      .join(", ");
    await db.execute(sql.raw(`CREATE TABLE "${config.name}" (${columns})`));
  }

  for (const accountId of [ACCT_OVER, ACCT_NAN, ACCT_UNDER, ACCT_EMPTY, ACCT_NAN_CLEAR]) {
    await db.execute(
      sql.raw(
        `INSERT INTO ad_accounts (id, organization_id, connected_by_user_id, platform, external_account_id, account_name, status, metadata, created_at, updated_at)
         VALUES ('${accountId}', '${ORG}', '${USER}', 'meta', 'ext-${accountId.slice(0, 4)}', 'acct', 'active', '{}', now(), now())`,
      ),
    );
  }
  const campaign = (accountId: string, allocated: string) =>
    db.execute(
      sql.raw(
        `INSERT INTO ad_campaigns (id, organization_id, ad_account_id, name, platform, objective, status, budget_type, credits_allocated, targeting, metadata, created_at, updated_at)
         VALUES (gen_random_uuid(), '${ORG}', '${accountId}', 'c', 'meta', 'sales', 'active', 'lifetime', ${allocated}, '{}', '{}', now(), now())`,
      ),
    );
  await campaign(ACCT_OVER, "'100.00'");
  await campaign(ACCT_NAN, "'NaN'::numeric");
  await campaign(ACCT_UNDER, "'5.00'");
  await campaign(ACCT_NAN_CLEAR, "'NaN'::numeric");
}, TIMEOUT);

afterAll(async () => {
  await closeDb?.();
});

describe("AdAccountsRepository.updateSpendCapWithAllocationCheck", () => {
  test(
    "refuses a cap below the allocated total",
    async () => {
      const result = await repository.updateSpendCapWithAllocationCheck(ACCT_OVER, ORG, "10.00");
      expect(result.status).toBe("cap_exceeded");
      if (result.status === "cap_exceeded") {
        expect(result.allocated).toBe(100);
        expect(result.cap).toBe(10);
      }
      expect(await spendCapOf(ACCT_OVER)).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "fails closed when the allocated total is corrupt instead of lowering the cap",
    async () => {
      await expect(
        repository.updateSpendCapWithAllocationCheck(ACCT_NAN, ORG, "10.00"),
      ).rejects.toThrow("credits_allocated total");
      expect(await spendCapOf(ACCT_NAN)).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "applies a cap above the allocated total",
    async () => {
      const result = await repository.updateSpendCapWithAllocationCheck(ACCT_UNDER, ORG, "10.00");
      expect(result.status).toBe("updated");
      expect(await spendCapOf(ACCT_UNDER)).toBe("10.00");
    },
    TIMEOUT,
  );

  test(
    "applies a cap when the account has no campaigns yet",
    async () => {
      const result = await repository.updateSpendCapWithAllocationCheck(ACCT_EMPTY, ORG, "10.00");
      expect(result.status).toBe("updated");
      expect(await spendCapOf(ACCT_EMPTY)).toBe("10.00");
    },
    TIMEOUT,
  );

  test(
    "clearing the cap (null) does not run the allocation check",
    async () => {
      const result = await repository.updateSpendCapWithAllocationCheck(ACCT_NAN_CLEAR, ORG, null);
      expect(result.status).toBe("updated");
      expect(await spendCapOf(ACCT_NAN_CLEAR)).toBeNull();
    },
    TIMEOUT,
  );
});

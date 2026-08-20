/**
 * Applies the organization billing authority migration to real PGlite and proves
 * fail-closed divergence, tenant-bound Stripe identity, exact numeric range,
 * and one-way canonical-to-shadow convergence.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { getTableColumns } from "drizzle-orm";
import { creditTransactions } from "./schemas/credit-transactions";
import { organizations } from "./schemas/organizations";
import { usageRecords } from "./schemas/usage-records";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";

async function migrationStatements(): Promise<string[]> {
  const migrations = await Promise.all([
    readFile(
      new URL("./migrations/0264_organization_billing_authority.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "./migrations/0270_allow_nested_organization_billing_shadow_sync.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  return migrations
    .join("\n")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function createDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY, stripe_customer_id text, billing_email text,
      stripe_payment_method_id text, stripe_default_payment_method text,
      auto_top_up_enabled boolean NOT NULL DEFAULT false,
      auto_top_up_amount numeric(10,2), auto_top_up_threshold numeric(10,2),
      credit_balance numeric(16,6) NOT NULL DEFAULT 0,
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE organization_billing (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL UNIQUE
        REFERENCES organizations(id) ON DELETE CASCADE,
      stripe_customer_id text, billing_email text, tax_id_type text, tax_id_value text,
      billing_address jsonb, stripe_payment_method_id text, stripe_default_payment_method text,
      auto_top_up_enabled boolean NOT NULL DEFAULT false,
      auto_top_up_amount numeric(12,6), auto_top_up_threshold numeric(12,6),
      auto_top_up_subscription_id text, created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    INSERT INTO organizations (id, updated_at) VALUES
      ('${ORG_A}', '2026-01-01T00:00:00Z'), ('${ORG_B}', '2026-01-01T00:00:00Z');
  `);
  return database;
}

async function applyMigration(database: PGlite): Promise<void> {
  for (const statement of await migrationStatements()) await database.exec(statement);
}

describe("organization billing authority", () => {
  const databases: PGlite[] = [];
  afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

  test("backfills idempotently and keeps the legacy row as an exact shadow", async () => {
    const database = await createDatabase();
    databases.push(database);
    await database.exec(`INSERT INTO organization_billing
      (organization_id, stripe_customer_id, billing_email, auto_top_up_enabled,
       auto_top_up_amount, auto_top_up_threshold)
      VALUES ('${ORG_A}', 'cus_a', 'billing@example.test', false, 10.250000, 5.120000)`);

    const untouchedBefore = await database.query<{ updated_at: string; row_version: string }>(
      `SELECT updated_at::text updated_at, xmin::text row_version
       FROM organizations WHERE id = '${ORG_B}'`,
    );
    await applyMigration(database);
    const result = await database.query<{
      canonical: string;
      shadow: string;
      amount: string;
      threshold: string;
    }>(`SELECT o.stripe_customer_id canonical, b.stripe_customer_id shadow,
      o.auto_top_up_amount::text amount, o.auto_top_up_threshold::text threshold
      FROM organizations o JOIN organization_billing b ON b.organization_id = o.id
      WHERE o.id = '${ORG_A}'`);
    expect(result.rows[0]).toEqual({
      canonical: "cus_a",
      shadow: "cus_a",
      amount: "10.25",
      threshold: "5.12",
    });

    await database.exec(`UPDATE organizations SET billing_email = 'next@example.test'
      WHERE id = '${ORG_A}'`);
    await applyMigration(database);
    const shadow = await database.query<{ billing_email: string; tax_id_type: string }>(
      `SELECT billing_email, tax_id_type FROM organization_billing
       WHERE organization_id = '${ORG_A}'`,
    );
    expect(shadow.rows[0]?.billing_email).toBe("next@example.test");

    const untouchedAfter = await database.query<{ updated_at: string; row_version: string }>(
      `SELECT updated_at::text updated_at, xmin::text row_version
       FROM organizations WHERE id = '${ORG_B}'`,
    );
    expect(untouchedAfter.rows[0]).toEqual(untouchedBefore.rows[0]);
  });

  test("aborts rather than choosing between divergent duplicate records", async () => {
    const database = await createDatabase();
    databases.push(database);
    await database.exec(`UPDATE organizations SET stripe_customer_id = 'cus_canonical'
      WHERE id = '${ORG_A}'; INSERT INTO organization_billing
      (organization_id, stripe_customer_id) VALUES ('${ORG_A}', 'cus_conflict')`);
    await expect(applyMigration(database)).rejects.toMatchObject({
      code: "23514",
      constraint: "organization_billing_authority_divergence",
    });
  });

  test("rejects sub-cent legacy values instead of silently rounding the backfill", async () => {
    const database = await createDatabase();
    databases.push(database);
    await database.exec(`INSERT INTO organization_billing
      (organization_id, auto_top_up_amount) VALUES ('${ORG_A}', 10.000001)`);
    await expect(applyMigration(database)).rejects.toMatchObject({
      code: "22003",
      constraint: "organization_billing_cent_precision",
    });
  });

  test("rejects cross-tenant provider reuse and direct shadow divergence", async () => {
    const database = await createDatabase();
    databases.push(database);
    await database.exec(`UPDATE organizations SET stripe_customer_id = 'cus_shared'
      WHERE id = '${ORG_A}'; INSERT INTO organization_billing
      (organization_id, stripe_customer_id) VALUES ('${ORG_B}', 'cus_shared')`);
    await expect(applyMigration(database)).rejects.toMatchObject({
      code: "23505",
      constraint: "organizations_stripe_customer_authority_unique",
    });

    await database.exec(`DELETE FROM organization_billing WHERE organization_id = '${ORG_B}'`);
    await applyMigration(database);
    await expect(
      database.exec(`UPDATE organizations SET stripe_customer_id = 'cus_shared'
      WHERE id = '${ORG_B}'`),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      database.exec(`UPDATE organization_billing SET billing_email = 'wrong@example.test'
      WHERE organization_id = '${ORG_A}'`),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "organization_billing_shadow_mismatch",
    });
    await expect(
      database.exec(`UPDATE organization_billing SET billing_email = billing_email
      WHERE organization_id = '${ORG_A}'`),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "organization_billing_shadow_mismatch",
    });
    await expect(
      database.exec(`UPDATE organization_billing SET updated_at = updated_at
      WHERE organization_id = '${ORG_A}'`),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "organization_billing_shadow_mismatch",
    });
    await expect(
      database.exec(`INSERT INTO organization_billing
      (organization_id, stripe_customer_id) VALUES ('${ORG_A}', 'cus_shared')
      ON CONFLICT (organization_id) DO NOTHING`),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "organization_billing_shadow_mismatch",
    });

    await database.exec(`UPDATE organization_billing SET
      tax_id_type = 'us_ein', tax_id_value = '12-3456789', billing_address = '{"country":"US"}'
      WHERE organization_id = '${ORG_A}'`);
    await database.exec(`UPDATE organizations SET billing_email = 'canonical@example.test'
      WHERE id = '${ORG_A}'`);
    const taxBoundary = await database.query<{
      billing_email: string;
      tax_id_type: string;
      tax_id_value: string;
    }>(`SELECT billing_email, tax_id_type, tax_id_value FROM organization_billing
      WHERE organization_id = '${ORG_A}'`);
    expect(taxBoundary.rows[0]).toEqual({
      billing_email: "canonical@example.test",
      tax_id_type: "us_ein",
      tax_id_value: "12-3456789",
    });
    await expect(database.exec(`TRUNCATE organization_billing`)).rejects.toMatchObject({
      code: "23514",
      constraint: "organization_billing_shadow_mismatch",
    });
    const preservedAfterTruncate = await database.query<{
      billing_email: string;
      tax_id_type: string;
      tax_id_value: string;
    }>(`SELECT billing_email, tax_id_type, tax_id_value FROM organization_billing
      WHERE organization_id = '${ORG_A}'`);
    expect(preservedAfterTruncate.rows[0]).toEqual({
      billing_email: "canonical@example.test",
      tax_id_type: "us_ein",
      tax_id_value: "12-3456789",
    });
    await expect(
      database.exec(`DELETE FROM organization_billing WHERE organization_id = '${ORG_A}'`),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "organization_billing_shadow_mismatch",
    });

    await database.exec(`DELETE FROM organizations WHERE id = '${ORG_A}'`);
    const cascaded = await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM organization_billing WHERE organization_id = '${ORG_A}'`,
    );
    expect(cascaded.rows[0]?.count).toBe("0");
  });

  test("allows nested canonical synchronization while retaining the direct-write guard", async () => {
    const database = await createDatabase();
    databases.push(database);
    await applyMigration(database);
    await database.exec(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE FUNCTION nested_disable_auto_top_up() RETURNS trigger AS $$ BEGIN
        UPDATE organizations SET auto_top_up_enabled = false WHERE id = OLD.organization_id;
        RETURN OLD;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER users_nested_disable BEFORE DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION nested_disable_auto_top_up();
      INSERT INTO users (id, organization_id)
      VALUES ('20000000-0000-4000-8000-000000000001', '${ORG_A}');
      DELETE FROM organizations WHERE id = '${ORG_A}';
    `);

    expect(
      (
        await database.query<{ count: string }>(`
          SELECT count(*)::text count FROM organization_billing WHERE organization_id = '${ORG_A}'
        `)
      ).rows[0]?.count,
    ).toBe("0");
    await expect(
      database.exec(`UPDATE organization_billing SET billing_email = 'wrong@example.test'
        WHERE organization_id = '${ORG_B}'`),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "organization_billing_shadow_mismatch",
    });
  });

  test("serializes concurrent attempts to claim one Stripe customer", async () => {
    const database = await createDatabase();
    databases.push(database);
    await applyMigration(database);

    const claims = await Promise.allSettled([
      database.exec(`UPDATE organizations SET stripe_customer_id = 'cus_race'
        WHERE id = '${ORG_A}'`),
      database.exec(`UPDATE organizations SET stripe_customer_id = 'cus_race'
        WHERE id = '${ORG_B}'`),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);

    const owners = await database.query<{ organization_id: string; stripe_customer_id: string }>(
      `SELECT o.id organization_id, b.stripe_customer_id
       FROM organizations o JOIN organization_billing b ON b.organization_id = o.id
       WHERE o.stripe_customer_id = 'cus_race'`,
    );
    expect(owners.rows).toHaveLength(1);
    expect(owners.rows[0]?.stripe_customer_id).toBe("cus_race");
  });

  test("matches the applied exact numeric schema and enforces its range", async () => {
    expect(getTableColumns(organizations).credit_balance.getSQLType()).toBe("numeric(16, 6)");
    expect(getTableColumns(creditTransactions).amount.getSQLType()).toBe("numeric(16, 6)");
    expect(getTableColumns(usageRecords).input_cost.getSQLType()).toBe("numeric(16, 6)");
    expect(getTableColumns(usageRecords).output_cost.getSQLType()).toBe("numeric(16, 6)");
    expect(getTableColumns(usageRecords).markup.getSQLType()).toBe("numeric(16, 6)");

    const database = await createDatabase();
    databases.push(database);
    await database.exec(`UPDATE organizations SET credit_balance = 9999999999.999999
      WHERE id = '${ORG_A}'`);
    const exact = await database.query<{ balance: string }>(
      `SELECT credit_balance::text balance FROM organizations WHERE id = '${ORG_A}'`,
    );
    expect(exact.rows[0]?.balance).toBe("9999999999.999999");
    await expect(
      database.exec(`UPDATE organizations SET credit_balance = 10000000000.000000
      WHERE id = '${ORG_A}'`),
    ).rejects.toMatchObject({ code: "22003" });
  });
});

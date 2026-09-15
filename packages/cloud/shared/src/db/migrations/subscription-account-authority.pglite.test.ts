/** Exercises account subscription identity migration with a real in-memory PostgreSQL engine, including ambiguous history and transactional rollback. */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

setDefaultTimeout(120_000);

let database: PGlite;
const org = (n: number) => `81000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sub = (n: number) => `82000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migration = await readFile(
  new URL("./0379_subscription_account_authority.sql", import.meta.url),
  "utf8",
);

beforeEach(async () => {
  database = new PGlite({ extensions: { btree_gist } });
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions (id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id), CONSTRAINT credit_transactions_id_org_idx UNIQUE(id, organization_id));
  `);
  const prerequisite = await readFile(
    new URL("./0373_subscription_authority.sql", import.meta.url),
    "utf8",
  );
  await database.exec(prerequisite);
  for (let n = 1; n <= 5; n++)
    await database.query("INSERT INTO organizations(id) VALUES ($1)", [org(n)]);
  const rows = [
    [1, 2, "active"],
    [2, 2, "canceled"],
    [3, 3, "canceled"],
    [4, 4, "canceled"],
    [5, 4, "incomplete_expired"],
  ] as const;
  for (const [id, tenant, status] of rows) {
    await database.query(
      `INSERT INTO billing_subscriptions (id, organization_id, provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status, current_period_start, current_period_end, lifecycle_revision, provider_object_digest, created_at)
      VALUES ($1,$2,'test',$3,$4,$5,'plus_monthly','v1',$6,'2026-08-01Z','2026-09-01Z',1,$7,'2026-08-01Z')`,
      [sub(id), org(tenant), `cus_${tenant}`, `sub_${id}`, `si_${id}`, status, "a".repeat(64)],
    );
  }
});

afterEach(async () => {
  await database.close();
});

describe("subscription account identity migration", () => {
  test("backfills live identity without chronology and keeps missing history distinct from ambiguity", async () => {
    await database.exec(migration);
    const { rows } = await database.query<{
      id: string;
      subscription_id: string | null;
      state: string;
    }>(
      "SELECT organization_id AS id, subscription_id, state FROM organization_subscription_authorities ORDER BY organization_id",
    );
    expect(rows).toEqual([
      { id: org(1), subscription_id: null, state: "none" },
      { id: org(2), subscription_id: sub(1), state: "current" },
      { id: org(3), subscription_id: sub(3), state: "current" },
      { id: org(4), subscription_id: null, state: "unavailable" },
      { id: org(5), subscription_id: null, state: "none" },
    ]);
    await expect(
      database.query(
        "UPDATE organization_subscription_authorities SET subscription_id=$1, state='current' WHERE organization_id=$2",
        [sub(1), org(1)],
      ),
    ).rejects.toThrow("organization_subscription_authorities_tenant_fk");
    await expect(
      database.query(
        "UPDATE organization_subscription_authorities SET state='current' WHERE organization_id=$1",
        [org(4)],
      ),
    ).rejects.toThrow("organization_subscription_authorities_state_check");
    expect(
      (
        await database.query(
          "SELECT plan_key FROM organization_entitlements WHERE organization_id=$1",
          [org(1)],
        )
      ).rows,
    ).toEqual([{ plan_key: "free" }]);
  });

  test("a failed migration transaction rolls back both the association and backfill", async () => {
    await database.exec("BEGIN");
    await database.exec(migration);
    await expect(database.exec("SELECT 1 / 0")).rejects.toThrow();
    await database.exec("ROLLBACK");
    await expect(
      database.query("SELECT subscription_id FROM organization_subscription_authorities"),
    ).rejects.toThrow("does not exist");
    expect(
      (
        await database.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM billing_subscriptions",
        )
      ).rows[0].count,
    ).toBe(5);
    await database.exec(migration);
    expect(
      (
        await database.query(
          "SELECT state FROM organization_subscription_authorities WHERE organization_id=$1",
          [org(4)],
        )
      ).rows,
    ).toEqual([{ state: "unavailable" }]);
  });
});

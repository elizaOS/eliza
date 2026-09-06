/** Exercises the real identity migrations on populated PostgreSQL financial records, including physical user erasure and concurrent identity creation. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const url = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `billing_identities_${randomUUID().replaceAll("-", "_")}`;
const actor = randomUUID();
const unusedUser = randomUUID();
const app = randomUUID();
let db: Client;

describe.skipIf(!url)("billing identity migration and erasure", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await db.query("CREATE TABLE users(id uuid PRIMARY KEY)");
    for (const [table, column] of [
      ["app_billing_accounts", "eligibility_principal_id"],
      ["app_subscription_trials", "eligibility_principal_id"],
      ["billing_subscription_commands", "requested_by_user_id"],
      ["app_billing_membership_operations", "actor_user_id"],
      ["app_billing_quotes", "actor_user_id"],
    ]) {
      const constraint =
        table === "billing_subscription_commands"
          ? `${table}_${column}_fkey`
          : `${table}_${column}_users_id_fk`;
      await db.query(
        `CREATE TABLE ${table}(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${column} uuid NOT NULL, app_id uuid, livemode boolean NOT NULL DEFAULT false, payload jsonb NOT NULL DEFAULT '{}', CONSTRAINT ${constraint} FOREIGN KEY(${column}) REFERENCES users(id) ON DELETE RESTRICT)`,
      );
    }
    await db.query(
      "CREATE UNIQUE INDEX trial_identity ON app_subscription_trials(app_id,eligibility_principal_id,livemode)",
    );
    await db.query("INSERT INTO users(id) VALUES($1),($2)", [actor, unusedUser]);
    await db.query("INSERT INTO app_billing_accounts(eligibility_principal_id) VALUES($1)", [
      actor,
    ]);
    await db.query(
      "INSERT INTO app_subscription_trials(eligibility_principal_id,app_id) VALUES($1,$2)",
      [actor, app],
    );
    await db.query(
      "INSERT INTO billing_subscription_commands(requested_by_user_id,payload) VALUES($1,$2)",
      [actor, { providerIntent: "original", digest: "reviewed" }],
    );
    await db.query("INSERT INTO app_billing_membership_operations(actor_user_id) VALUES($1)", [
      actor,
    ]);
    await db.query("INSERT INTO app_billing_quotes(actor_user_id) VALUES($1)", [actor]);
    for (const tag of [
      "0418_billing_identity_anchors",
      "0419_billing_identity_backfill",
      "0420_billing_identity_references",
    ]) {
      const migration = await readFile(
        new URL(`../migrations/${tag}.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint"))
        if (statement.trim()) await db.query(statement.replaceAll('"public".', ""));
    }
  });
  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });

  test("backfills only financial participants and preserves history after physical erasure", async () => {
    expect(
      (await db.query("SELECT id FROM billing_identity_subjects WHERE id=$1", [unusedUser])).rows,
    ).toEqual([]);
    const before = (
      await db.query("SELECT * FROM billing_subscription_commands WHERE requested_by_user_id=$1", [
        actor,
      ])
    ).rows;
    await expect(
      db.query("UPDATE billing_identity_subjects SET live_user_id=NULL WHERE id=$1", [actor]),
    ).rejects.toThrow("immutable");
    await db.query("DELETE FROM users WHERE id=$1", [actor]);
    expect(
      (
        await db.query(
          "SELECT * FROM billing_subscription_commands WHERE requested_by_user_id=$1",
          [actor],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT live_user_id,eligibility_principal_id FROM billing_identity_subjects WHERE id=$1",
          [actor],
        )
      ).rows,
    ).toEqual([{ live_user_id: null, eligibility_principal_id: actor }]);
    await expect(
      db.query(
        "INSERT INTO app_subscription_trials(eligibility_principal_id,app_id) VALUES($1,$2)",
        [actor, app],
      ),
    ).rejects.toThrow("duplicate key");
    await expect(
      db.query("DELETE FROM billing_eligibility_principals WHERE id=$1", [actor]),
    ).rejects.toThrow("immutable");
    await expect(
      db.query("UPDATE billing_identity_subjects SET eligibility_principal_id=$2 WHERE id=$1", [
        actor,
        unusedUser,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      db.query("INSERT INTO billing_subscription_commands(requested_by_user_id) VALUES($1)", [
        randomUUID(),
      ]),
    ).rejects.toThrow("existing user");
    await db.query("INSERT INTO users(id) VALUES($1)", [actor]);
    await expect(
      db.query("INSERT INTO billing_subscription_commands(requested_by_user_id) VALUES($1)", [
        actor,
      ]),
    ).rejects.toThrow("cannot be reassigned");
    await db.query("DELETE FROM users WHERE id=$1", [actor]);
  });

  test("concurrent first financial writes bind one immutable actor and eligibility principal", async () => {
    const subject = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [subject]);
    const other = new Client({ connectionString: url });
    await other.connect();
    try {
      await other.query(`SET search_path TO ${schema},public`);
      await Promise.all([
        db.query("INSERT INTO billing_subscription_commands(requested_by_user_id) VALUES($1)", [
          subject,
        ]),
        other.query("INSERT INTO app_billing_accounts(eligibility_principal_id) VALUES($1)", [
          subject,
        ]),
      ]);
      expect(
        (
          await db.query(
            "SELECT live_user_id,eligibility_principal_id FROM billing_identity_subjects WHERE id=$1",
            [subject],
          )
        ).rows,
      ).toEqual([{ live_user_id: subject, eligibility_principal_id: subject }]);
      await db.query("DELETE FROM users WHERE id=$1", [subject]);
      expect(
        (
          await db.query("SELECT live_user_id FROM billing_identity_subjects WHERE id=$1", [
            subject,
          ])
        ).rows,
      ).toEqual([{ live_user_id: null }]);
    } finally {
      await other.end();
    }
  });
});

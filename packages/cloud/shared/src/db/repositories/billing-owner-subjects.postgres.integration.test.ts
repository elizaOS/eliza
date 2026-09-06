/** Exercises ownership retention migrations on real PostgreSQL with minimal operational tables. These tests verify identity binding and erasure invariants, not completion of the account deletion saga. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const url = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `billing_owners_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
const organization = randomUUID();
const otherOrganization = randomUUID();
const app = randomUUID();
const registration = randomUUID();
const legacyOwner = randomUUID();
const legacyApp = randomUUID();
const legacyRegistration = randomUUID();
const legacyCommand = randomUUID();

describe.skipIf(!url)("billing owner retention", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await db.query(`
      CREATE TABLE organizations(id uuid PRIMARY KEY);
      CREATE TABLE apps(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id));
      CREATE TABLE app_client_registrations(id uuid PRIMARY KEY, app_id uuid NOT NULL REFERENCES apps(id), owner_organization_id uuid NOT NULL REFERENCES organizations(id), private_configuration text);
    `);
    for (const table of [
      "billing_merchants",
      "app_billing_accounts",
      "app_billing_plan_revisions",
      "app_billing_scopes",
      "app_subscription_trials",
      "app_billing_application_slots",
      "billing_subscription_commands",
      "app_billing_membership_operations",
      "billing_subscriptions",
      "billing_subscription_revisions",
      "billing_subscription_event_receipts",
      "billing_subscription_incidents",
      "subscription_allowance_periods",
      "subscription_allowance_transactions",
      "billing_funding_reservations",
      "billing_funding_allocations",
      "credit_transactions",
    ]) {
      await db.query(
        `CREATE TABLE ${table}(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,app_id uuid,client_registration_id uuid,payload jsonb NOT NULL DEFAULT '{}')`,
      );
    }
    await db.query("INSERT INTO organizations VALUES($1)", [legacyOwner]);
    await db.query("INSERT INTO apps VALUES($1,$2)", [legacyApp, legacyOwner]);
    await db.query(
      "INSERT INTO app_client_registrations VALUES($1,$2,$3,'private legacy credential')",
      [legacyRegistration, legacyApp, legacyOwner],
    );
    await db.query(
      "INSERT INTO billing_subscription_commands(id,organization_id,app_id,client_registration_id,payload) VALUES($1,$2,$3,$4,$5)",
      [
        legacyCommand,
        legacyOwner,
        legacyApp,
        legacyRegistration,
        { amount: "12.345678", providerIntent: "original" },
      ],
    );
    for (const tag of [
      "0432_billing_owner_subjects",
      "0433_billing_owner_subject_guards",
      "0434_billing_owner_subject_creation",
      "0435_billing_owner_source_anchors",
      "0436_billing_owner_subject_backfill",
    ]) {
      const migration = await readFile(
        new URL(`../migrations/${tag}.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await db.query(statement);
      }
    }
    await db.query("INSERT INTO organizations VALUES($1),($2)", [organization, otherOrganization]);
    await db.query("INSERT INTO apps VALUES($1,$2)", [app, organization]);
    await db.query(
      "INSERT INTO app_client_registrations VALUES($1,$2,$3,'private callback and credential')",
      [registration, app, organization],
    );
    await db.query(
      "INSERT INTO billing_organization_subjects(id,live_organization_id) VALUES($1,$1),($2,$2)",
      [organization, otherOrganization],
    );
  });

  test("backfills retained owners without rewriting existing financial source evidence", async () => {
    expect(
      (
        await db.query(
          "SELECT organization_id,app_id,client_registration_id,payload FROM billing_subscription_commands WHERE id=$1",
          [legacyCommand],
        )
      ).rows,
    ).toEqual([
      {
        organization_id: legacyOwner,
        app_id: legacyApp,
        client_registration_id: legacyRegistration,
        payload: { amount: "12.345678", providerIntent: "original" },
      },
    ]);
    expect(
      (
        await db.query(
          `SELECT r.id,r.app_id,r.organization_id FROM billing_registration_subjects r JOIN billing_app_subjects a ON a.id=r.app_id AND a.organization_id=r.organization_id JOIN billing_organization_subjects o ON o.id=r.organization_id WHERE r.id=$1`,
          [legacyRegistration],
        )
      ).rows,
    ).toEqual([{ id: legacyRegistration, app_id: legacyApp, organization_id: legacyOwner }]);
  });

  test("new financial commands anchor their original registration and reject a different owner", async () => {
    const owner = randomUUID();
    const application = randomUUID();
    const client = randomUUID();
    await db.query("INSERT INTO organizations VALUES($1)", [owner]);
    await db.query("INSERT INTO apps VALUES($1,$2)", [application, owner]);
    await db.query(
      "INSERT INTO app_client_registrations VALUES($1,$2,$3,'private new credential')",
      [client, application, owner],
    );
    await expect(
      db.query(
        "INSERT INTO billing_subscription_commands(organization_id,app_id,client_registration_id) VALUES($1,$2,$3)",
        [otherOrganization, application, client],
      ),
    ).rejects.toThrow("Financial source app ownership");
    const result = await db.query(
      "INSERT INTO billing_subscription_commands(organization_id,app_id,client_registration_id,payload) VALUES($1,$2,$3,$4) RETURNING id",
      [owner, application, client, { digest: "signed-original" }],
    );
    expect(
      (
        await db.query(
          `SELECT c.payload,r.organization_id FROM billing_subscription_commands c JOIN billing_registration_subjects r ON r.id=c.client_registration_id AND r.app_id=c.app_id WHERE c.id=$1`,
          [result.rows[0]!.id],
        )
      ).rows,
    ).toEqual([{ payload: { digest: "signed-original" }, organization_id: owner }]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });

  test("rejects invented historical bindings and mismatched parent ownership", async () => {
    await expect(
      db.query(
        "INSERT INTO billing_app_subjects(id,organization_id,live_app_id) VALUES($1,$2,$1)",
        [app, otherOrganization],
      ),
    ).rejects.toThrow("ownership does not match");
    await expect(
      db.query("INSERT INTO billing_app_subjects(id,organization_id) VALUES($1,$2)", [
        app,
        organization,
      ]),
    ).rejects.toThrow("original live identity");
    await db.query(
      "INSERT INTO billing_app_subjects(id,organization_id,live_app_id) VALUES($1,$2,$1)",
      [app, organization],
    );
    await expect(
      db.query(
        "INSERT INTO billing_registration_subjects(id,app_id,organization_id,live_registration_id) VALUES($1,$2,$3,$1)",
        [registration, app, otherOrganization],
      ),
    ).rejects.toThrow("ownership does not match");
    await db.query(
      "INSERT INTO billing_registration_subjects(id,app_id,organization_id,live_registration_id) VALUES($1,$2,$3,$1)",
      [registration, app, organization],
    );
  });

  test("retains the original ownership chain after operational erasure and rejects reattachment", async () => {
    for (const [table, column, id] of [
      ["billing_organization_subjects", "live_organization_id", organization],
      ["billing_app_subjects", "live_app_id", app],
      ["billing_registration_subjects", "live_registration_id", registration],
    ]) {
      await expect(
        db.query(`UPDATE ${table} SET ${column}=NULL WHERE id=$1`, [id]),
      ).rejects.toThrow("cannot detach");
      await expect(db.query(`DELETE FROM ${table} WHERE id=$1`, [id])).rejects.toThrow(
        "cannot be removed",
      );
      await expect(db.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow("cannot be removed");
      await expect(
        db.query(`UPDATE ${table} SET created_at=created_at+interval '1 second' WHERE id=$1`, [id]),
      ).rejects.toThrow("immutable");
    }
    await db.query("DELETE FROM app_client_registrations WHERE id=$1", [registration]);
    await db.query("DELETE FROM apps WHERE id=$1", [app]);
    await db.query("DELETE FROM organizations WHERE id=$1", [organization]);
    expect(
      (
        await db.query(
          `SELECT r.id,r.app_id,r.organization_id,r.live_registration_id,a.live_app_id,o.live_organization_id
      FROM billing_registration_subjects r JOIN billing_app_subjects a ON a.id=r.app_id
      JOIN billing_organization_subjects o ON o.id=r.organization_id WHERE r.id=$1`,
          [registration],
        )
      ).rows,
    ).toEqual([
      {
        id: registration,
        app_id: app,
        organization_id: organization,
        live_registration_id: null,
        live_app_id: null,
        live_organization_id: null,
      },
    ]);
    await db.query("INSERT INTO organizations VALUES($1)", [organization]);
    await expect(
      db.query("UPDATE billing_organization_subjects SET live_organization_id=id WHERE id=$1", [
        organization,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      db.query("UPDATE billing_app_subjects SET organization_id=$2 WHERE id=$1", [
        app,
        otherOrganization,
      ]),
    ).rejects.toThrow("immutable");
    const replacementApp = randomUUID();
    await db.query("INSERT INTO apps VALUES($1,$2)", [replacementApp, organization]);
    await expect(
      db.query(
        "INSERT INTO billing_app_subjects(id,organization_id,live_app_id) VALUES($1,$2,$1)",
        [replacementApp, organization],
      ),
    ).rejects.toThrow("Erased billing owner");
  });
  test("rechecks live ownership after a concurrent transfer releases its row lock", async () => {
    const movingApp = randomUUID();
    const liveOwner = randomUUID();
    await db.query("INSERT INTO organizations VALUES($1)", [liveOwner]);
    await db.query(
      "INSERT INTO billing_organization_subjects(id,live_organization_id) VALUES($1,$1)",
      [liveOwner],
    );
    await db.query("INSERT INTO apps VALUES($1,$2)", [movingApp, liveOwner]);
    const writer = new Client({ connectionString: url });
    const anchor = new Client({ connectionString: url });
    await writer.connect();
    await anchor.connect();
    try {
      await writer.query(`SET search_path TO ${schema},public`);
      await anchor.query(`SET search_path TO ${schema},public`);
      const pid = (await anchor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      await writer.query("BEGIN");
      await writer.query("UPDATE apps SET organization_id=$2 WHERE id=$1", [
        movingApp,
        otherOrganization,
      ]);
      const pending = anchor
        .query(
          "INSERT INTO billing_app_subjects(id,organization_id,live_app_id) VALUES($1,$2,$1)",
          [movingApp, liveOwner],
        )
        .then(
          () => ({ accepted: true, message: "" }),
          (error: Error) => ({ accepted: false, message: error.message }),
        );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (
          await db.query<{ blocked: boolean }>(
            "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
            [pid],
          )
        ).rows[0]!.blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await writer.query("COMMIT");
      const outcome = await pending;
      expect(blocked).toBe(true);
      expect(outcome.accepted).toBe(false);
      expect(outcome.message).toContain("ownership does not match");
      expect(
        (await db.query("SELECT id FROM billing_app_subjects WHERE id=$1", [movingApp])).rows,
      ).toEqual([]);
    } finally {
      await writer.query("ROLLBACK");
      await writer.end();
      await anchor.end();
    }
  });
  test("creates the complete original chain atomically and refuses erased identity reuse", async () => {
    const owner = randomUUID();
    const application = randomUUID();
    const client = randomUUID();
    await db.query("INSERT INTO organizations VALUES($1)", [owner]);
    await db.query("INSERT INTO apps VALUES($1,$2)", [application, owner]);
    await db.query("INSERT INTO app_client_registrations VALUES($1,$2,$3,'private')", [
      client,
      application,
      otherOrganization,
    ]);
    await expect(
      db.query("SELECT ensure_billing_registration_subject($1)", [client]),
    ).rejects.toThrow("ownership does not match");
    expect(
      (await db.query("SELECT id FROM billing_organization_subjects WHERE id=$1", [owner])).rows,
    ).toEqual([]);
    await db.query("UPDATE app_client_registrations SET owner_organization_id=$2 WHERE id=$1", [
      client,
      owner,
    ]);
    await db.query("SELECT ensure_billing_registration_subject($1)", [client]);
    await db.query("SELECT ensure_billing_registration_subject($1)", [client]);
    await db.query("DELETE FROM app_client_registrations WHERE id=$1", [client]);
    await db.query("INSERT INTO app_client_registrations VALUES($1,$2,$3,'replacement')", [
      client,
      application,
      owner,
    ]);
    await expect(
      db.query("SELECT ensure_billing_registration_subject($1)", [client]),
    ).rejects.toThrow("Erased or transferred");
    expect(
      (
        await db.query(
          "SELECT id,app_id,organization_id,live_registration_id FROM billing_registration_subjects WHERE id=$1",
          [client],
        )
      ).rows,
    ).toEqual([
      { id: client, app_id: application, organization_id: owner, live_registration_id: null },
    ]);
  });
});

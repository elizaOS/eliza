/**
 * Applies migrations 0213-0217 to real PGlite and proves the auto-top-up ledger's
 * tenant foreign keys, blocking uniqueness, nullable terminal schedule, lease
 * checks, provider identities, lifecycle guards, and migration registration.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const ORG_C = "10000000-0000-4000-8000-000000000003";
const ATTEMPT_A = "20000000-0000-4000-8000-000000000001";
const ATTEMPT_B = "20000000-0000-4000-8000-000000000002";
const CREDIT_TX = "30000000-0000-4000-8000-000000000001";
const USER_A = "40000000-0000-4000-8000-000000000001";

async function migrationSql(): Promise<string> {
  const [organizationFence, organizationBackfill, attempts, control, lifecycleGuards] =
    await Promise.all([
      readFile(
        new URL("./migrations/0213_auto_top_up_organization_fence.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("./migrations/0214_backfill_auto_top_up_organization_fence.sql", import.meta.url),
        "utf8",
      ),
      readFile(new URL("./migrations/0215_auto_top_up_attempts.sql", import.meta.url), "utf8"),
      readFile(
        new URL("./migrations/0216_auto_top_up_cutover_control.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("./migrations/0217_guard_auto_top_up_cutover_lifecycle.sql", import.meta.url),
        "utf8",
      ),
    ]);
  return `${organizationFence}\n${organizationBackfill}\n${attempts}\n${control}\n${lifecycleGuards}`;
}

async function createPrerequisites(database: PGlite): Promise<void> {
  await database.exec(`
    CREATE TABLE "organizations" (
      "id" uuid PRIMARY KEY,
      "credit_balance" numeric(12,6) NOT NULL DEFAULT 0,
      "auto_top_up_enabled" boolean NOT NULL DEFAULT true
    );
    CREATE TABLE "users" (
      "id" uuid PRIMARY KEY,
      "organization_id" uuid REFERENCES "organizations"("id") ON DELETE CASCADE
    );
    CREATE TABLE "credit_transactions" (
      "id" uuid PRIMARY KEY,
      "organization_id" uuid NOT NULL
        REFERENCES "organizations"("id") ON DELETE CASCADE,
      "amount" numeric(12,6) NOT NULL DEFAULT 0,
      "type" text NOT NULL DEFAULT 'credit',
      "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "stripe_payment_intent_id" text
    );
    CREATE UNIQUE INDEX "credit_transactions_stripe_payment_intent_idx"
      ON "credit_transactions" ("stripe_payment_intent_id");
    INSERT INTO "organizations" ("id", "credit_balance")
    VALUES ('${ORG_A}', 10), ('${ORG_B}', 10);
  `);
}

function validAttempt(id: string, organizationId: string, idempotencyKey: string): string {
  return `
    INSERT INTO "auto_top_up_attempts" (
      "id", "organization_id", "trigger_source", "status",
      "credit_amount_cents", "charge_amount_cents", "currency",
      "stripe_customer_id_snapshot", "stripe_payment_method_id_snapshot",
      "idempotency_key"
    ) VALUES (
      '${id}', '${organizationId}', 'cron', 'claimed',
      1000, 1200, 'usd', 'cus_snapshot', 'pm_snapshot', '${idempotencyKey}'
    );
  `;
}

async function expectDatabaseConstraint(
  operation: Promise<unknown>,
  expected: { code: "23503" | "23514"; constraint: string },
): Promise<void> {
  let rejection: unknown;
  try {
    await operation;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toMatchObject(expected);
}

describe("0213-0217 auto-top-up cutover foundation", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  test("is journaled, idempotent, and exposes the intended columns and indexes", async () => {
    const database = new PGlite();
    databases.push(database);
    await createPrerequisites(database);
    const migration = await migrationSql();
    await database.exec(migration);
    await database.exec(migration);

    const journal = JSON.parse(
      await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    expect(
      journal.entries.find((entry) => entry.tag === "0213_auto_top_up_organization_fence"),
    ).toEqual({
      idx: 212,
      version: "7",
      when: 1787860800003,
      tag: "0213_auto_top_up_organization_fence",
      breakpoints: true,
    });
    expect(
      journal.entries.find((entry) => entry.tag === "0214_backfill_auto_top_up_organization_fence"),
    ).toEqual({
      idx: 213,
      version: "7",
      when: 1787860800004,
      tag: "0214_backfill_auto_top_up_organization_fence",
      breakpoints: true,
    });
    expect(journal.entries.find((entry) => entry.tag === "0215_auto_top_up_attempts")).toEqual({
      idx: 214,
      version: "7",
      when: 1787860800005,
      tag: "0215_auto_top_up_attempts",
      breakpoints: true,
    });
    expect(
      journal.entries.find((entry) => entry.tag === "0216_auto_top_up_cutover_control"),
    ).toEqual({
      idx: 215,
      version: "7",
      when: 1787860800006,
      tag: "0216_auto_top_up_cutover_control",
      breakpoints: true,
    });
    expect(
      journal.entries.find((entry) => entry.tag === "0217_guard_auto_top_up_cutover_lifecycle"),
    ).toEqual({
      idx: 216,
      version: "7",
      when: 1787860800007,
      tag: "0217_guard_auto_top_up_cutover_lifecycle",
      breakpoints: true,
    });

    const columns = await database.query<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
    }>(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'auto_top_up_attempts'
      ORDER BY column_name
    `);
    expect(columns.rows).toHaveLength(29);
    expect(columns.rows).toContainEqual({
      column_name: "credit_amount_cents",
      data_type: "bigint",
      is_nullable: "NO",
    });
    expect(columns.rows).toContainEqual({
      column_name: "next_attempt_at",
      data_type: "timestamp with time zone",
      is_nullable: "YES",
    });
    expect(columns.rows).toContainEqual({
      column_name: "covered_balance_decrease_revision",
      data_type: "bigint",
      is_nullable: "YES",
    });

    const organizationColumns = await database.query<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
    }>(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'organizations'
    `);
    expect(organizationColumns.rows).toContainEqual({
      column_name: "balance_decrease_revision",
      data_type: "bigint",
      is_nullable: "NO",
    });
    expect(organizationColumns.rows).toContainEqual({
      column_name: "auto_top_up_covered_balance_decrease_revision",
      data_type: "bigint",
      is_nullable: "YES",
    });
    expect(columns.rows).toContainEqual({
      column_name: "provider_request_started_at",
      data_type: "timestamp with time zone",
      is_nullable: "YES",
    });

    const indexes = await database.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'auto_top_up_attempts'
      ORDER BY indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "auto_top_up_attempts_blocking_org_idx",
      "auto_top_up_attempts_due_idx",
      "auto_top_up_attempts_idempotency_key_idx",
      "auto_top_up_attempts_org_created_idx",
      "auto_top_up_attempts_payment_intent_idx",
      "auto_top_up_attempts_pkey",
    ]);
  });

  test("advances the durable balance-decrease revision only when balance falls", async () => {
    const database = new PGlite();
    databases.push(database);
    await createPrerequisites(database);
    await database.exec(await migrationSql());

    const revision = async (): Promise<number> => {
      const result = await database.query<{ revision: string }>(`
        SELECT balance_decrease_revision::text AS revision
        FROM organizations WHERE id = '${ORG_A}'
      `);
      return Number(result.rows[0]?.revision);
    };

    expect(await revision()).toBe(0);
    await database.exec(`UPDATE organizations SET credit_balance = 11 WHERE id = '${ORG_A}'`);
    expect(await revision()).toBe(0);
    await database.exec(`UPDATE organizations SET credit_balance = 11 WHERE id = '${ORG_A}'`);
    expect(await revision()).toBe(0);
    await database.exec(`UPDATE organizations SET credit_balance = 9 WHERE id = '${ORG_A}'`);
    const firstDecrease = await revision();
    expect(firstDecrease).toBeGreaterThan(0);
    await database.exec(`UPDATE organizations SET credit_balance = 12 WHERE id = '${ORG_A}'`);
    expect(await revision()).toBe(firstDecrease);
    await database.exec(`UPDATE organizations SET credit_balance = 8 WHERE id = '${ORG_A}'`);
    expect(await revision()).toBeGreaterThan(firstDecrease);
  });

  test("backfills an existing organization fence but leaves a new organization unfenced", async () => {
    const database = new PGlite();
    databases.push(database);
    await createPrerequisites(database);
    await database.exec(await migrationSql());

    const existing = await database.query<{
      revision: string;
      covered: string | null;
    }>(`
      SELECT balance_decrease_revision::text AS revision,
        auto_top_up_covered_balance_decrease_revision::text AS covered
      FROM organizations WHERE id = '${ORG_A}'
    `);
    expect(existing.rows[0]).toEqual({ revision: "0", covered: "0" });

    await database.exec(`
      INSERT INTO organizations (id, credit_balance, auto_top_up_enabled)
      VALUES ('${ORG_C}', 1, true)
    `);
    const created = await database.query<{ covered: string | null }>(`
      SELECT auto_top_up_covered_balance_decrease_revision::text AS covered
      FROM organizations WHERE id = '${ORG_C}'
    `);
    expect(created.rows[0]?.covered).toBeNull();

    await database.exec(`UPDATE organizations SET credit_balance = 9 WHERE id = '${ORG_A}'`);
    const rearmed = await database.query<{ rearmed: boolean }>(`
      SELECT balance_decrease_revision <> auto_top_up_covered_balance_decrease_revision AS rearmed
      FROM organizations WHERE id = '${ORG_A}'
    `);
    expect(rearmed.rows[0]?.rearmed).toBe(true);
  });

  test("fences a real legacy credit insert and a duplicate PI no-op cannot restamp it", async () => {
    const database = new PGlite();
    databases.push(database);
    await createPrerequisites(database);
    await database.exec(await migrationSql());
    await database.exec(`UPDATE organizations SET credit_balance = 9 WHERE id = '${ORG_A}'`);

    await database.exec(`
      INSERT INTO credit_transactions (
        id, organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (
        '${CREDIT_TX}', '${ORG_A}', 10, 'credit', '{"type":"auto_top_up"}', 'pi_legacy'
      )
    `);
    const firstFence = await database.query<{ covered: string; revision: string }>(`
      SELECT auto_top_up_covered_balance_decrease_revision::text AS covered,
        balance_decrease_revision::text AS revision
      FROM organizations WHERE id = '${ORG_A}'
    `);
    expect(firstFence.rows[0]?.covered).toBe(firstFence.rows[0]?.revision);

    await database.exec(`UPDATE organizations SET credit_balance = 8 WHERE id = '${ORG_A}'`);
    const afterDebit = await database.query<{ covered: string; revision: string }>(`
      SELECT auto_top_up_covered_balance_decrease_revision::text AS covered,
        balance_decrease_revision::text AS revision
      FROM organizations WHERE id = '${ORG_A}'
    `);
    expect(afterDebit.rows[0]?.covered).toBe(firstFence.rows[0]?.covered);
    expect(afterDebit.rows[0]?.revision).not.toBe(firstFence.rows[0]?.revision);

    await database.exec(`
      INSERT INTO credit_transactions (
        id, organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (
        gen_random_uuid(), '${ORG_A}', 10, 'credit', '{"type":"auto_top_up"}', 'pi_legacy'
      ) ON CONFLICT (stripe_payment_intent_id) DO NOTHING
    `);
    const afterReplay = await database.query<{ covered: string; revision: string }>(`
      SELECT auto_top_up_covered_balance_decrease_revision::text AS covered,
        balance_decrease_revision::text AS revision
      FROM organizations WHERE id = '${ORG_A}'
    `);
    expect(afterReplay.rows[0]).toEqual(afterDebit.rows[0]);
  });

  test("enforces one blocking attempt per org, including manual review", async () => {
    const database = new PGlite();
    databases.push(database);
    await createPrerequisites(database);
    await database.exec(await migrationSql());
    await database.exec(validAttempt(ATTEMPT_A, ORG_A, "key-a"));

    await expect(database.exec(validAttempt(ATTEMPT_B, ORG_A, "key-b"))).rejects.toThrow(
      /auto_top_up_attempts_blocking_org_idx/i,
    );
    await database.exec(`
      UPDATE "auto_top_up_attempts"
      SET "status" = 'manual_review', "next_attempt_at" = NULL,
          "manual_review_at" = now()
      WHERE "id" = '${ATTEMPT_A}';
    `);
    await expect(database.exec(validAttempt(ATTEMPT_B, ORG_A, "key-b"))).rejects.toThrow(
      /auto_top_up_attempts_blocking_org_idx/i,
    );

    await database.exec(`
      UPDATE "auto_top_up_attempts"
      SET "status" = 'canceled', "canceled_at" = now()
      WHERE "id" = '${ATTEMPT_A}';
    `);
    await database.exec(validAttempt(ATTEMPT_B, ORG_A, "key-b"));
  });

  test("rejects incoherent leases, provider windows, duplicate PI, and bad amounts", async () => {
    const database = new PGlite();
    databases.push(database);
    await createPrerequisites(database);
    await database.exec(await migrationSql());
    await database.exec(validAttempt(ATTEMPT_A, ORG_A, "key-a"));
    await database.exec(validAttempt(ATTEMPT_B, ORG_B, "key-b"));

    await expect(
      database.exec(`
        UPDATE "auto_top_up_attempts"
        SET "lease_token" = '40000000-0000-4000-8000-000000000001'
        WHERE "id" = '${ATTEMPT_A}';
      `),
    ).rejects.toThrow(/auto_top_up_attempts_lease_pair_check/i);
    await expect(
      database.exec(`
        UPDATE "auto_top_up_attempts"
        SET "provider_request_started_at" = now()
        WHERE "id" = '${ATTEMPT_A}';
      `),
    ).rejects.toThrow(/auto_top_up_attempts_provider_window_check/i);
    await expect(
      database.exec(`
        UPDATE "auto_top_up_attempts"
        SET "status" = 'canceled', "next_attempt_at" = NULL,
            "provider_request_started_at" = now(),
            "recovery_deadline_at" = now() + interval '1 hour',
            "canceled_at" = now()
        WHERE "id" = '${ATTEMPT_A}';
      `),
    ).rejects.toThrow(/auto_top_up_attempts_canceled_check/i);
    await expect(
      database.exec(`
        UPDATE "auto_top_up_attempts"
        SET "status" = 'canceled', "next_attempt_at" = NULL,
            "stripe_payment_intent_id" = 'pi_ambiguous',
            "provider_status" = 'processing', "canceled_at" = now()
        WHERE "id" = '${ATTEMPT_A}';
      `),
    ).rejects.toThrow(/auto_top_up_attempts_canceled_check/i);
    await expect(
      database.exec(`
        UPDATE "auto_top_up_attempts"
        SET "charge_amount_cents" = 999
        WHERE "id" = '${ATTEMPT_A}';
      `),
    ).rejects.toThrow(/auto_top_up_attempts_amount_check/i);

    await database.exec(`
      UPDATE "auto_top_up_attempts" SET "stripe_payment_intent_id" = 'pi_same'
      WHERE "id" = '${ATTEMPT_A}';
    `);
    await expect(
      database.exec(`
        UPDATE "auto_top_up_attempts" SET "stripe_payment_intent_id" = 'pi_same'
        WHERE "id" = '${ATTEMPT_B}';
      `),
    ).rejects.toThrow(/auto_top_up_attempts_payment_intent_idx/i);

    await database.exec(`
      INSERT INTO "credit_transactions" ("id", "organization_id")
      VALUES ('${CREDIT_TX}', '${ORG_A}');
    `);
    await expect(
      database.exec(`
        UPDATE "auto_top_up_attempts"
        SET "status" = 'credited', "next_attempt_at" = NULL,
            "credit_transaction_id" = '${CREDIT_TX}',
            "payment_succeeded_at" = now(), "credited_at" = now()
        WHERE "id" = '${ATTEMPT_A}';
      `),
    ).rejects.toThrow(/auto_top_up_attempts_credited_check/i);
  });

  test("cascading organization deletion removes attempts and linked credits without FK deadlock", async () => {
    const database = new PGlite();
    databases.push(database);
    await createPrerequisites(database);
    await database.exec(await migrationSql());
    await database.exec(`
      UPDATE auto_top_up_control
      SET mode = 'durable', legacy_reconciled_through = paused_at;
      INSERT INTO "users" ("id", "organization_id") VALUES ('${USER_A}', '${ORG_A}');
      INSERT INTO "credit_transactions" ("id", "organization_id")
      VALUES ('${CREDIT_TX}', '${ORG_A}');
      INSERT INTO "auto_top_up_attempts" (
        "id", "organization_id", "trigger_source", "status",
        "credit_amount_cents", "charge_amount_cents", "currency",
        "stripe_customer_id_snapshot", "stripe_payment_method_id_snapshot",
        "idempotency_key", "stripe_payment_intent_id", "credit_transaction_id",
        "covered_balance_decrease_revision", "payment_succeeded_at", "credited_at",
        "next_attempt_at"
      ) VALUES (
        '${ATTEMPT_A}', '${ORG_A}', 'cron', 'credited',
        1000, 1000, 'usd', 'cus_snapshot', 'pm_snapshot', 'key-a', 'pi_a',
        '${CREDIT_TX}', 0, now(), now(), NULL
      );
      DELETE FROM "organizations" WHERE "id" = '${ORG_A}';
    `);

    const attempts = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "auto_top_up_attempts"`,
    );
    const credits = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "credit_transactions"`,
    );
    const users = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "users"`,
    );
    expect(attempts.rows[0]?.count).toBe("0");
    expect(credits.rows[0]?.count).toBe("0");
    expect(users.rows[0]?.count).toBe("0");
  });

  test("blocks organization deletion until every provider attempt is terminal", async () => {
    const database = new PGlite();
    databases.push(database);
    await createPrerequisites(database);
    await database.exec(await migrationSql());
    await database.exec(`
      UPDATE auto_top_up_control
      SET mode = 'durable', legacy_reconciled_through = paused_at
    `);
    await database.exec(validAttempt(ATTEMPT_A, ORG_A, "delete-guard-active"));

    await expectDatabaseConstraint(
      database.exec(`DELETE FROM "organizations" WHERE "id" = '${ORG_A}';`),
      { code: "23503", constraint: "auto_top_up_unresolved_work" },
    );
    expect(
      (
        await database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "auto_top_up_attempts" WHERE "id" = '${ATTEMPT_A}'`,
        )
      ).rows[0]?.count,
    ).toBe("1");

    await database.exec(`
      UPDATE "auto_top_up_attempts"
      SET "status" = 'canceled', "next_attempt_at" = NULL, "canceled_at" = now()
      WHERE "id" = '${ATTEMPT_A}';
      DELETE FROM "organizations" WHERE "id" = '${ORG_A}';
    `);
    expect(
      (
        await database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "auto_top_up_attempts" WHERE "id" = '${ATTEMPT_A}'`,
        )
      ).rows[0]?.count,
    ).toBe("0");
  });

  test("seals lifecycle before inventory and durable mode keeps tenant guards", async () => {
    const database = new PGlite();
    databases.push(database);
    await createPrerequisites(database);
    await database.exec(await migrationSql());

    const control = await database.query<{ mode: string; reconciled: Date | null }>(`
      SELECT mode, legacy_reconciled_through AS reconciled FROM auto_top_up_control
    `);
    expect(control.rows).toHaveLength(1);
    expect(control.rows[0]).toMatchObject({ mode: "paused", reconciled: null });

    await database.exec(`
      INSERT INTO users (id, organization_id) VALUES ('${USER_A}', '${ORG_A}');
    `);
    await expectDatabaseConstraint(
      database.exec(`DELETE FROM organizations WHERE id = '${ORG_A}'`),
      { code: "23503", constraint: "auto_top_up_cutover_paused" },
    );
    await expectDatabaseConstraint(
      database.exec(`UPDATE users SET organization_id = '${ORG_B}' WHERE id = '${USER_A}'`),
      { code: "23503", constraint: "auto_top_up_cutover_paused" },
    );

    await database.exec(`
      UPDATE auto_top_up_control
      SET mode = 'durable', legacy_reconciled_through = paused_at;
      INSERT INTO auto_top_up_legacy_payment_quarantine (
        organization_id, stripe_payment_intent_id, provider_status, credit_amount_cents
      ) VALUES ('${ORG_A}', 'pi_quarantined', 'canceled', 1000);
    `);
    await expectDatabaseConstraint(
      database.exec(`DELETE FROM organizations WHERE id = '${ORG_A}'`),
      { code: "23503", constraint: "auto_top_up_unresolved_work" },
    );
    await expectDatabaseConstraint(
      database.exec(`UPDATE users SET organization_id = '${ORG_B}' WHERE id = '${USER_A}'`),
      { code: "23503", constraint: "auto_top_up_unresolved_work" },
    );

    await expect(
      database.exec(`
        UPDATE auto_top_up_legacy_payment_quarantine
        SET status = 'credited', resolved_at = now()
        WHERE stripe_payment_intent_id = 'pi_quarantined'
      `),
    ).rejects.toThrow(/auto_top_up_legacy_quarantine_resolution_check/i);
    await database.exec(`
      UPDATE auto_top_up_legacy_payment_quarantine
      SET status = 'canceled', resolved_at = now()
      WHERE stripe_payment_intent_id = 'pi_quarantined';
      UPDATE organizations SET credit_balance = 0 WHERE id = '${ORG_A}';
      UPDATE users SET organization_id = '${ORG_B}' WHERE id = '${USER_A}';
    `);
    const enabled = await database.query<{ enabled: boolean }>(`
      SELECT auto_top_up_enabled AS enabled FROM organizations WHERE id = '${ORG_A}'
    `);
    expect(enabled.rows[0]?.enabled).toBe(false);
    await database.exec(`DELETE FROM organizations WHERE id = '${ORG_A}'`);
    expect(
      (
        await database.query<{ count: string }>(`
          SELECT count(*)::text AS count FROM organizations WHERE id = '${ORG_A}'
        `)
      ).rows[0]?.count,
    ).toBe("0");
  });

  test("blocks a last-user vacate while unresolved and otherwise disarms future claims", async () => {
    const database = new PGlite();
    databases.push(database);
    await createPrerequisites(database);
    await database.exec(await migrationSql());
    await database.exec(`
      UPDATE auto_top_up_control
      SET mode = 'durable', legacy_reconciled_through = paused_at;
      INSERT INTO "users" ("id", "organization_id") VALUES ('${USER_A}', '${ORG_A}');
      ${validAttempt(ATTEMPT_A, ORG_A, "vacate-guard-active")}
    `);

    await expectDatabaseConstraint(
      database.exec(`UPDATE "users" SET "organization_id" = '${ORG_B}' WHERE "id" = '${USER_A}'`),
      { code: "23503", constraint: "auto_top_up_unresolved_work" },
    );
    await expectDatabaseConstraint(database.exec(`DELETE FROM "users" WHERE "id" = '${USER_A}'`), {
      code: "23503",
      constraint: "auto_top_up_unresolved_work",
    });
    expect(
      (
        await database.query<{ organizationId: string }>(`
          SELECT "organization_id"::text AS "organizationId" FROM "users" WHERE "id" = '${USER_A}'
        `)
      ).rows[0]?.organizationId,
    ).toBe(ORG_A);

    await database.exec(`
      INSERT INTO "credit_transactions" ("id", "organization_id")
      VALUES ('${CREDIT_TX}', '${ORG_A}');
      UPDATE "auto_top_up_attempts"
      SET "status" = 'credited', "next_attempt_at" = NULL,
          "stripe_payment_intent_id" = 'pi_vacate_guard',
          "credit_transaction_id" = '${CREDIT_TX}',
          "covered_balance_decrease_revision" = 0,
          "payment_succeeded_at" = now(), "credited_at" = now()
      WHERE "id" = '${ATTEMPT_A}';
    `);
    await expectDatabaseConstraint(
      database.exec(`UPDATE "users" SET "organization_id" = '${ORG_B}' WHERE "id" = '${USER_A}'`),
      { code: "23514", constraint: "organization_nonzero_credit_balance" },
    );
    await database.exec(`
      UPDATE "organizations" SET "credit_balance" = 0 WHERE "id" = '${ORG_A}';
      UPDATE "users" SET "organization_id" = '${ORG_B}' WHERE "id" = '${USER_A}';
    `);
    expect(
      (
        await database.query<{ enabled: boolean }>(`
          SELECT "auto_top_up_enabled" AS enabled FROM "organizations" WHERE "id" = '${ORG_A}'
        `)
      ).rows[0]?.enabled,
    ).toBe(false);
  });
});

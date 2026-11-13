/**
 * Migration 0552 extends the policy write fence of 0545 to rate-only
 * enrollment. Real SQL on PGlite: once an organization has `rate_enabled`,
 * every write that can change its tier, key cap or standing must carry a
 * Durable Object mutation permit in the same transaction; other tenants stay
 * unfenced.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const ENROLLED = "71000000-0000-4000-8000-000000000001";
const OTHER = "71000000-0000-4000-8000-000000000002";
const USER = "72000000-0000-4000-8000-000000000001";
const KEY = "73000000-0000-4000-8000-000000000001";
const OTHER_KEY = "73000000-0000-4000-8000-000000000002";

let client: PGlite;

async function apply(tag: string): Promise<void> {
  for (const statement of readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8").split(
    "--> statement-breakpoint",
  ))
    if (statement.trim()) await client.exec(statement);
}

/** Run statements in one transaction, optionally holding a valid mutation permit first. */
async function write(statements: string[], permitFor?: string): Promise<void> {
  await client.transaction(async (tx) => {
    if (permitFor)
      await tx.query(
        `INSERT INTO inference_policy_mutations(organization_id,mutation_id,fence_token,permit_expires_at,applying_txid,phase)
         VALUES($1,$2,'token',clock_timestamp()+interval '30 seconds',txid_current(),'applying')`,
        [permitFor, crypto.randomUUID()],
      );
    for (const statement of statements) await tx.query(statement);
  });
}

const FENCE = "INFERENCE_POLICY_FENCE_REQUIRED";

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE organizations(id uuid PRIMARY KEY, is_active boolean, account_lifecycle_state text,
      account_deletion_request_id uuid, paid_work_fenced_at timestamptz, settings jsonb);
    CREATE TABLE users(id uuid PRIMARY KEY, organization_id uuid, is_active boolean);
    CREATE TABLE api_keys(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, key_hash text,
      is_active boolean, deleted_at timestamptz, expires_at timestamptz, rate_limit integer, source_app_id uuid);
    CREATE TABLE user_moderation_status(user_id uuid, status text, total_violations integer);
    CREATE TABLE user_identities(user_id uuid, steward_user_id text, expires_at timestamptz, is_anonymous boolean);
  `);
  for (const name of [
    "organization_subscription_authorities",
    "organization_entitlements",
    "billing_subscriptions",
    "billing_subscription_revisions",
    "subscription_grants",
    "org_rate_limit_overrides",
    "organization_config",
    "organization_payment_reversal_holds",
    "subscription_allowance_periods",
  ])
    await client.exec(`CREATE TABLE ${name}(organization_id uuid, value text)`);
  await client.exec(`
    INSERT INTO organizations(id,is_active,account_lifecycle_state) VALUES
      ('${ENROLLED}',true,'active'),('${OTHER}',true,'active');
    INSERT INTO users(id,organization_id,is_active) VALUES ('${USER}','${ENROLLED}',true);
    INSERT INTO api_keys(id,organization_id,user_id,key_hash,is_active,rate_limit) VALUES
      ('${KEY}','${ENROLLED}','${USER}','h1',true,100),
      ('${OTHER_KEY}','${OTHER}',NULL,'h2',true,100);
  `);
  await apply("0545_inference_policy_mutation_fences");
  await apply("0552_inference_rate_policy_fences");
  await client.exec(
    `INSERT INTO inference_policy_authorities(organization_id) VALUES ('${ENROLLED}'),('${OTHER}')`,
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("rate-only enrollment fences policy writes", () => {
  test("enrollment itself requires a permit", async () => {
    await expect(
      write([
        `UPDATE inference_policy_authorities SET rate_enabled = true, epoch = epoch + 1 WHERE organization_id = '${ENROLLED}'`,
      ]),
    ).rejects.toThrow(FENCE);
    await write(
      [
        `UPDATE inference_policy_authorities SET rate_enabled = true, epoch = epoch + 1 WHERE organization_id = '${ENROLLED}'`,
      ],
      ENROLLED,
    );
    const { rows } = await client.query<{ rate_enabled: boolean; enabled: boolean }>(
      `SELECT rate_enabled, enabled FROM inference_policy_authorities WHERE organization_id = $1`,
      [ENROLLED],
    );
    expect(rows[0]).toEqual({ rate_enabled: true, enabled: false });
  });

  for (const [name, statement] of [
    ["key cap change", `UPDATE api_keys SET rate_limit = 1 WHERE id = '${KEY}'`],
    ["key revocation", `UPDATE api_keys SET is_active = false WHERE id = '${KEY}'`],
    ["key deletion", `DELETE FROM api_keys WHERE id = '${KEY}'`],
    ["organization disable", `UPDATE organizations SET is_active = false WHERE id = '${ENROLLED}'`],
    [
      "plan change",
      `INSERT INTO organization_subscription_authorities(organization_id) VALUES ('${ENROLLED}')`,
    ],
    [
      "rate override",
      `INSERT INTO org_rate_limit_overrides(organization_id) VALUES ('${ENROLLED}')`,
    ],
    ["user disable", `UPDATE users SET is_active = false WHERE id = '${USER}'`],
  ] as const) {
    test(`${name} without a permit is refused`, async () => {
      await expect(write([statement])).rejects.toThrow(FENCE);
    });
  }

  test("a permitted key cap change commits; a permit for another tenant does not count", async () => {
    await expect(
      write([`UPDATE api_keys SET rate_limit = 5 WHERE id = '${KEY}'`], OTHER),
    ).rejects.toThrow(FENCE);
    await write([`UPDATE api_keys SET rate_limit = 5 WHERE id = '${KEY}'`], ENROLLED);
    const { rows } = await client.query<{ rate_limit: number }>(
      `SELECT rate_limit FROM api_keys WHERE id = $1`,
      [KEY],
    );
    expect(rows[0]?.rate_limit).toBe(5);
  });

  test("an unenrolled tenant's writes stay unfenced", async () => {
    await write([`UPDATE api_keys SET rate_limit = 7 WHERE id = '${OTHER_KEY}'`]);
    await write([`UPDATE organizations SET is_active = false WHERE id = '${OTHER}'`]);
  });

  test("withdrawing rate-only enrollment also requires a permit", async () => {
    const statement = `UPDATE inference_policy_authorities SET rate_enabled = false, epoch = epoch + 1 WHERE organization_id = '${ENROLLED}'`;
    await expect(write([statement])).rejects.toThrow(FENCE);
    await write([statement], ENROLLED);
    await write([`UPDATE api_keys SET rate_limit = 9 WHERE id = '${KEY}'`]);
  });
});

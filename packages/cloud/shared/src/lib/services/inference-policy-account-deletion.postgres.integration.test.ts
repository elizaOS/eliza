/** Real isolated PostgreSQL metadata/guard regressions; no actor, enrollment, spend or provider acceptance. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { closeDatabaseConnectionsForTests } from "../../db/client";
import { writeTransaction } from "../../db/helpers";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import {
  clearDisabledInferencePolicyForAccountDeletion,
  prepareInferencePolicyForAccountDeletion,
} from "./inference-policy-fence";

const url = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
const namespace = `inference_policy_deletion_${randomUUID().replaceAll("-", "")}`;
let client: Client;
let scopedUrl: string;
const ids = Object.fromEntries(
  ["completeOn", "completeOff", "active", "pending", "history"].map((name) => [name, randomUUID()]),
);
function bindings(enabled: boolean, connectionString = scopedUrl) {
  return {
    DATABASE_URL: connectionString,
    TEST_DATABASE_URL: connectionString,
    INFERENCE_FUNDED_BUDGET_ADMISSION: String(enabled),
  };
}
async function erasePolicy(organizationId: string, enabled: boolean) {
  return runWithCloudBindingsAsync(bindings(enabled), () =>
    writeTransaction(async (tx) => {
      await clearDisabledInferencePolicyForAccountDeletion(tx, organizationId);
      await tx.execute(sql`DELETE FROM organizations WHERE id = ${organizationId}::uuid`);
    }),
  );
}

describe.skipIf(!url)("account deletion inference policy metadata", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname) ||
      !parsed.username.startsWith("qa_")
    )
      throw new Error("This suite requires an isolated loopback PostgreSQL QA role");
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`CREATE SCHEMA ${namespace}`);
    await client.query(`SET search_path TO ${namespace},pg_catalog`);
    parsed.searchParams.set("options", `-c search_path=${namespace},pg_catalog`);
    scopedUrl = parsed.toString();
    await client.query(`
      CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean,account_lifecycle_state text,
        account_deletion_request_id uuid,paid_work_fenced_at timestamptz,settings jsonb);
      CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid,is_active boolean);
      CREATE TABLE api_keys(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,is_active boolean,key_hash text);
      CREATE TABLE billing_funding_reservations(id uuid PRIMARY KEY,organization_id uuid,
        logical_operation_id text,funding_class text,billing_scope_id uuid,merchant_key text,
        requested_amount numeric,expires_at timestamptz,status text,UNIQUE(id,organization_id));
      CREATE TABLE billing_funding_allocations(reservation_id uuid,organization_id uuid,finalized_amount numeric);
      CREATE FUNCTION reject_subscription_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='23514'; END $$;
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
      await client.query(`CREATE TABLE ${name}(organization_id uuid)`);
    await client.query(
      "CREATE TABLE user_moderation_status(user_id uuid); CREATE TABLE user_identities(user_id uuid)",
    );
    const budgetMigration = await Bun.file(
      new URL("../../db/migrations/0544_inference_funding_budgets.sql", import.meta.url),
    ).text();
    for (const statement of budgetMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await client.query(statement);
    const policyMigration = (
      await Bun.file(
        new URL("../../db/migrations/0545_inference_policy_mutation_fences.sql", import.meta.url),
      ).text()
    ).split("--> statement-breakpoint");
    for (const statement of policyMigration.slice(0, 2)) await client.query(statement);
    // Seed historical metadata before installing its write guards; this is not actor enrollment.
    for (const [name, id] of Object.entries(ids)) {
      await client.query("INSERT INTO organizations(id,is_active)VALUES($1,false)", [id]);
      await client.query(
        "INSERT INTO inference_policy_authorities(organization_id,enabled,epoch)VALUES($1,$2,2)",
        [id, name === "active"],
      );
      await client.query(
        `INSERT INTO inference_policy_mutations(organization_id,mutation_id,fence_token,
        permit_expires_at,applying_txid,phase,epoch)VALUES($1,'fixture','fixture-token',clock_timestamp()+interval '1 minute',txid_current(),$2,2)`,
        [id, name === "pending" ? "applied" : "complete"],
      );
    }
    for (const statement of policyMigration.slice(2))
      if (statement.trim()) await client.query(statement);
    await client.query(
      `INSERT INTO inference_funding_budget_receipts(organization_id,request_id,request_digest,amount,metadata)
      VALUES($1,'historical-zero-cost','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',0,'{}')`,
      [ids.history],
    );
  });
  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
    if (client) {
      await client.query(`DROP SCHEMA ${namespace} CASCADE`);
      await client.end();
    }
  });

  test("acknowledged inactive metadata permits organization FK erasure", async () => {
    await expect(erasePolicy(ids.completeOn, true)).resolves.toBeUndefined();
    expect(
      (await client.query("SELECT id FROM organizations WHERE id=$1", [ids.completeOn])).rows,
    ).toHaveLength(0);
  });
  test("acknowledged rollback still permits erasure after the global feature flag is off", async () => {
    await expect(
      runWithCloudBindingsAsync(bindings(false), () =>
        prepareInferencePolicyForAccountDeletion(ids.completeOff),
      ),
    ).resolves.toBeUndefined();
    await expect(erasePolicy(ids.completeOff, false)).resolves.toBeUndefined();
    expect(
      (await client.query("SELECT id FROM organizations WHERE id=$1", [ids.completeOff])).rows,
    ).toHaveLength(0);
  });
  test("active authority cannot be erased or silently disabled with the global flag off", async () => {
    await expect(
      runWithCloudBindingsAsync(bindings(false), () =>
        prepareInferencePolicyForAccountDeletion(ids.active),
      ),
    ).rejects.toThrow("Keep funded budget admission enabled");
    for (const enabled of [true, false])
      await expect(erasePolicy(ids.active, enabled)).rejects.toMatchObject({
        code: "INFERENCE_POLICY_DRAIN_PENDING",
      });
    expect(
      (
        await client.query(
          "SELECT enabled FROM inference_policy_authorities WHERE organization_id=$1",
          [ids.active],
        )
      ).rows,
    ).toEqual([{ enabled: true }]);
  });
  test("unacknowledged mutations keep organization and policy receipts intact", async () => {
    for (const enabled of [true, false])
      await expect(erasePolicy(ids.pending, enabled)).rejects.toMatchObject({
        code: "INFERENCE_POLICY_DRAIN_PENDING",
      });
    expect(
      (
        await client.query(
          "SELECT phase FROM inference_policy_mutations WHERE organization_id=$1",
          [ids.pending],
        )
      ).rows,
    ).toEqual([{ phase: "applied" }]);
  });
  test("retained funding history is refused without deleting its evidence", async () => {
    for (const enabled of [true, false])
      await expect(erasePolicy(ids.history, enabled)).rejects.toMatchObject({
        code: "INFERENCE_BUDGET_HISTORY_RETENTION_REQUIRED",
      });
    expect(
      (
        await client.query(
          "SELECT request_id,amount FROM inference_funding_budget_receipts WHERE organization_id=$1",
          [ids.history],
        )
      ).rows,
    ).toEqual([{ request_id: "historical-zero-cost", amount: "0.000000" }]);
    expect(
      (await client.query("SELECT id FROM organizations WHERE id=$1", [ids.history])).rows,
    ).toHaveLength(1);
  });
  test("feature-off deployments before these migrations retain ordinary erasure", async () => {
    const oldNamespace = `${namespace}_old`;
    await client.query(
      `CREATE SCHEMA ${oldNamespace};CREATE TABLE ${oldNamespace}.organizations(id uuid PRIMARY KEY)`,
    );
    const id = randomUUID();
    await client.query(`INSERT INTO ${oldNamespace}.organizations VALUES($1)`, [id]);
    const oldUrl = new URL(scopedUrl);
    oldUrl.searchParams.set("options", `-c search_path=${oldNamespace},pg_catalog`);
    await runWithCloudBindingsAsync(bindings(false, oldUrl.toString()), async () => {
      await prepareInferencePolicyForAccountDeletion(id);
      await writeTransaction(async (tx) => {
        await clearDisabledInferencePolicyForAccountDeletion(tx, id);
        await tx.execute(sql`DELETE FROM organizations WHERE id=${id}::uuid`);
      });
    });
    expect((await client.query(`SELECT id FROM ${oldNamespace}.organizations`)).rows).toHaveLength(
      0,
    );
    await closeDatabaseConnectionsForTests();
    await client.query(`DROP SCHEMA ${oldNamespace} CASCADE`);
  });
});

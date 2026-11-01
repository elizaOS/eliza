/** Real PostgreSQL MVCC proof. PGlite cannot exercise two concurrent snapshots. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const url = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
const schema = `inference_snapshot_fence_${randomUUID().replaceAll("-", "_")}`;
let primary: Client;
let writer: Client;
let association: Client;
let writerPid: number;
let associationPid: number;

async function permit(client: Client, organizationId: string, lifetime = "30 seconds") {
  await client.query(
    `INSERT INTO inference_policy_mutations
      (organization_id,mutation_id,fence_token,permit_expires_at,applying_txid,phase)
     VALUES($1,$2,'local-test-only',clock_timestamp()+$3::interval,txid_current(),'applying')`,
    [organizationId, randomUUID(), lifetime],
  );
}

async function seed(authority = true) {
  const organizationId = randomUUID();
  const keyId = randomUUID();
  await primary.query("INSERT INTO organizations(id,is_active,settings) VALUES($1,true,'{}')", [
    organizationId,
  ]);
  await primary.query("INSERT INTO api_keys(id,organization_id,rate_limit) VALUES($1,$2,100)", [
    keyId,
    organizationId,
  ]);
  if (authority)
    await primary.query("INSERT INTO inference_policy_authorities(organization_id) VALUES($1)", [
      organizationId,
    ]);
  return { organizationId, keyId };
}

async function enroll(organizationId: string, commit = true) {
  await primary.query("BEGIN");
  await permit(primary, organizationId);
  await primary.query(
    `INSERT INTO inference_policy_authorities(organization_id,rate_enabled,epoch)
     VALUES($1,true,1) ON CONFLICT(organization_id) DO UPDATE
     SET rate_enabled=true,epoch=inference_policy_authorities.epoch+1`,
    [organizationId],
  );
  if (commit) await primary.query("COMMIT");
}

async function writeOutcome(query: string, values: string[], client = writer) {
  try {
    await client.query(query, values);
    await client.query("COMMIT");
    return "committed";
  } catch (error) {
    await client.query("ROLLBACK");
    return (error as { code?: string }).code;
  }
}

async function waitingForLock(pid = writerPid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await primary.query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [
      pid,
    ]);
    if (result.rows[0]?.wait_event === "advisory") return true;
    await Bun.sleep(10);
  }
  return false;
}

async function waitForWriterLock() {
  if (!(await waitingForLock()))
    throw new Error("The concurrent writer did not reach the advisory lock");
}

async function standingFixture() {
  const old = await seed();
  const current = await seed();
  const userId = randomUUID();
  await primary.query("INSERT INTO users(id,organization_id,is_active) VALUES($1,$2,true)", [
    userId,
    old.organizationId,
  ]);
  await primary.query("INSERT INTO user_moderation_status(user_id,status) VALUES($1,'active')", [
    userId,
  ]);
  await enroll(current.organizationId);
  return { old, current, userId };
}

(url ? describe : describe.skip)("inference policy snapshot fence on PostgreSQL", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname) ||
      !parsed.username.startsWith("qa_")
    )
      throw new Error("This suite requires an isolated loopback PostgreSQL QA role");
    primary = new Client({ connectionString: url });
    writer = new Client({ connectionString: url });
    association = new Client({ connectionString: url });
    await Promise.all([primary.connect(), writer.connect(), association.connect()]);
    writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    associationPid = (await association.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await primary.query(`CREATE SCHEMA ${schema}`);
    for (const client of [primary, writer, association])
      await client.query(`SET search_path TO ${schema}`);
    await primary.query(`
      CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean,settings jsonb);
      CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid,is_active boolean);
      CREATE TABLE api_keys(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,rate_limit integer);
      CREATE TABLE user_moderation_status(user_id uuid,status text,total_violations integer);
      CREATE TABLE user_identities(user_id uuid,steward_user_id text,expires_at timestamptz,is_anonymous boolean);
    `);
    for (const table of [
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
      await primary.query(`CREATE TABLE ${table}(organization_id uuid)`);
    for (const migration of [
      "0545_inference_policy_mutation_fences",
      "0552_inference_rate_policy_fences",
      "0553_inference_policy_snapshot_fence",
    ]) {
      const source = await readFile(
        new URL(`./migrations/${migration}.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of source.split("--> statement-breakpoint"))
        if (statement.trim()) await primary.query(statement);
    }
  }, 60_000);

  afterEach(async () => {
    await primary.query("ROLLBACK");
    await Promise.all([writer.query("ROLLBACK"), association.query("ROLLBACK")]);
  });

  afterAll(async () => {
    if (!primary) return;
    await Promise.all([
      primary.query("ROLLBACK"),
      writer.query("ROLLBACK"),
      association.query("ROLLBACK"),
    ]);
    await primary.query(`DROP SCHEMA ${schema} CASCADE`);
    await Promise.all([primary.end(), writer.end(), association.end()]);
  });

  for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
    for (const state of ["unenrolled", "missing authority", "withdrawn"]) {
      for (const target of ["key cap", "organization policy"]) {
        test(`${isolation}: old ${state} snapshot cannot write ${target} after enrollment`, async () => {
          const { organizationId, keyId } = await seed(state !== "missing authority");
          if (state === "withdrawn") {
            await enroll(organizationId);
            await primary.query("BEGIN");
            await permit(primary, organizationId);
            await primary.query(
              "UPDATE inference_policy_authorities SET rate_enabled=false,epoch=epoch+1 WHERE organization_id=$1",
              [organizationId],
            );
            await primary.query("COMMIT");
          }
          await writer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          await writer.query(
            "SELECT rate_enabled FROM inference_policy_authorities WHERE organization_id=$1",
            [organizationId],
          );
          await enroll(organizationId);
          expect(
            await writeOutcome(
              target === "key cap"
                ? "UPDATE api_keys SET rate_limit=7 WHERE id=$1"
                : 'UPDATE organizations SET settings=\'{"tier":"changed"}\' WHERE id=$1',
              [target === "key cap" ? keyId : organizationId],
            ),
          ).toBe("40001");
        });
      }
    }
  }

  for (const committed of [true, false]) {
    test(`READ COMMITTED waits for pending enrollment ${committed ? "commit" : "rollback"}`, async () => {
      const { organizationId, keyId } = await seed();
      await enroll(organizationId, false);
      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const pending = writeOutcome("UPDATE api_keys SET rate_limit=9 WHERE id=$1", [keyId]);
      await waitForWriterLock();
      await primary.query(committed ? "COMMIT" : "ROLLBACK");
      expect(await pending).toBe(committed ? "P0001" : "committed");
    });
  }

  test("a same-transaction permit allows a snapshot-isolated writer", async () => {
    const { organizationId, keyId } = await seed();
    await enroll(organizationId);
    await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await permit(writer, organizationId);
    expect(await writeOutcome("UPDATE api_keys SET rate_limit=3 WHERE id=$1", [keyId])).toBe(
      "committed",
    );
  });

  test("a permit that expires while waiting on the lock is refused", async () => {
    const { organizationId, keyId } = await seed();
    await enroll(organizationId);
    await primary.query("BEGIN");
    await primary.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `inference-policy:${organizationId}`,
    ]);
    await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await permit(writer, organizationId, "100 milliseconds");
    const pending = writeOutcome("UPDATE api_keys SET rate_limit=3 WHERE id=$1", [keyId]);
    await waitForWriterLock();
    await primary.query("SELECT pg_sleep(0.2)");
    await primary.query("COMMIT");
    expect(await pending).toBe("40001");
  });

  for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
    for (const association of ["no previous organization", "permitted previous organization"]) {
      for (const target of ["moderation", "identity"]) {
        test(`${isolation}: ${association} cannot hide a new organization from ${target} writes`, async () => {
          const userId = randomUUID();
          const previous = association === "permitted previous organization" ? await seed() : null;
          await primary.query(
            "INSERT INTO users(id,organization_id,is_active) VALUES($1,$2,true)",
            [userId, previous?.organizationId ?? null],
          );
          await primary.query(
            "INSERT INTO user_moderation_status(user_id,status) VALUES($1,'active')",
            [userId],
          );
          await primary.query(
            "INSERT INTO user_identities(user_id,steward_user_id) VALUES($1,'old-identity')",
            [userId],
          );
          if (previous) await enroll(previous.organizationId);
          await writer.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          await writer.query("SELECT organization_id FROM users WHERE id=$1", [userId]);
          if (previous) await permit(writer, previous.organizationId);
          const current = await seed();
          await enroll(current.organizationId);
          await primary.query("BEGIN");
          await permit(primary, current.organizationId);
          await primary.query("UPDATE api_keys SET user_id=$1 WHERE id=$2", [
            userId,
            current.keyId,
          ]);
          await primary.query("COMMIT");
          expect(
            await writeOutcome(
              target === "moderation"
                ? "UPDATE user_moderation_status SET status='blocked' WHERE user_id=$1"
                : "UPDATE user_identities SET steward_user_id='new-identity' WHERE user_id=$1",
              [userId],
            ),
          ).toBe("40001");
        });
      }
    }
  }

  test("an unchanged user authority field retains its no-op path", async () => {
    const userId = randomUUID();
    await primary.query("INSERT INTO users(id,is_active) VALUES($1,true)", [userId]);
    await writer.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(await writeOutcome("UPDATE users SET is_active=true WHERE id=$1", [userId])).toBe(
      "committed",
    );
  });

  test("a standing change rechecks associations after a key transaction commits", async () => {
    const { current, userId } = await standingFixture();
    await primary.query("BEGIN");
    await permit(primary, current.organizationId);
    await primary.query("UPDATE api_keys SET user_id=$1 WHERE id=$2", [userId, current.keyId]);
    await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const pending = writeOutcome(
      "UPDATE user_moderation_status SET status='blocked' WHERE user_id=$1",
      [userId],
    );
    const waited = await waitingForLock();
    await primary.query("COMMIT");
    expect(await pending).toBe("P0001");
    expect(waited).toBe(true);
  });

  test("a new key waits for an earlier standing change before it can publish", async () => {
    const { old, current, userId } = await standingFixture();
    await primary.query("BEGIN");
    await primary.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `inference-policy:${old.organizationId}`,
    ]);
    await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const standing = writeOutcome(
      "UPDATE user_moderation_status SET status='blocked' WHERE user_id=$1",
      [userId],
    );
    await waitForWriterLock();
    await association.query("BEGIN");
    await permit(association, current.organizationId);
    const linking = writeOutcome(
      "UPDATE api_keys SET user_id=$1 WHERE id=$2",
      [userId, current.keyId],
      association,
    );
    const waited = await waitingForLock(associationPid);
    await primary.query("COMMIT");
    expect(await standing).toBe("committed");
    expect(await linking).toBe("committed");
    expect(waited).toBe(true);
  });

  test("reassigning a key holds both the old and new user's association locks", async () => {
    const current = await seed();
    const oldUser = randomUUID();
    const newUser = randomUUID();
    for (const user of [oldUser, newUser]) {
      await primary.query("INSERT INTO users(id,is_active) VALUES($1,true)", [user]);
      await primary.query(
        "INSERT INTO user_moderation_status(user_id,status) VALUES($1,'active')",
        [user],
      );
    }
    await enroll(current.organizationId);
    await primary.query("BEGIN");
    await permit(primary, current.organizationId);
    await primary.query("UPDATE api_keys SET user_id=$1 WHERE id=$2", [oldUser, current.keyId]);
    await primary.query("COMMIT");
    await primary.query("BEGIN");
    await permit(primary, current.organizationId);
    await primary.query("UPDATE api_keys SET user_id=$1 WHERE id=$2", [newUser, current.keyId]);
    await writer.query("BEGIN");
    await association.query("BEGIN");
    const oldStanding = writeOutcome(
      "UPDATE user_moderation_status SET status='blocked' WHERE user_id=$1",
      [oldUser],
    );
    const newStanding = writeOutcome(
      "UPDATE user_moderation_status SET status='blocked' WHERE user_id=$1",
      [newUser],
      association,
    );
    const oldWaited = await waitingForLock();
    const newWaited = await waitingForLock(associationPid);
    await primary.query("COMMIT");
    expect(await oldStanding).toBe("committed");
    expect(await newStanding).toBe("P0001");
    expect(oldWaited && newWaited).toBe(true);
  });

  test("moving a key to another organization cannot escape the new owner's fence", async () => {
    const old = await seed();
    const current = await seed();
    const userId = randomUUID();
    await primary.query("INSERT INTO users(id,is_active) VALUES($1,true)", [userId]);
    await primary.query("INSERT INTO user_moderation_status(user_id,status) VALUES($1,'active')", [
      userId,
    ]);
    for (const org of [old.organizationId, current.organizationId]) await enroll(org);
    await primary.query("BEGIN");
    await permit(primary, old.organizationId);
    await primary.query("UPDATE api_keys SET user_id=$1 WHERE id=$2", [userId, old.keyId]);
    await primary.query("COMMIT");
    await primary.query("BEGIN");
    for (const org of [old.organizationId, current.organizationId]) await permit(primary, org);
    await primary.query("UPDATE api_keys SET organization_id=$1 WHERE id=$2", [
      current.organizationId,
      old.keyId,
    ]);
    await writer.query("BEGIN");
    const pending = writeOutcome(
      "UPDATE user_moderation_status SET status='blocked' WHERE user_id=$1",
      [userId],
    );
    const waited = await waitingForLock();
    await primary.query("COMMIT");
    expect(await pending).toBe("P0001");
    expect(waited).toBe(true);
  });

  test("deleting a key releases its user association only when the transaction commits", async () => {
    const current = await seed();
    const userId = randomUUID();
    await primary.query("INSERT INTO users(id,is_active) VALUES($1,true)", [userId]);
    await primary.query("INSERT INTO user_moderation_status(user_id,status) VALUES($1,'active')", [
      userId,
    ]);
    await enroll(current.organizationId);
    await primary.query("BEGIN");
    await permit(primary, current.organizationId);
    await primary.query("UPDATE api_keys SET user_id=$1 WHERE id=$2", [userId, current.keyId]);
    await primary.query("COMMIT");
    await primary.query("BEGIN");
    await permit(primary, current.organizationId);
    await primary.query("DELETE FROM api_keys WHERE id=$1", [current.keyId]);
    await writer.query("BEGIN");
    const pending = writeOutcome(
      "UPDATE user_moderation_status SET status='blocked' WHERE user_id=$1",
      [userId],
    );
    const waited = await waitingForLock();
    await primary.query("COMMIT");
    expect(await pending).toBe("committed");
    expect(waited).toBe(true);
  });

  test("raw SQL with reversed lock order fails closed instead of publishing both writes", async () => {
    const { old, current, userId } = await standingFixture();
    await primary.query("BEGIN");
    await primary.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `inference-policy:${old.organizationId}`,
    ]);
    await writer.query("BEGIN");
    const standing = writeOutcome(
      "UPDATE user_moderation_status SET status='blocked' WHERE user_id=$1",
      [userId],
    );
    await waitForWriterLock();
    await permit(primary, current.organizationId);
    const linking = writeOutcome(
      "UPDATE api_keys SET user_id=$1 WHERE id=$2",
      [userId, current.keyId],
      primary,
    );
    const results = await Promise.all([standing, linking]);
    expect(results).toContain("40P01");
    expect(results.filter((result) => result === "committed")).toHaveLength(1);
  });
});

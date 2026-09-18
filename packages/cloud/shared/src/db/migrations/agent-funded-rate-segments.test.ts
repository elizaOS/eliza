/** Executes tariff transitions through the deployed SQL trigger in an isolated database. */
import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const databases: PGlite[] = [];
const agentId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const otherOrganizationId = "00000000-0000-4000-8000-000000000003";

async function migrate(db: PGlite, name: string) {
  const sql = await Bun.file(new URL(name, import.meta.url)).text();
  await db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
}

async function fixture() {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY, organization_id uuid, lifecycle_revision bigint,
      status text, execution_tier text, pool_status text, last_backup_at timestamptz
    );
    CREATE TABLE agent_compute_funding (
      agent_id uuid, organization_id uuid, hourly_rate numeric(16,6),
      settled_at timestamptz, host_lease_confirmed_at timestamptz
    );
    CREATE UNIQUE INDEX open_funding ON agent_compute_funding(agent_id) WHERE settled_at IS NULL;
    CREATE TABLE compute_billing_rate_segments (
      id uuid DEFAULT gen_random_uuid(), organization_id uuid, workload_kind text,
      workload_id uuid, lifecycle_revision bigint, billing_state text,
      rate_per_hour numeric(16,6), effective_at timestamptz DEFAULT clock_timestamp()
    );
  `);
  await migrate(db, "0298_warm_pool_rate_segment_exemption.sql");
  await db.query("INSERT INTO agent_sandboxes VALUES ($1,$2,1,'running','dedicated',NULL,NULL)", [
    agentId,
    organizationId,
  ]);
  return db;
}

async function fund(db: PGlite, rate = "0.150000", tenant = organizationId) {
  await db.query("INSERT INTO agent_compute_funding VALUES ($1,$2,$3,NULL,clock_timestamp())", [
    agentId,
    tenant,
    rate,
  ]);
}

async function latest(db: PGlite) {
  return (
    await db.query(
      "SELECT billing_state,rate_per_hour FROM compute_billing_rate_segments ORDER BY effective_at DESC,id DESC LIMIT 1",
    )
  ).rows[0];
}

async function backup(db: PGlite) {
  await db.exec(
    "UPDATE agent_sandboxes SET last_backup_at=clock_timestamp(),lifecycle_revision=lifecycle_revision+1",
  );
}

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});

test("backup updates retain the accepted funded tariff; stop and resume retain their own states", async () => {
  const db = await fixture();
  await fund(db);
  await migrate(db, "0396_agent_funded_rate_segments.sql");
  await backup(db);
  expect(await latest(db)).toEqual({ billing_state: "running", rate_per_hour: "0.150000" });
  await db.exec("UPDATE agent_sandboxes SET status='stopped'");
  expect(await latest(db)).toEqual({ billing_state: "backup", rate_per_hour: "0.002500" });
  await db.exec("UPDATE agent_sandboxes SET status='running'");
  expect(await latest(db)).toEqual({ billing_state: "running", rate_per_hour: "0.150000" });
});

test("cutover appends once without rewriting historical charges or applying current catalog pricing", async () => {
  const db = await fixture();
  await fund(db, "0.123456");
  const history = (await db.query("SELECT * FROM compute_billing_rate_segments")).rows;
  await migrate(db, "0396_agent_funded_rate_segments.sql");
  expect(await latest(db)).toEqual({ billing_state: "running", rate_per_hour: "0.123456" });
  await migrate(db, "0396_agent_funded_rate_segments.sql");
  const rows = (await db.query("SELECT * FROM compute_billing_rate_segments ORDER BY effective_at"))
    .rows;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(history[0]);
  await backup(db);
  expect(await latest(db)).toEqual({ billing_state: "running", rate_per_hour: "0.123456" });
});

test.each(["shared", "pool"])("%s agents remain exempt even with funding", async (kind) => {
  const db = await fixture();
  await fund(db);
  await db.exec(
    kind === "shared"
      ? "UPDATE agent_sandboxes SET execution_tier='shared'"
      : "UPDATE agent_sandboxes SET pool_status='ready'",
  );
  await migrate(db, "0396_agent_funded_rate_segments.sql");
  await backup(db);
  expect(await latest(db)).toEqual({ billing_state: "exempt", rate_per_hour: "0.000000" });
});

test.each(["legacy", "wrong tenant", "settled"])(
  "%s does not acquire another funded tariff",
  async (kind) => {
    const db = await fixture();
    if (kind !== "legacy")
      await fund(db, "0.150000", kind === "wrong tenant" ? otherOrganizationId : organizationId);
    if (kind === "settled")
      await db.exec("UPDATE agent_compute_funding SET settled_at=clock_timestamp()");
    await migrate(db, "0396_agent_funded_rate_segments.sql");
    await backup(db);
    expect(await latest(db)).toEqual({ billing_state: "running", rate_per_hour: "0.010000" });
  },
);

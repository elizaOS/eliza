import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { readDeletionBillingProvenance } from "./deletion-billing-provenance-report";
import {
  assertStagingDatabaseIdentity,
  assertStagingOperatorEnvironment,
} from "./staging-database-identity-pin";
import {
  parseRepairOptions,
  runStagingDeletionRowRepair,
} from "./staging-deletion-row-repair";

let db: PGlite | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

const migration = await readFile(
  new URL(
    "../../shared/src/db/migrations/0398_provider_unconfirmed_deletion_billing.sql",
    import.meta.url,
  ),
  "utf8",
);
const org = "00000000-0000-4000-8000-000000000001";
const agent = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const reason = "Owner-approved staging repair of the legacy 0398 blocker row";
const trusted = async () => {};

async function seed(extra = "") {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE containers(id uuid, organization_id uuid, lifecycle_revision int, status text);
    CREATE TABLE compute_billing_rate_segments(id int, organization_id uuid, workload_kind text, workload_id uuid, lifecycle_revision int, billing_state text, rate_per_hour numeric, effective_at timestamptz);
    CREATE TABLE container_compute_stop_intents(organization_id uuid, container_id uuid, lifecycle_revision int, provider_confirmed_at timestamptz);
    CREATE TABLE agent_sandboxes(id uuid, organization_id uuid, status text, billing_status text, pool_status text, execution_tier text, deleted_at timestamptz, updated_at timestamptz, deletion_attempt_id uuid, deletion_previous_billing_status text, deletion_previous_status text, last_backup_at timestamptz);
    CREATE TABLE agent_compute_funding(organization_id uuid, agent_id uuid, settled_at timestamptz, provider_stopped_at timestamptz, provider_stop_receipt jsonb, settled_through timestamptz);
    CREATE TABLE agent_compute_stop_intents(organization_id uuid, agent_id uuid, status text, provider_confirmed_at timestamptz);
    INSERT INTO agent_sandboxes VALUES('${agent}', '${org}', 'deletion_failed', 'suspended', NULL, 'dedicated', NULL, NULL, '${other}', NULL, NULL, NULL);
    INSERT INTO agent_sandboxes VALUES('${other}', '${org}', 'running', 'active', NULL, 'dedicated', NULL, NULL, NULL, NULL, NULL, NULL);
    ${extra}
  `);
  return db;
}

test("dry-run lists the guarded row and changes nothing", async () => {
  const client = await seed();
  const receipt = await runStagingDeletionRowRepair(
    client,
    migration,
    { mode: "dry-run" },
    trusted,
  );
  expect(receipt.guardedAgents).toEqual([
    {
      id: agent,
      status: "deletion_failed",
      billingStatus: "suspended",
      deletionPreviousStatus: null,
      deletionPreviousBillingStatus: null,
      executionTier: "dedicated",
      poolStatus: null,
      deleted: false,
      hasDeletionAttempt: true,
      hasFunding: false,
      hasStopIntent: false,
    },
  ]);
  expect(receipt.changedAgentId).toBeNull();
  expect(JSON.stringify(receipt)).not.toContain(org);
  expect(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM agent_sandboxes WHERE deleted_at IS NOT NULL",
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});

test("apply retires exactly the guarded row and clears the 0398 agent guard", async () => {
  const client = await seed();
  const receipt = await runStagingDeletionRowRepair(
    client,
    migration,
    { mode: "apply", agentId: agent, reason },
    trusted,
  );
  expect(receipt.changedAgentId).toBe(agent);
  expect(receipt.remainingUnresolvedAgentCount).toBe(0);
  expect(
    (
      await client.query(
        "SELECT id::text, status, billing_status, deleted_at IS NOT NULL AS deleted FROM agent_sandboxes ORDER BY id",
      )
    ).rows,
  ).toEqual([
    {
      id: agent,
      status: "deletion_failed",
      billing_status: "suspended",
      deleted: true,
    },
    { id: other, status: "running", billing_status: "active", deleted: false },
  ]);
  const report = await readDeletionBillingProvenance(client, migration);
  expect(report.unresolvedAgentProvenanceCount).toBe(0);
  expect(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM compute_billing_rate_segments",
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});

test("apply refuses a different id, extra guarded rows, or a row with stop/funding records", async () => {
  let client = await seed();
  await expect(
    runStagingDeletionRowRepair(
      client,
      migration,
      { mode: "apply", agentId: other, reason },
      trusted,
    ),
  ).rejects.toThrow("agent_id_does_not_match_guard");
  await db?.close();

  const third = "00000000-0000-4000-8000-000000000004";
  client = await seed(
    `INSERT INTO agent_sandboxes VALUES('${third}', '${org}', 'deletion_pending', 'suspended', NULL, 'dedicated', NULL, NULL, NULL, NULL, NULL, NULL);`,
  );
  await expect(
    runStagingDeletionRowRepair(
      client,
      migration,
      { mode: "apply", agentId: agent, reason },
      trusted,
    ),
  ).rejects.toThrow("guard_must_report_exactly_one_row");
  await db?.close();

  client = await seed(
    `INSERT INTO agent_compute_stop_intents VALUES('${org}', '${agent}', 'requested', NULL);`,
  );
  await expect(
    runStagingDeletionRowRepair(
      client,
      migration,
      { mode: "apply", agentId: agent, reason },
      trusted,
    ),
  ).rejects.toThrow("row_state_not_approved");
  expect(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM agent_sandboxes WHERE deleted_at IS NOT NULL",
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});

test("identity mismatch aborts before reading or writing rows", async () => {
  const client = await seed();
  await expect(
    runStagingDeletionRowRepair(
      client,
      migration,
      { mode: "apply", agentId: agent, reason },
      (c) =>
        assertStagingDatabaseIdentity(c, {
          clusterSha256: "0".repeat(64),
          authoritySha256: "0".repeat(64),
        }),
    ),
  ).rejects.toThrow();
  expect(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM agent_sandboxes WHERE deleted_at IS NOT NULL",
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});

test("options and environment admission fail closed", () => {
  expect(parseRepairOptions({}).mode).toBe("dry-run");
  expect(() => parseRepairOptions({ REPAIR_MODE: "force" })).toThrow(
    "invalid_mode",
  );
  expect(() =>
    parseRepairOptions({ REPAIR_MODE: "apply", REPAIR_REASON: reason }),
  ).toThrow("agent_id_required");
  expect(() =>
    parseRepairOptions({ REPAIR_MODE: "apply", REPAIR_AGENT_ID: agent }),
  ).toThrow("reason_required");
  expect(() =>
    parseRepairOptions({ REPAIR_AGENT_ID: "'; DROP TABLE x;--" }),
  ).toThrow("invalid_agent_id");
  expect(() =>
    assertStagingOperatorEnvironment({
      ELIZA_OPERATOR_ENVIRONMENT: "production",
      GITHUB_REF: "refs/heads/staging",
    }),
  ).toThrow("staging_operator_environment_required");
  expect(() =>
    assertStagingOperatorEnvironment({
      ELIZA_OPERATOR_ENVIRONMENT: "staging",
      GITHUB_REF: "refs/heads/main",
    }),
  ).toThrow("staging_operator_environment_required");
  expect(() =>
    assertStagingOperatorEnvironment({
      ELIZA_OPERATOR_ENVIRONMENT: "staging",
      GITHUB_REF: "refs/heads/staging",
    }),
  ).not.toThrow();
});

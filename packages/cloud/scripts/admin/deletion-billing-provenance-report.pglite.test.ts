import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  deletionBillingGuardQueries,
  readDeletionBillingProvenance,
} from "./deletion-billing-provenance-report";

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
const container = "00000000-0000-4000-8000-000000000003";

test("reports both actual migration guards without changing lifecycle or rate authority", async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE containers(id uuid, organization_id uuid, lifecycle_revision int, status text);
    CREATE TABLE compute_billing_rate_segments(id int, organization_id uuid, workload_kind text, workload_id uuid, lifecycle_revision int, billing_state text, rate_per_hour numeric, effective_at timestamptz);
    CREATE TABLE container_compute_stop_intents(organization_id uuid, container_id uuid, lifecycle_revision int, provider_confirmed_at timestamptz);
    CREATE TABLE agent_sandboxes(id uuid, organization_id uuid, status text, billing_status text, pool_status text, execution_tier text, deleted_at timestamptz, deletion_previous_billing_status text, deletion_previous_status text, last_backup_at timestamptz);
    CREATE TABLE agent_compute_funding(organization_id uuid, agent_id uuid, settled_at timestamptz, provider_stopped_at timestamptz, provider_stop_receipt jsonb, settled_through timestamptz);
    INSERT INTO containers VALUES('${container}', '${org}', 2, 'deleting');
    INSERT INTO agent_sandboxes VALUES('${agent}', '${org}', 'deletion_failed', 'suspended', NULL, 'dedicated', NULL, NULL, NULL, NULL);
  `);
  const first = await readDeletionBillingProvenance(db, migration);
  expect(first.unresolvedContainerHistoryCount).toBe(1);
  expect(first.unresolvedAgentProvenanceCount).toBe(1);
  expect(JSON.stringify(first)).not.toContain(org);
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS count FROM compute_billing_rate_segments",
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
  expect(
    (await db.query("SELECT status, billing_status FROM agent_sandboxes")).rows,
  ).toEqual([{ status: "deletion_failed", billing_status: "suspended" }]);

  // Existing consecutive lifecycle authority and an explicitly stopped,
  // never-backed-up agent satisfy the migration's own recovery predicates.
  await db.exec(`
    INSERT INTO compute_billing_rate_segments VALUES(1, '${org}', 'container', '${container}', 1, 'running', 0.01, '2026-10-01T00:00:00Z');
    INSERT INTO compute_billing_rate_segments VALUES(2, '${org}', 'container', '${container}', 2, 'not_billable', 0, '2026-10-02T00:00:00Z');
    UPDATE agent_sandboxes SET deletion_previous_status = 'stopped';
  `);
  const second = await readDeletionBillingProvenance(db, migration);
  expect(second.unresolvedContainerHistoryCount).toBe(0);
  expect(second.unresolvedAgentProvenanceCount).toBe(0);
  expect(
    (
      await db.query(
        "SELECT rate_per_hour::text AS rate FROM compute_billing_rate_segments ORDER BY id",
      )
    ).rows,
  ).toEqual([{ rate: "0.01" }, { rate: "0" }]);
});

test("refuses a changed guard contract before executing SQL", () => {
  expect(() => deletionBillingGuardQueries("SELECT 1;")).toThrow(
    "migration_guard_contract_changed",
  );
});

const fixtureKey = "owned-staging-fixture-test-credential";
const fixtureUser = "00000000-0000-4000-8000-000000000004";
const otherOrg = "00000000-0000-4000-8000-000000000005";

test("classifies the exact guarded agent without exposing IDs or inventing missing authority", async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE containers(id uuid, organization_id uuid, lifecycle_revision int, status text);
    CREATE TABLE compute_billing_rate_segments(id int, organization_id uuid, workload_kind text, workload_id uuid, lifecycle_revision int, billing_state text, rate_per_hour numeric, effective_at timestamptz);
    CREATE TABLE container_compute_stop_intents(organization_id uuid, container_id uuid, lifecycle_revision int, provider_confirmed_at timestamptz);
    CREATE TABLE agent_sandboxes(id uuid, organization_id uuid, user_id uuid, node_id text, container_name text, deletion_attempt_id uuid, status text, billing_status text, pool_status text, execution_tier text, deleted_at timestamptz, deletion_previous_billing_status text, deletion_previous_status text, last_backup_at timestamptz);
    CREATE TABLE agent_compute_funding(organization_id uuid, agent_id uuid, settled_at timestamptz, provider_stopped_at timestamptz, provider_stop_receipt jsonb, settled_through timestamptz);
    CREATE TABLE api_keys(key_hash text, organization_id uuid, user_id uuid, is_active bool, deleted_at timestamptz, expires_at timestamptz);
    CREATE TABLE users(id uuid, organization_id uuid, is_active bool, deleted_at timestamptz);
    CREATE TABLE jobs(organization_id uuid, agent_id text, type text, status text);
    CREATE TABLE agent_compute_stop_intents(organization_id uuid, agent_id uuid, status text, provider_confirmed_at timestamptz);
    INSERT INTO users VALUES('${fixtureUser}', '${org}', true, NULL);
    INSERT INTO api_keys VALUES('${createHash("sha256").update(fixtureKey).digest("hex")}', '${org}', '${fixtureUser}', true, NULL, NULL);
    INSERT INTO agent_sandboxes VALUES('${agent}', '${otherOrg}', '${fixtureUser}', 'private-node', 'private-container', '${container}', 'deletion_failed', 'suspended', NULL, 'dedicated-always', NULL, NULL, NULL, NULL);
    INSERT INTO jobs VALUES('${otherOrg}', '${agent}', 'agent_delete', 'failed');
  `);
  const report = await readDeletionBillingProvenance(db, migration, {
    fixtureApiKey: fixtureKey,
  });
  expect(report.unresolvedAgentProvenanceCount).toBe(1);
  expect(report.agentAuthorityFacts).toMatchObject({
    targetCount: 1,
    credentialOrganizationMatchCount: 0,
    credentialUserMatchCount: 0,
    missingPreviousStatusCount: 1,
    missingPreviousBillingStatusCount: 1,
    hasDeletionAttemptCount: 1,
    hasActiveDeleteJobCount: 0,
    hasCompletedDeleteJobCount: 0,
    hasFailedDeleteJobCount: 1,
    hasFundingCount: 0,
    hasProviderStoppedFundingReceiptCount: 0,
    hasProviderConfirmedStopIntentCount: 0,
    hasDockerLocatorCount: 1,
  });
  const closed = JSON.stringify(report);
  for (const forbidden of [
    agent,
    org,
    otherOrg,
    fixtureUser,
    fixtureKey,
    "private-node",
    "private-container",
  ])
    expect(closed).not.toContain(forbidden);
  await db.exec(`
    UPDATE agent_sandboxes SET organization_id = '${org}';
    UPDATE jobs SET organization_id = '${org}';
    INSERT INTO agent_compute_funding VALUES('${org}', '${agent}', NULL, NOW(), '{"fixture":true}', NULL);
    INSERT INTO agent_compute_stop_intents VALUES('${org}', '${agent}', 'provider_confirmed', NOW());
  `);
  const matched = await readDeletionBillingProvenance(db, migration, {
    fixtureApiKey: fixtureKey,
  });
  expect(matched.agentAuthorityFacts).toMatchObject({
    credentialOrganizationMatchCount: 1,
    credentialUserMatchCount: 1,
    hasFundingCount: 1,
    hasProviderStoppedFundingReceiptCount: 1,
    hasProviderConfirmedStopIntentCount: 1,
  });
  // Presence is not complete settled/fenced authority; the actual guard remains unresolved.
  expect(matched.unresolvedAgentProvenanceCount).toBe(1);
  expect(
    (
      await db.query(
        "SELECT status, billing_status, deletion_previous_status FROM agent_sandboxes",
      )
    ).rows,
  ).toEqual([
    {
      status: "deletion_failed",
      billing_status: "suspended",
      deletion_previous_status: null,
    },
  ]);
  await db.exec("UPDATE api_keys SET is_active = false");
  await expect(
    readDeletionBillingProvenance(db, migration, { fixtureApiKey: fixtureKey }),
  ).rejects.toThrow("fixture_identity_unavailable");
  // A failed identity read also rolls back and leaves the client usable.
  expect(
    (await db.query("SELECT count(*)::integer AS count FROM jobs")).rows,
  ).toEqual([{ count: 1 }]);
});

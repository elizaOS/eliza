/**
 * Applies the replacement-attempt migration to real isolated PGlite and proves
 * that its columns, named constraints, indexes, and append-only guards match
 * the merged Drizzle schema authority.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentSandboxReplacementAttempts } from "../schemas/agent-sandbox-replacement-attempts";

const migrationUrls = [
  "0321_agent_sandbox_replacement_attempts_table.sql",
  "0322_agent_sandbox_replacement_attempts_authority.sql",
  "0323_agent_sandbox_replacement_attempt_locator.sql",
  "0324_agent_sandbox_replacement_attempt_settlement.sql",
  "0325_agent_sandbox_replacement_attempt_admission_guards.sql",
  "0326_agent_sandbox_replacement_attempt_identity_guard.sql",
  "0327_agent_sandbox_replacement_attempt_locator_guard.sql",
  "0328_agent_sandbox_replacement_attempt_state_guard.sql",
  "0370_agent_sandbox_replacement_restore_locator.sql",
  "0371_agent_vault_key_seed_receipts_per_replacement.sql",
].map((migration) => new URL(`./${migration}`, import.meta.url));
const journalUrl = new URL("./meta/_journal.json", import.meta.url);
const databases: PGlite[] = [];

function migrationTag(url: URL): string {
  const filename = url.pathname.split("/").at(-1);
  if (!filename) {
    throw new Error(`Migration URL has no filename: ${url.href}`);
  }
  return filename.replace(/\.sql$/, "");
}

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_AGENT_ID = "20000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_ATTEMPT_ID = "30000000-0000-4000-8000-000000000002";
const THIRD_ATTEMPT_ID = "30000000-0000-4000-8000-000000000003";
const ACTIVATION_GENERATION = "40000000-0000-4000-8000-000000000001";
const OTHER_ACTIVATION_GENERATION = "40000000-0000-4000-8000-000000000002";
const RESTORE_LEASE_ID = "50000000-0000-4000-8000-000000000001";
const BACKUP_ID = "60000000-0000-4000-8000-000000000001";
const RESTORE_ATTEMPT_ID = "70000000-0000-4000-8000-000000000001";
const RESTORE_GENERATION = "80000000-0000-4000-8000-000000000001";
const RESTORE_OPERATION_ID = "90000000-0000-4000-8000-000000000001";
const RESTORE_SOURCE_GENERATION = "a0000000-0000-4000-8000-000000000001";
const DIGEST = "a".repeat(64);
const LIFECYCLE_DIGEST = "b".repeat(64);
const CLEANUP_DIGEST = "c".repeat(64);
const NODE_RECORD_ID = "b0000000-0000-4000-8000-000000000001";
const NODE_INCARNATION = "c0000000-0000-4000-8000-000000000001";
const NODE_HISTORY_ID = "d0000000-0000-4000-8000-000000000001";

function normalizeDefinition(definition: string): string {
  return definition.replace(/\s+/g, " ").trim();
}

// These are PostgreSQL's canonical forms of every schema constraint. Only
// whitespace is normalized, so changing an operator, column, action, state,
// predicate, or fence scope cannot pass under the same expected definition.
const EXPECTED_CONSTRAINT_DEFINITIONS = {
  agent_sandbox_replacement_attempts_lifecycle_check: normalizeDefinition(`
    CHECK ((lifecycle_revision >= 0::numeric
      AND lifecycle_revision <= '18446744073709551615'::numeric
      AND (lifecycle_job_id IS NULL AND lifecycle_execution_generation IS NULL
        OR lifecycle_job_id IS NOT NULL AND lifecycle_execution_generation IS NOT NULL))
      IS TRUE)
  `),
  agent_sandbox_replacement_attempts_locator_shape_check: normalizeDefinition(`
    CHECK ((num_nonnulls(locator_sandbox_id, locator_node_id, locator_container_name,
      locator_node_record_id, locator_node_incarnation, locator_node_history_id,
      locator_node_hostname, locator_node_ssh_port,
      locator_node_ssh_user, locator_node_host_key_fingerprint,
      locator_secret_cleanup_version, locator_allocation_counted, locator_vpn_node_name,
      locator_vpn_registration_started_at, locator_previous_vpn_node_id,
      locator_recorded_at, locator_container_id, locator_container_recorded_at,
      locator_vpn_node_id, locator_vpn_recorded_at) = 0
      OR locator_sandbox_id IS NOT NULL
      AND locator_node_id IS NOT NULL
      AND locator_container_name IS NOT NULL
      AND locator_node_record_id IS NOT NULL
      AND locator_node_incarnation IS NOT NULL
      AND locator_node_history_id IS NOT NULL
      AND locator_node_hostname IS NOT NULL
      AND locator_node_ssh_port IS NOT NULL
      AND locator_node_ssh_user IS NOT NULL
      AND locator_node_host_key_fingerprint IS NOT NULL
      AND locator_secret_cleanup_version = 1
      AND locator_allocation_counted = true
      AND locator_recorded_at IS NOT NULL
      AND locator_sandbox_id = locator_container_name
      AND (num_nonnulls(restore_lease_id, restore_backup_id, restore_attempt_id,
          restore_lease_owner_id, restore_lease_generation, restore_catalog_epoch,
          restore_copy_role, restore_operation_id, restore_source_activation_generation,
          restore_source_lifecycle_revision, restore_manifest_sha256,
          restore_lease_expires_at) = 0
        AND locator_container_name = ('agent-'::text || agent_id::text)
        OR num_nonnulls(restore_lease_id, restore_backup_id, restore_attempt_id,
          restore_lease_owner_id, restore_lease_generation, restore_catalog_epoch,
          restore_copy_role, restore_operation_id, restore_source_activation_generation,
          restore_source_lifecycle_revision, restore_manifest_sha256,
          restore_lease_expires_at) = 12
        AND locator_container_name = ((('agent-restore-'::text || agent_id::text) || '-'::text)
          || restore_attempt_id::text))
      AND btrim(locator_node_id) <> ''::text
      AND octet_length(locator_node_id) <= 255
      AND btrim(locator_node_hostname) <> ''::text
      AND octet_length(locator_node_hostname) <= 255
      AND locator_node_ssh_port >= 1
      AND locator_node_ssh_port <= 65535
      AND btrim(locator_node_ssh_user) <> ''::text
      AND octet_length(locator_node_ssh_user) <= 255
      AND btrim(locator_node_host_key_fingerprint) <> ''::text
      AND octet_length(locator_node_host_key_fingerprint) <= 1024
      AND locator_recorded_at >= created_at
      AND (locator_container_id IS NULL) = (locator_container_recorded_at IS NULL)
      AND (locator_container_id IS NULL
        OR locator_container_id ~ '^[0-9a-f]{12,64}$'::text
          AND locator_container_recorded_at >= locator_recorded_at)
      AND (locator_vpn_node_name IS NULL) = (locator_vpn_registration_started_at IS NULL)
      AND (locator_vpn_node_name IS NULL
        OR btrim(locator_vpn_node_name) <> ''::text
          AND octet_length(locator_vpn_node_name) <= 255)
      AND (locator_previous_vpn_node_id IS NULL
        OR locator_vpn_node_name IS NOT NULL
          AND CASE
            WHEN locator_previous_vpn_node_id ~ '^[1-9][0-9]{0,19}$'::text
              THEN locator_previous_vpn_node_id::numeric <= '18446744073709551615'::numeric
            ELSE false
          END)
      AND (locator_vpn_node_id IS NULL) = (locator_vpn_recorded_at IS NULL)
      AND (locator_vpn_node_id IS NULL
        OR locator_container_id IS NOT NULL
          AND locator_vpn_node_name IS NOT NULL
          AND locator_vpn_node_id IS DISTINCT FROM locator_previous_vpn_node_id
          AND locator_vpn_recorded_at >= locator_container_recorded_at
          AND CASE
            WHEN locator_vpn_node_id ~ '^[1-9][0-9]{0,19}$'::text
              THEN locator_vpn_node_id::numeric <= '18446744073709551615'::numeric
            ELSE false
          END)) IS TRUE)
  `),
  agent_sandbox_replacement_attempts_operation_kind_check: normalizeDefinition(`
    CHECK (operation_kind = ANY (ARRAY['provision'::text, 'upgrade'::text, 'downgrade'::text]))
  `),
  agent_sandbox_replacement_attempts_organization_id_fkey: normalizeDefinition(`
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
  `),
  agent_sandbox_replacement_attempts_node_occurrence_fkey: normalizeDefinition(`
    FOREIGN KEY (locator_node_history_id, locator_node_record_id, locator_node_incarnation)
    REFERENCES agent_node_incarnation_histories(id, docker_node_record_id, node_incarnation)
    ON DELETE RESTRICT
  `),
  agent_sandbox_replacement_attempts_pkey: "PRIMARY KEY (id)",
  agent_sandbox_replacement_attempts_provider_start_shape_check: normalizeDefinition(`
    CHECK (((restore_attempt_id IS NULL AND provider_started_at IS NULL
      OR restore_attempt_id IS NOT NULL
        AND (provider_started_at IS NULL OR locator_recorded_at IS NOT NULL
          AND provider_started_at >= locator_recorded_at))
      AND (restore_attempt_id IS NULL OR locator_container_id IS NULL
        OR provider_started_at IS NOT NULL)
      AND (restore_attempt_id IS NULL OR provider_succeeded_at IS NULL
        OR provider_started_at IS NOT NULL)
      AND (provider_started_at IS NULL OR provider_succeeded_at IS NULL
        OR provider_succeeded_at >= provider_started_at)
      AND (provider_started_at IS NULL OR cleanup_proven_at IS NULL
        OR cleanup_proven_at >= provider_started_at)) IS TRUE)
  `),
  agent_sandbox_replacement_attempts_restore_lease_fkey: normalizeDefinition(`
    FOREIGN KEY (restore_lease_id, organization_id, agent_id, restore_backup_id,
      restore_attempt_id, restore_lease_owner_id, restore_lease_generation,
      restore_catalog_epoch, restore_copy_role, restore_operation_id,
      restore_source_activation_generation, restore_source_lifecycle_revision,
      restore_manifest_sha256)
    REFERENCES agent_backup_restore_leases(id, organization_id, agent_id, backup_id,
      restore_attempt_id, owner_id, generation, catalog_epoch, copy_role, operation_id,
      activation_generation, lifecycle_revision, expected_manifest_sha256)
    ON DELETE RESTRICT
  `),
  agent_sandbox_replacement_attempts_restore_shape_check: normalizeDefinition(`
    CHECK ((num_nonnulls(restore_lease_id, restore_backup_id, restore_attempt_id,
      restore_lease_owner_id, restore_lease_generation, restore_catalog_epoch,
      restore_copy_role, restore_operation_id, restore_source_activation_generation,
      restore_source_lifecycle_revision, restore_manifest_sha256,
      restore_lease_expires_at) = 0
      OR num_nonnulls(restore_lease_id, restore_backup_id, restore_attempt_id,
        restore_lease_owner_id, restore_lease_generation, restore_catalog_epoch,
        restore_copy_role, restore_operation_id, restore_source_activation_generation,
        restore_source_lifecycle_revision, restore_manifest_sha256,
        restore_lease_expires_at) = 12
      AND btrim(restore_lease_owner_id) = restore_lease_owner_id
      AND octet_length(restore_lease_owner_id) >= 1
      AND octet_length(restore_lease_owner_id) <= 255
      AND restore_catalog_epoch >= 0
      AND (restore_copy_role = ANY (ARRAY['primary'::text, 'secondary'::text]))
      AND restore_source_lifecycle_revision >= 0::numeric
      AND restore_source_lifecycle_revision <= '18446744073709551615'::numeric
      AND restore_manifest_sha256 ~ '^[0-9a-f]{64}$'::text
      AND operation_kind = 'provision'::text
      AND activation_generation = restore_attempt_id
      AND restore_lease_expires_at > created_at) IS TRUE)
  `),
  agent_sandbox_replacement_attempts_seed_authority_unique: normalizeDefinition(`
    UNIQUE (id, organization_id, agent_id, restore_attempt_id)
  `),
  agent_sandbox_replacement_attempts_settlement_shape_check: normalizeDefinition(`
    CHECK ((state = 'in_flight_unresolved'::text
      AND num_nonnulls(provider_succeeded_at, provider_receipt_digest,
        lifecycle_committed_at, lifecycle_receipt_digest, cleanup_proven_at,
        cleanup_receipt_digest) = 0
      OR state = 'provider_succeeded'::text
      AND locator_recorded_at IS NOT NULL
      AND locator_container_id IS NOT NULL
      AND provider_succeeded_at IS NOT NULL
      AND provider_succeeded_at >= locator_container_recorded_at
      AND (locator_vpn_node_name IS NULL OR locator_vpn_node_id IS NOT NULL)
      AND (locator_vpn_recorded_at IS NULL
        OR provider_succeeded_at >= locator_vpn_recorded_at)
      AND provider_receipt_digest ~ '^[0-9a-f]{64}$'::text
      AND num_nonnulls(lifecycle_committed_at, lifecycle_receipt_digest,
        cleanup_proven_at, cleanup_receipt_digest) = 0
      OR state = 'lifecycle_committed'::text
      AND provider_succeeded_at IS NOT NULL
      AND provider_receipt_digest ~ '^[0-9a-f]{64}$'::text
      AND lifecycle_committed_at IS NOT NULL
      AND lifecycle_committed_at >= provider_succeeded_at
      AND lifecycle_receipt_digest ~ '^[0-9a-f]{64}$'::text
      AND cleanup_proven_at IS NULL
      AND cleanup_receipt_digest IS NULL
      OR state = 'cleanup_in_progress'::text
      AND restore_attempt_id IS NOT NULL
      AND locator_recorded_at IS NOT NULL
      AND (provider_succeeded_at IS NULL) = (provider_receipt_digest IS NULL)
      AND (provider_succeeded_at IS NULL
        OR locator_container_id IS NOT NULL
          AND provider_succeeded_at >= locator_container_recorded_at
          AND provider_receipt_digest ~ '^[0-9a-f]{64}$'::text)
      AND lifecycle_committed_at IS NULL
      AND lifecycle_receipt_digest IS NULL
      AND cleanup_proven_at IS NULL
      AND cleanup_receipt_digest IS NULL
      OR state = 'cleanup_proven'::text
      AND (provider_succeeded_at IS NULL) = (provider_receipt_digest IS NULL)
      AND (provider_receipt_digest IS NULL
        OR provider_receipt_digest ~ '^[0-9a-f]{64}$'::text)
      AND cleanup_proven_at IS NOT NULL
      AND cleanup_proven_at >= COALESCE(locator_vpn_recorded_at,
        locator_container_recorded_at, locator_recorded_at, created_at)
      AND (provider_succeeded_at IS NULL
        OR cleanup_proven_at >= provider_succeeded_at)
      AND cleanup_receipt_digest ~ '^[0-9a-f]{64}$'::text
      AND lifecycle_committed_at IS NULL
      AND lifecycle_receipt_digest IS NULL) IS TRUE)
  `),
} satisfies Record<string, string>;

const EXPECTED_INDEX_DEFINITIONS = {
  agent_sandbox_replacement_attempts_organization_idx: normalizeDefinition(`
    CREATE INDEX agent_sandbox_replacement_attempts_organization_idx
    ON agent_sandbox_replacement_attempts USING btree (organization_id)
  `),
  agent_sandbox_replacement_attempts_active_agent_uidx: normalizeDefinition(`
    CREATE UNIQUE INDEX agent_sandbox_replacement_attempts_active_agent_uidx
    ON agent_sandbox_replacement_attempts USING btree (organization_id, agent_id)
    WHERE state = ANY (ARRAY['in_flight_unresolved'::text, 'provider_succeeded'::text,
      'cleanup_in_progress'::text])
  `),
  agent_sandbox_replacement_attempts_active_generation_uidx: normalizeDefinition(`
    CREATE UNIQUE INDEX agent_sandbox_replacement_attempts_active_generation_uidx
    ON agent_sandbox_replacement_attempts USING btree
      (organization_id, agent_id, activation_generation)
    WHERE state = ANY (ARRAY['in_flight_unresolved'::text, 'provider_succeeded'::text,
      'lifecycle_committed'::text, 'cleanup_in_progress'::text])
  `),
  agent_sandbox_replacement_attempts_pkey: normalizeDefinition(`
    CREATE UNIQUE INDEX agent_sandbox_replacement_attempts_pkey
    ON agent_sandbox_replacement_attempts USING btree (id)
  `),
  agent_sandbox_replacement_attempts_seed_authority_unique: normalizeDefinition(`
    CREATE UNIQUE INDEX agent_sandbox_replacement_attempts_seed_authority_unique
    ON agent_sandbox_replacement_attempts USING btree
      (id, organization_id, agent_id, restore_attempt_id)
  `),
} satisfies Record<string, string>;

async function apply(source: string, db: PGlite): Promise<void> {
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.exec(statement);
  }
}

async function database(migrationCount: number = migrationUrls.length): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE agent_node_incarnation_histories (
      id uuid PRIMARY KEY,
      docker_node_record_id uuid NOT NULL,
      node_incarnation uuid NOT NULL,
      CONSTRAINT agent_node_incarnation_histories_receipt_authority_unique
        UNIQUE (id, docker_node_record_id, node_incarnation)
    );
    CREATE TABLE agent_backup_restore_leases (
      id uuid NOT NULL,
      organization_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      backup_id uuid NOT NULL,
      restore_attempt_id uuid NOT NULL,
      owner_id text NOT NULL,
      generation uuid NOT NULL,
      catalog_epoch bigint NOT NULL,
      copy_role text NOT NULL,
      operation_id uuid NOT NULL,
      activation_generation uuid NOT NULL,
      lifecycle_revision numeric(20, 0) NOT NULL,
      expected_manifest_sha256 text NOT NULL,
      CONSTRAINT agent_backup_restore_leases_operation_authority_unique UNIQUE (
        id, organization_id, agent_id, backup_id, restore_attempt_id, owner_id,
        generation, catalog_epoch, copy_role, operation_id,
        activation_generation, lifecycle_revision, expected_manifest_sha256
      )
    );
    CREATE TABLE agent_vault_key_seed_receipts (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      restore_attempt_id uuid NOT NULL,
      backup_id uuid,
      operation_id uuid,
      source_activation_generation uuid,
      source_lifecycle_revision numeric(20, 0),
      manifest_sha256 text,
      target_activation_generation uuid,
      receipt_digest text,
      docker_node_record_id uuid,
      node_incarnation uuid,
      node_history_id uuid,
      CONSTRAINT agent_vault_key_seed_receipts_attempt_unique
        UNIQUE (organization_id, restore_attempt_id),
      CONSTRAINT agent_vault_key_seed_receipts_receipt_authority_unique UNIQUE (
        id, organization_id, agent_id, restore_attempt_id, backup_id, operation_id,
        source_activation_generation, source_lifecycle_revision, manifest_sha256,
        target_activation_generation, receipt_digest
      )
    );
    CREATE TABLE agent_activation_publications (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      activation_generation uuid NOT NULL,
      purpose text NOT NULL,
      backup_id uuid,
      backup_manifest_sha256 text,
      activation_receipt_sha256 text NOT NULL,
      container_id text NOT NULL,
      node_id text NOT NULL,
      node_history_id uuid NOT NULL,
      docker_node_record_id uuid NOT NULL,
      node_incarnation uuid NOT NULL
    );
    CREATE TABLE agent_backup_restore_receipts (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      restore_attempt_id uuid NOT NULL,
      backup_id uuid NOT NULL,
      operation_id uuid NOT NULL,
      source_activation_generation uuid NOT NULL,
      source_lifecycle_revision numeric(20, 0) NOT NULL,
      manifest_sha256 text NOT NULL,
      seed_receipt_id uuid NOT NULL,
      seed_receipt_digest text NOT NULL,
      target_activation_generation uuid NOT NULL,
      activation_purpose text NOT NULL,
      activation_publication_id uuid NOT NULL,
      activation_receipt_sha256 text NOT NULL
    );
    INSERT INTO organizations (id) VALUES ('${ORGANIZATION_ID}');
    INSERT INTO agent_node_incarnation_histories
      (id, docker_node_record_id, node_incarnation)
    VALUES ('${NODE_HISTORY_ID}', '${NODE_RECORD_ID}', '${NODE_INCARNATION}');
    INSERT INTO agent_backup_restore_leases VALUES (
      '${RESTORE_LEASE_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${BACKUP_ID}',
      '${RESTORE_ATTEMPT_ID}', 'restore-worker', '${RESTORE_GENERATION}', 3,
      'primary', '${RESTORE_OPERATION_ID}', '${RESTORE_SOURCE_GENERATION}', 6,
      '${DIGEST}'
    );
  `);
  for (const migrationUrl of migrationUrls.slice(0, migrationCount)) {
    await apply(await Bun.file(migrationUrl).text(), db);
  }
  return db;
}

async function insertAttempt(
  db: PGlite,
  input: {
    id?: string;
    agentId?: string;
    activationGeneration?: string;
  } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO agent_sandbox_replacement_attempts
       (id, organization_id, agent_id, operation_kind, lifecycle_revision,
        activation_generation)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'upgrade', 7, $4::uuid)`,
    [
      input.id ?? ATTEMPT_ID,
      ORGANIZATION_ID,
      input.agentId ?? AGENT_ID,
      input.activationGeneration ?? ACTIVATION_GENERATION,
    ],
  );
}

async function insertRestoreAttempt(db: PGlite, attemptId = ATTEMPT_ID): Promise<void> {
  await db.query(
    `INSERT INTO agent_sandbox_replacement_attempts (
       id, organization_id, agent_id, operation_kind, lifecycle_revision,
       activation_generation, restore_lease_id, restore_backup_id,
       restore_attempt_id, restore_lease_owner_id, restore_lease_generation,
       restore_catalog_epoch, restore_copy_role, restore_operation_id,
       restore_source_activation_generation, restore_source_lifecycle_revision,
       restore_manifest_sha256, restore_lease_expires_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'provision', 7, $4::uuid, $5::uuid,
       $6::uuid, $7::uuid, 'restore-worker', $8::uuid, 3, 'primary', $9::uuid,
       $10::uuid, 6, $11, clock_timestamp() + interval '1 hour'
     )`,
    [
      attemptId,
      ORGANIZATION_ID,
      AGENT_ID,
      RESTORE_ATTEMPT_ID,
      RESTORE_LEASE_ID,
      BACKUP_ID,
      RESTORE_ATTEMPT_ID,
      RESTORE_GENERATION,
      RESTORE_OPERATION_ID,
      RESTORE_SOURCE_GENERATION,
      DIGEST,
    ],
  );
}

async function recordIntentLocator(
  db: PGlite,
  containerName: string,
  attemptId: string = ATTEMPT_ID,
): Promise<void> {
  await db.query(
    `UPDATE agent_sandbox_replacement_attempts SET
       locator_sandbox_id = $1, locator_node_id = 'node-1',
       locator_container_name = $1, locator_node_record_id = $2::uuid,
       locator_node_incarnation = $3::uuid, locator_node_history_id = $4::uuid,
       locator_node_hostname = 'node-1.internal', locator_node_ssh_port = 22,
       locator_node_ssh_user = 'root', locator_node_host_key_fingerprint = 'SHA256:test',
       locator_secret_cleanup_version = 1, locator_allocation_counted = TRUE,
       locator_recorded_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE id = $5::uuid`,
    [containerName, NODE_RECORD_ID, NODE_INCARNATION, NODE_HISTORY_ID, attemptId],
  );
}

async function recordProviderSuccess(db: PGlite, attemptId: string = ATTEMPT_ID): Promise<void> {
  await recordIntentLocator(db, `agent-${AGENT_ID}`, attemptId);
  await db.query(
    `UPDATE agent_sandbox_replacement_attempts SET
       locator_container_id = $1, locator_container_recorded_at = clock_timestamp(),
       updated_at = clock_timestamp()
     WHERE id = $2::uuid`,
    [DIGEST, attemptId],
  );
  await db.query(
    `UPDATE agent_sandbox_replacement_attempts SET
       state = 'provider_succeeded', provider_succeeded_at = clock_timestamp(),
       provider_receipt_digest = $1, updated_at = clock_timestamp()
     WHERE id = $2::uuid`,
    [DIGEST, attemptId],
  );
}

async function commitLifecycle(db: PGlite, attemptId: string = ATTEMPT_ID): Promise<void> {
  await db.query(
    `UPDATE agent_sandbox_replacement_attempts SET
       state = 'lifecycle_committed', lifecycle_committed_at = clock_timestamp(),
       lifecycle_receipt_digest = $1, updated_at = clock_timestamp()
     WHERE id = $2::uuid`,
    [LIFECYCLE_DIGEST, attemptId],
  );
}

async function transitionAttempt(
  db: PGlite,
  state: "in_flight_unresolved" | "provider_succeeded" | "lifecycle_committed" | "cleanup_proven",
): Promise<void> {
  if (state === "in_flight_unresolved") return;
  if (state === "cleanup_proven") {
    await db.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET state = 'cleanup_proven', cleanup_proven_at = clock_timestamp(),
         cleanup_receipt_digest = $1, updated_at = clock_timestamp()
       WHERE id = $2::uuid`,
      [DIGEST, ATTEMPT_ID],
    );
    return;
  }
  await recordProviderSuccess(db);
  if (state === "lifecycle_committed") await commitLifecycle(db);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0321-0328 and 0370-0371 agent sandbox replacement attempts", () => {
  test("occupies one ordered journal range and matches the merged schema surface", async () => {
    const journal = (await Bun.file(journalUrl).json()) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 354,
      tag: "0371_agent_vault_key_seed_receipts_per_replacement",
    });
    const expectedTags = migrationUrls.map(migrationTag);
    const initialRangeTags = expectedTags.slice(0, 8);
    const rangeStart = journal.entries.findIndex(({ tag }) => tag === initialRangeTags[0]);
    expect(rangeStart).toBeGreaterThanOrEqual(0);
    const range = journal.entries.slice(rangeStart, rangeStart + initialRangeTags.length);
    expect(range.map(({ idx }) => idx)).toEqual(
      Array.from({ length: initialRangeTags.length }, (_, offset) => 304 + offset),
    );
    expect(range.map(({ tag }) => tag)).toEqual(initialRangeTags);
    const matchingEntries = journal.entries.filter(({ tag }) => expectedTags.includes(tag));
    expect(matchingEntries.map(({ tag }) => tag)).toEqual(expectedTags);
    expect(matchingEntries).toHaveLength(expectedTags.length);

    const db = await database();
    const schema = getTableConfig(agentSandboxReplacementAttempts);
    expect(
      schema.foreignKeys.find((foreignKey) =>
        foreignKey.getName().includes("organization_id_organizations_id"),
      )?.onDelete,
    ).toBe("cascade");
    const columns = await db.query<{
      column_name: string;
      has_default: boolean;
      is_not_null: boolean;
      sql_type: string;
    }>(`
      SELECT
        attribute.attname AS column_name,
        format_type(attribute.atttypid, attribute.atttypmod) AS sql_type,
        attribute.attnotnull AS is_not_null,
        definition.adbin IS NOT NULL AS has_default
      FROM pg_attribute AS attribute
      JOIN pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_attrdef AS definition
        ON definition.adrelid = attribute.attrelid
        AND definition.adnum = attribute.attnum
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'agent_sandbox_replacement_attempts'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    `);
    expect(
      columns.rows.map(({ column_name, has_default, is_not_null, sql_type }) => ({
        columnName: column_name,
        hasDefault: has_default,
        isNotNull: is_not_null,
        sqlType: sql_type.replace(/,\s*/g, ","),
      })),
    ).toEqual(
      schema.columns.map((column) => ({
        columnName: column.name,
        hasDefault: column.hasDefault,
        isNotNull: column.notNull,
        sqlType: column.getSQLType().replace(/,\s*/g, ","),
      })),
    );

    const constraints = await db.query<{ conname: string; definition: string }>(`
      SELECT conname, pg_get_constraintdef(oid, true) AS definition FROM pg_constraint
      WHERE conrelid = 'agent_sandbox_replacement_attempts'::regclass
      ORDER BY conname
    `);
    expect(constraints.rows).toHaveLength(Object.keys(EXPECTED_CONSTRAINT_DEFINITIONS).length);
    expect(
      Object.fromEntries(
        constraints.rows.map(({ conname, definition }) => [
          conname,
          normalizeDefinition(definition),
        ]),
      ),
    ).toEqual(EXPECTED_CONSTRAINT_DEFINITIONS);

    const schemaConstraintNames = [
      ...schema.checks.map(({ name }) => name),
      ...schema.uniqueConstraints.map(({ name }) => name),
      "agent_sandbox_replacement_attempts_node_occurrence_fkey",
      "agent_sandbox_replacement_attempts_restore_lease_fkey",
    ];
    expect(Object.keys(EXPECTED_CONSTRAINT_DEFINITIONS)).toEqual(
      expect.arrayContaining(schemaConstraintNames),
    );

    const indexes = await db.query<{ indexdef: string; indexname: string }>(`
      SELECT
        index_relation.relname AS indexname,
        pg_get_indexdef(indexes.indexrelid, 0, true) AS indexdef
      FROM pg_index AS indexes
      JOIN pg_class AS table_relation ON table_relation.oid = indexes.indrelid
      JOIN pg_class AS index_relation ON index_relation.oid = indexes.indexrelid
      WHERE table_relation.oid = 'agent_sandbox_replacement_attempts'::regclass
      ORDER BY index_relation.relname
    `);
    expect(indexes.rows).toHaveLength(Object.keys(EXPECTED_INDEX_DEFINITIONS).length);
    expect(
      Object.fromEntries(
        indexes.rows.map(({ indexdef, indexname }) => [indexname, normalizeDefinition(indexdef)]),
      ),
    ).toEqual(EXPECTED_INDEX_DEFINITIONS);
    expect(Object.keys(EXPECTED_INDEX_DEFINITIONS)).toEqual(
      expect.arrayContaining(schema.indexes.map(({ config }) => config.name)),
    );

    const triggers = await db.query<{ tgname: string }>(`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'agent_sandbox_replacement_attempts'::regclass
        AND NOT tgisinternal
      ORDER BY tgname
    `);
    expect(triggers.rows.map(({ tgname }) => tgname)).toEqual([
      "agent_sandbox_replacement_attempts_guard_delete",
      "agent_sandbox_replacement_attempts_guard_identity",
      "agent_sandbox_replacement_attempts_guard_insert",
      "agent_sandbox_replacement_attempts_guard_locator",
      "agent_sandbox_replacement_attempts_guard_provider_start",
      "agent_sandbox_replacement_attempts_guard_state",
      "agent_sandbox_replacement_attempts_guard_truncate",
    ]);
  });

  test("uses the owner index for a selective cascade lookup across retained history", async () => {
    const db = await database(4);
    const otherOrganizationId = "10000000-0000-4000-8000-000000000002";
    await db.query("INSERT INTO organizations (id) VALUES ($1::uuid)", [otherOrganizationId]);
    await db.query(
      `INSERT INTO agent_sandbox_replacement_attempts (
         id, organization_id, agent_id, operation_kind, lifecycle_revision,
         activation_generation, state, cleanup_proven_at, cleanup_receipt_digest
       )
       SELECT
         ('30000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
         CASE WHEN series <= 50 THEN $1::uuid ELSE $2::uuid END,
         ('20000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
         'upgrade', 7,
         ('40000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
         'cleanup_proven', clock_timestamp(), repeat('a', 64)
       FROM generate_series(1, 6000) AS series`,
      [ORGANIZATION_ID, otherOrganizationId],
    );
    await db.exec("ANALYZE agent_sandbox_replacement_attempts");

    const explained = await db.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (FORMAT JSON)
       DELETE FROM agent_sandbox_replacement_attempts
       WHERE organization_id = $1::uuid`,
      [ORGANIZATION_ID],
    );
    expect(JSON.stringify(explained.rows)).toContain(
      "agent_sandbox_replacement_attempts_organization_idx",
    );
  });

  test("keeps unresolved effects globally fenced until exact cleanup", async () => {
    const db = await database();
    await insertAttempt(db);
    await expect(
      insertAttempt(db, {
        id: OTHER_ATTEMPT_ID,
        activationGeneration: OTHER_ACTIVATION_GENERATION,
      }),
    ).rejects.toThrow(/active_agent_uidx/);

    await db.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET state = 'cleanup_proven', cleanup_proven_at = clock_timestamp(),
         cleanup_receipt_digest = $1, updated_at = clock_timestamp()
       WHERE id = $2::uuid`,
      [DIGEST, ATTEMPT_ID],
    );
    await insertAttempt(db, {
      id: OTHER_ATTEMPT_ID,
      activationGeneration: OTHER_ACTIVATION_GENERATION,
    });
    const rows = await db.query<{ state: string }>(
      "SELECT state FROM agent_sandbox_replacement_attempts ORDER BY created_at, id",
    );
    expect(rows.rows.map(({ state }) => state)).toEqual(["cleanup_proven", "in_flight_unresolved"]);
  });

  test("separates the provider-global fence from the committed generation fence", async () => {
    const db = await database();
    await insertAttempt(db);
    await recordProviderSuccess(db);

    // Provider success is globally ambiguous for this tenant+agent, even on a
    // different activation generation.
    await expect(
      insertAttempt(db, {
        id: OTHER_ATTEMPT_ID,
        activationGeneration: OTHER_ACTIVATION_GENERATION,
      }),
    ).rejects.toThrow(/active_agent_uidx/);

    // The same generation is not globally reserved: another agent has an
    // independent authority key and must not be rejected as a false positive.
    await insertAttempt(db, {
      id: THIRD_ATTEMPT_ID,
      agentId: OTHER_AGENT_ID,
      activationGeneration: ACTIVATION_GENERATION,
    });

    await commitLifecycle(db);

    // Lifecycle commitment releases the agent-wide fence but permanently
    // retains the exact committed generation fence for this tenant+agent.
    await expect(
      insertAttempt(db, {
        id: OTHER_ATTEMPT_ID,
        activationGeneration: ACTIVATION_GENERATION,
      }),
    ).rejects.toThrow(/active_generation_uidx/);
    await insertAttempt(db, {
      id: OTHER_ATTEMPT_ID,
      activationGeneration: OTHER_ACTIVATION_GENERATION,
    });

    const rows = await db.query<{
      activation_generation: string;
      agent_id: string;
      state: string;
    }>(`
      SELECT activation_generation::text, agent_id::text, state
      FROM agent_sandbox_replacement_attempts
      ORDER BY id
    `);
    expect(rows.rows).toEqual([
      {
        activation_generation: ACTIVATION_GENERATION,
        agent_id: AGENT_ID,
        state: "lifecycle_committed",
      },
      {
        activation_generation: OTHER_ACTIVATION_GENERATION,
        agent_id: AGENT_ID,
        state: "in_flight_unresolved",
      },
      {
        activation_generation: ACTIVATION_GENERATION,
        agent_id: OTHER_AGENT_ID,
        state: "in_flight_unresolved",
      },
    ]);
  });

  test("enforces immutable start, terminal history, and append-only storage", async () => {
    const db = await database();
    await expect(
      db.query(
        `INSERT INTO agent_sandbox_replacement_attempts
           (id, organization_id, agent_id, operation_kind, lifecycle_revision,
            activation_generation, locator_sandbox_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'upgrade', 7, $4::uuid, 'forged')`,
        [ATTEMPT_ID, ORGANIZATION_ID, AGENT_ID, ACTIVATION_GENERATION],
      ),
    ).rejects.toThrow(/must start before any provider evidence/);

    await insertAttempt(db);
    await expect(
      db.query(
        `UPDATE agent_sandbox_replacement_attempts SET agent_id = $1::uuid
         WHERE id = $2::uuid`,
        [OTHER_AGENT_ID, ATTEMPT_ID],
      ),
    ).rejects.toThrow(/identity is immutable/);
    await db.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET state = 'cleanup_proven', cleanup_proven_at = clock_timestamp(),
         cleanup_receipt_digest = $1, updated_at = clock_timestamp()
       WHERE id = $2::uuid`,
      [DIGEST, ATTEMPT_ID],
    );
    await expect(
      db.query("DELETE FROM agent_sandbox_replacement_attempts WHERE id = $1::uuid", [ATTEMPT_ID]),
    ).rejects.toThrow(/cannot be deleted before terminal owner erasure/);
    await expect(
      db.exec("TRUNCATE TABLE agent_sandbox_replacement_attempts CASCADE"),
    ).rejects.toThrow(/cannot be truncated/);
    await expect(
      db.query(
        `UPDATE agent_sandbox_replacement_attempts
         SET updated_at = clock_timestamp() WHERE id = $1::uuid`,
        [ATTEMPT_ID],
      ),
    ).rejects.toThrow(/terminal replacement attempt is immutable/);
  });

  for (const state of ["in_flight_unresolved", "provider_succeeded"] as const) {
    test(`rolls back owner erasure while the replacement effect is ${state}`, async () => {
      const db = await database();
      await insertAttempt(db);
      await transitionAttempt(db, state);

      await expect(
        db.query("DELETE FROM organizations WHERE id = $1::uuid", [ORGANIZATION_ID]),
      ).rejects.toThrow(/cannot be deleted before terminal owner erasure/);
      expect(
        (await db.query("SELECT id FROM organizations WHERE id = $1::uuid", [ORGANIZATION_ID]))
          .rows,
      ).toHaveLength(1);
      expect(
        (
          await db.query(
            "SELECT id FROM agent_sandbox_replacement_attempts WHERE organization_id = $1::uuid",
            [ORGANIZATION_ID],
          )
        ).rows,
      ).toHaveLength(1);
    });
  }

  for (const state of ["lifecycle_committed", "cleanup_proven"] as const) {
    test(`permits owner erasure after the replacement effect is ${state}`, async () => {
      const db = await database();
      await insertAttempt(db);
      await transitionAttempt(db, state);
      await db.query("DELETE FROM organizations WHERE id = $1::uuid", [ORGANIZATION_ID]);

      expect(
        (await db.query("SELECT id FROM organizations WHERE id = $1::uuid", [ORGANIZATION_ID]))
          .rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            "SELECT id FROM agent_sandbox_replacement_attempts WHERE organization_id = $1::uuid",
            [ORGANIZATION_ID],
          )
        ).rows,
      ).toHaveLength(0);
    });
  }

  test("admits only the authority-scoped deterministic legacy and exact-restore names", async () => {
    const legacy = await database();
    await insertAttempt(legacy);
    await recordIntentLocator(legacy, `agent-${AGENT_ID}`);

    const restore = await database();
    await insertRestoreAttempt(restore);
    await recordIntentLocator(restore, `agent-restore-${AGENT_ID}-${RESTORE_ATTEMPT_ID}`);

    const restoreUsingLegacyName = await database();
    await insertRestoreAttempt(restoreUsingLegacyName);
    await expect(recordIntentLocator(restoreUsingLegacyName, `agent-${AGENT_ID}`)).rejects.toThrow(
      /locator_shape_check/,
    );

    const legacyUsingRestoreName = await database();
    await insertAttempt(legacyUsingRestoreName);
    await expect(
      recordIntentLocator(
        legacyUsingRestoreName,
        `agent-restore-${AGENT_ID}-${RESTORE_ATTEMPT_ID}`,
      ),
    ).rejects.toThrow(/locator_shape_check/);
  }, 15_000);

  test("retains one immutable provider-start marker before exact-restore Docker enrichment", async () => {
    const restore = await database();
    await insertRestoreAttempt(restore);
    await recordIntentLocator(restore, `agent-restore-${AGENT_ID}-${RESTORE_ATTEMPT_ID}`);
    const started = await restore.query<{ provider_started_at: Date }>(`
      UPDATE agent_sandbox_replacement_attempts
      SET provider_started_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = '${ATTEMPT_ID}'::uuid
      RETURNING provider_started_at
    `);
    expect(started.rows[0]?.provider_started_at).toBeInstanceOf(Date);
    await expect(
      restore.query(`
        UPDATE agent_sandbox_replacement_attempts
        SET provider_started_at = provider_started_at + interval '1 second'
        WHERE id = '${ATTEMPT_ID}'::uuid
      `),
    ).rejects.toThrow(/provider start marker is immutable/);
    await restore.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET locator_container_id = $1, locator_container_recorded_at = clock_timestamp(),
         updated_at = clock_timestamp()
       WHERE id = $2::uuid`,
      [DIGEST, ATTEMPT_ID],
    );
    await restore.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET state = 'provider_succeeded', provider_succeeded_at = clock_timestamp(),
         provider_receipt_digest = $1, updated_at = clock_timestamp()
       WHERE id = $2::uuid`,
      [DIGEST, ATTEMPT_ID],
    );
    await restore.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET state = 'cleanup_in_progress', updated_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [ATTEMPT_ID],
    );
    const cleaned = await restore.query<{
      state: string;
      provider_receipt_digest: string;
      cleanup_receipt_digest: string;
    }>(
      `UPDATE agent_sandbox_replacement_attempts
       SET state = 'cleanup_proven', cleanup_proven_at = clock_timestamp(),
         cleanup_receipt_digest = $1, updated_at = clock_timestamp()
       WHERE id = $2::uuid
       RETURNING state, provider_receipt_digest, cleanup_receipt_digest`,
      [CLEANUP_DIGEST, ATTEMPT_ID],
    );
    expect(cleaned.rows[0]).toEqual({
      state: "cleanup_proven",
      provider_receipt_digest: DIGEST,
      cleanup_receipt_digest: CLEANUP_DIGEST,
    });

    const missingMarker = await database();
    await insertRestoreAttempt(missingMarker);
    await recordIntentLocator(missingMarker, `agent-restore-${AGENT_ID}-${RESTORE_ATTEMPT_ID}`);
    await expect(
      missingMarker.query(
        `UPDATE agent_sandbox_replacement_attempts
         SET locator_container_id = $1, locator_container_recorded_at = clock_timestamp(),
           updated_at = clock_timestamp()
         WHERE id = $2::uuid`,
        [DIGEST, ATTEMPT_ID],
      ),
    ).rejects.toThrow(/provider_start_shape_check/);

    const legacy = await database();
    await insertAttempt(legacy);
    await recordIntentLocator(legacy, `agent-${AGENT_ID}`);
    await expect(
      legacy.query(`
        UPDATE agent_sandbox_replacement_attempts
        SET provider_started_at = clock_timestamp()
        WHERE id = '${ATTEMPT_ID}'::uuid
      `),
    ).rejects.toThrow(/requires unresolved exact restore intent/);
  }, 15_000);

  test("retains legacy seed receipts and admits one new receipt per exact replacement attempt", async () => {
    const db = await database(migrationUrls.length - 1);
    const legacyReceiptId = "e0000000-0000-4000-8000-000000000001";
    const firstReceiptId = "e0000000-0000-4000-8000-000000000002";
    const secondReceiptId = "e0000000-0000-4000-8000-000000000003";
    const publicationId = "e0000000-0000-4000-8000-000000000004";
    const legacyFinalReceiptId = "e0000000-0000-4000-8000-000000000005";
    const exactFinalReceiptId = "e0000000-0000-4000-8000-000000000006";
    await db.query(
      `INSERT INTO agent_vault_key_seed_receipts
         (id, organization_id, agent_id, restore_attempt_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [legacyReceiptId, ORGANIZATION_ID, AGENT_ID, RESTORE_ATTEMPT_ID],
    );
    await db.query(
      `INSERT INTO agent_activation_publications (
         id, organization_id, agent_id, activation_generation, purpose, backup_id,
         backup_manifest_sha256, activation_receipt_sha256, container_id,
         node_id, node_history_id, docker_node_record_id, node_incarnation
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'restore', $5::uuid,
         $6, $7, $8, 'node-1', $9::uuid, $10::uuid, $11::uuid
       )`,
      [
        publicationId,
        ORGANIZATION_ID,
        AGENT_ID,
        RESTORE_ATTEMPT_ID,
        BACKUP_ID,
        DIGEST,
        LIFECYCLE_DIGEST,
        DIGEST,
        NODE_HISTORY_ID,
        NODE_RECORD_ID,
        NODE_INCARNATION,
      ],
    );
    await db.query(
      `INSERT INTO agent_backup_restore_receipts (
         id, organization_id, agent_id, restore_attempt_id, backup_id, operation_id,
         source_activation_generation, source_lifecycle_revision, manifest_sha256,
         seed_receipt_id, seed_receipt_digest, target_activation_generation,
         activation_purpose, activation_publication_id, activation_receipt_sha256
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7::uuid, 6, $8, $9::uuid, $10, $4::uuid, 'restore', $11::uuid, $12
       )`,
      [
        legacyFinalReceiptId,
        ORGANIZATION_ID,
        AGENT_ID,
        RESTORE_ATTEMPT_ID,
        BACKUP_ID,
        RESTORE_OPERATION_ID,
        RESTORE_SOURCE_GENERATION,
        DIGEST,
        legacyReceiptId,
        DIGEST,
        publicationId,
        LIFECYCLE_DIGEST,
      ],
    );
    await apply(await Bun.file(migrationUrls.at(-1)!).text(), db);

    const legacy = await db.query<{ replacement_attempt_id: string | null }>(
      `SELECT replacement_attempt_id::text
       FROM agent_vault_key_seed_receipts WHERE id = $1::uuid`,
      [legacyReceiptId],
    );
    expect(legacy.rows).toEqual([{ replacement_attempt_id: null }]);
    const legacyFinal = await db.query<{ replacement_attempt_id: string | null }>(
      `SELECT replacement_attempt_id::text
       FROM agent_backup_restore_receipts WHERE id = $1::uuid`,
      [legacyFinalReceiptId],
    );
    expect(legacyFinal.rows).toEqual([{ replacement_attempt_id: null }]);

    await insertRestoreAttempt(db);
    await recordIntentLocator(db, `agent-restore-${AGENT_ID}-${RESTORE_ATTEMPT_ID}`);
    await expect(
      db.query(
        `INSERT INTO agent_vault_key_seed_receipts
           (id, organization_id, agent_id, restore_attempt_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        [firstReceiptId, ORGANIZATION_ID, AGENT_ID, RESTORE_ATTEMPT_ID],
      ),
    ).rejects.toThrow(/requires exact replacement attempt authority/);
    await db.query(
      `INSERT INTO agent_vault_key_seed_receipts
         (id, organization_id, agent_id, restore_attempt_id, replacement_attempt_id,
          backup_id, operation_id, source_activation_generation,
          source_lifecycle_revision, manifest_sha256, target_activation_generation,
          receipt_digest, docker_node_record_id, node_incarnation, node_history_id)
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7::uuid, $8::uuid, 6, $9, $4::uuid, $10, $11::uuid, $12::uuid, $13::uuid
       )`,
      [
        firstReceiptId,
        ORGANIZATION_ID,
        AGENT_ID,
        RESTORE_ATTEMPT_ID,
        ATTEMPT_ID,
        BACKUP_ID,
        RESTORE_OPERATION_ID,
        RESTORE_SOURCE_GENERATION,
        DIGEST,
        DIGEST,
        NODE_RECORD_ID,
        NODE_INCARNATION,
        NODE_HISTORY_ID,
      ],
    );
    await expect(
      db.query(
        `INSERT INTO agent_vault_key_seed_receipts
           (id, organization_id, agent_id, restore_attempt_id, replacement_attempt_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
        [secondReceiptId, ORGANIZATION_ID, AGENT_ID, RESTORE_ATTEMPT_ID, ATTEMPT_ID],
      ),
    ).rejects.toThrow(/agent_vault_key_seed_receipts_attempt_unique/);

    await expect(
      db.query(
        `UPDATE agent_sandbox_replacement_attempts
         SET state = 'cleanup_proven', cleanup_proven_at = clock_timestamp(),
           cleanup_receipt_digest = $1, updated_at = clock_timestamp()
         WHERE id = $2::uuid`,
        [DIGEST, ATTEMPT_ID],
      ),
    ).rejects.toThrow(/state transition is not monotonic/);
    await db.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET state = 'cleanup_in_progress', updated_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [ATTEMPT_ID],
    );
    await db.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET state = 'cleanup_proven', cleanup_proven_at = clock_timestamp(),
         cleanup_receipt_digest = $1, updated_at = clock_timestamp()
       WHERE id = $2::uuid`,
      [DIGEST, ATTEMPT_ID],
    );
    await insertRestoreAttempt(db, OTHER_ATTEMPT_ID);
    await recordIntentLocator(
      db,
      `agent-restore-${AGENT_ID}-${RESTORE_ATTEMPT_ID}`,
      OTHER_ATTEMPT_ID,
    );
    await db.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET provider_started_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [OTHER_ATTEMPT_ID],
    );
    await db.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET locator_container_id = $1, locator_container_recorded_at = clock_timestamp(),
         updated_at = clock_timestamp()
       WHERE id = $2::uuid`,
      [DIGEST, OTHER_ATTEMPT_ID],
    );
    await db.query(
      `UPDATE agent_sandbox_replacement_attempts
       SET state = 'provider_succeeded', provider_succeeded_at = clock_timestamp(),
         provider_receipt_digest = $1, updated_at = clock_timestamp()
       WHERE id = $2::uuid`,
      [DIGEST, OTHER_ATTEMPT_ID],
    );
    await db.query(
      `INSERT INTO agent_vault_key_seed_receipts
         (id, organization_id, agent_id, restore_attempt_id, replacement_attempt_id,
          backup_id, operation_id, source_activation_generation,
          source_lifecycle_revision, manifest_sha256, target_activation_generation,
          receipt_digest, docker_node_record_id, node_incarnation, node_history_id)
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7::uuid, $8::uuid, 6, $9, $4::uuid, $10, $11::uuid, $12::uuid, $13::uuid
       )`,
      [
        secondReceiptId,
        ORGANIZATION_ID,
        AGENT_ID,
        RESTORE_ATTEMPT_ID,
        OTHER_ATTEMPT_ID,
        BACKUP_ID,
        RESTORE_OPERATION_ID,
        RESTORE_SOURCE_GENERATION,
        DIGEST,
        DIGEST,
        NODE_RECORD_ID,
        NODE_INCARNATION,
        NODE_HISTORY_ID,
      ],
    );
    const receipts = await db.query<{ replacement_attempt_id: string | null }>(`
      SELECT replacement_attempt_id::text
      FROM agent_vault_key_seed_receipts
      ORDER BY id
    `);
    expect(receipts.rows.map(({ replacement_attempt_id }) => replacement_attempt_id)).toEqual([
      null,
      ATTEMPT_ID,
      OTHER_ATTEMPT_ID,
    ]);

    await db.query("DELETE FROM agent_backup_restore_receipts WHERE id = $1::uuid", [
      legacyFinalReceiptId,
    ]);
    const insertFinalReceipt = (
      replacementAttemptId: string | null,
      seedReceiptId: string,
    ): Promise<unknown> =>
      db.query(
        `INSERT INTO agent_backup_restore_receipts (
           id, organization_id, agent_id, restore_attempt_id, backup_id, operation_id,
           source_activation_generation, source_lifecycle_revision, manifest_sha256,
           seed_receipt_id, seed_receipt_digest, replacement_attempt_id,
           target_activation_generation, activation_purpose, activation_publication_id,
           activation_receipt_sha256
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, 6, $8, $9::uuid, $8, $10::uuid,
           $4::uuid, 'restore', $11::uuid, $12
         )`,
        [
          exactFinalReceiptId,
          ORGANIZATION_ID,
          AGENT_ID,
          RESTORE_ATTEMPT_ID,
          BACKUP_ID,
          RESTORE_OPERATION_ID,
          RESTORE_SOURCE_GENERATION,
          DIGEST,
          seedReceiptId,
          replacementAttemptId,
          publicationId,
          LIFECYCLE_DIGEST,
        ],
      );
    await expect(insertFinalReceipt(null, secondReceiptId)).rejects.toThrow(
      /requires exact replacement attempt authority/,
    );
    await expect(insertFinalReceipt(OTHER_ATTEMPT_ID, secondReceiptId)).rejects.toThrow(
      /requires its exact adopted replacement chain/,
    );
    await commitLifecycle(db, OTHER_ATTEMPT_ID);
    await expect(insertFinalReceipt(ATTEMPT_ID, firstReceiptId)).rejects.toThrow(
      /requires its exact adopted replacement chain/,
    );
    await db.query(
      `UPDATE agent_vault_key_seed_receipts
       SET node_history_id = $1::uuid
       WHERE id = $2::uuid`,
      [OTHER_ACTIVATION_GENERATION, secondReceiptId],
    );
    await expect(insertFinalReceipt(OTHER_ATTEMPT_ID, secondReceiptId)).rejects.toThrow(
      /requires its exact adopted replacement chain/,
    );
    await db.query(
      `UPDATE agent_vault_key_seed_receipts
       SET node_history_id = $1::uuid
       WHERE id = $2::uuid`,
      [NODE_HISTORY_ID, secondReceiptId],
    );
    await insertFinalReceipt(OTHER_ATTEMPT_ID, secondReceiptId);
    const finalReceipt = await db.query<{ replacement_attempt_id: string }>(
      `SELECT replacement_attempt_id::text
       FROM agent_backup_restore_receipts WHERE id = $1::uuid`,
      [exactFinalReceiptId],
    );
    expect(finalReceipt.rows).toEqual([{ replacement_attempt_id: OTHER_ATTEMPT_ID }]);

    const receiptAuthority = await db.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid, true) AS definition
      FROM pg_constraint
      WHERE conrelid = 'agent_vault_key_seed_receipts'::regclass
        AND conname = 'agent_vault_key_seed_receipts_receipt_authority_unique'
    `);
    expect(normalizeDefinition(receiptAuthority.rows[0]?.definition ?? "")).toBe(
      normalizeDefinition(`UNIQUE (id, organization_id, agent_id, restore_attempt_id,
        backup_id, operation_id, source_activation_generation, source_lifecycle_revision,
        manifest_sha256, target_activation_generation, receipt_digest)`),
    );
  }, 15_000);

  test("binds optional restore authority to one exact durable lease tuple", async () => {
    const db = await database();
    const expiresAt = new Date(Date.now() + 60_000);
    const insert = (
      ownerId: string,
      operationKind = "provision",
      activationGeneration = RESTORE_ATTEMPT_ID,
    ): Promise<unknown> =>
      db.query(
        `INSERT INTO agent_sandbox_replacement_attempts (
          id, organization_id, agent_id, operation_kind, lifecycle_revision,
          activation_generation, restore_lease_id, restore_backup_id,
          restore_attempt_id, restore_lease_owner_id, restore_lease_generation,
          restore_catalog_epoch, restore_copy_role, restore_operation_id,
          restore_source_activation_generation, restore_source_lifecycle_revision,
          restore_manifest_sha256, restore_lease_expires_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $14, 7, $4::uuid, $5::uuid,
          $6::uuid, $7::uuid, $8, $9::uuid, 3, 'primary', $10::uuid,
          $11::uuid, 6, $12, $13::timestamptz
        )`,
        [
          ATTEMPT_ID,
          ORGANIZATION_ID,
          AGENT_ID,
          activationGeneration,
          RESTORE_LEASE_ID,
          BACKUP_ID,
          RESTORE_ATTEMPT_ID,
          ownerId,
          RESTORE_GENERATION,
          RESTORE_OPERATION_ID,
          RESTORE_SOURCE_GENERATION,
          DIGEST,
          expiresAt,
          operationKind,
        ],
      );

    await expect(insert("restore-worker", "upgrade")).rejects.toThrow(/restore_shape_check/);
    await expect(insert("restore-worker", "provision", ACTIVATION_GENERATION)).rejects.toThrow(
      /restore_shape_check/,
    );
    await expect(insert("wrong-worker")).rejects.toThrow(/restore_lease_fkey/);
    await insert("restore-worker");
    const rows = await db.query<{ restore_lease_owner_id: string }>(
      "SELECT restore_lease_owner_id FROM agent_sandbox_replacement_attempts",
    );
    expect(rows.rows).toEqual([{ restore_lease_owner_id: "restore-worker" }]);
  });
});

/**
 * Raw PostgreSQL proofs for migration 0314. The database must retain one
 * monotone capacity owner and atomically bind restore handoff to the exact
 * replacement receiver, even when callers bypass both repositories.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import {
  agentBackupCatalogAuthorities,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "./schemas/agent-backup-catalog";
import { agentNodeIncarnationHistories } from "./schemas/agent-node-incarnation-histories";
import { agentSandboxReplacementAttempts } from "./schemas/agent-sandbox-replacement-attempts";
import { agentSandboxBackups, agentSandboxes } from "./schemas/agent-sandboxes";
import { dockerNodes } from "./schemas/docker-nodes";
import { organizations } from "./schemas/organizations";
import { userCharacters } from "./schemas/user-characters";
import { users } from "./schemas/users";

const expandMigrationTags = [
  "0314_agent_restore_capacity_ownership",
  "0315_agent_capacity_node_occurrence_authority",
  "0316_agent_capacity_relationships",
  "0317_agent_restore_capacity_monotonicity",
  "0318_agent_replacement_capacity_monotonicity",
  "0319_agent_restore_capacity_handoff",
  "0320_agent_replacement_capacity_handoff",
  "0321_agent_replacement_cleanup_occurrence",
  "0322_agent_restore_capacity_compatibility",
  "0323_agent_replacement_capacity_compatibility",
  "0324_agent_replacement_cleanup_occurrence_compatibility",
  "0325_agent_replacement_cleanup_occurrence_guard",
  "0326_agent_replacement_cleanup_release_guard",
  "0327_agent_replacement_candidate_cleanup_guard",
] as const;
const contractMigrationTags = [
  "0328_agent_capacity_contract_preflight",
  "0329_agent_restore_capacity_shape",
  "0330_agent_replacement_capacity_shape",
  "0331_agent_replacement_cleanup_occurrence_shape",
  "0332_agent_replacement_previous_placement_guard",
] as const;
const journalTailTags = [...expandMigrationTags, ...contractMigrationTags] as const;
const migrationTags = journalTailTags;
const migrationUrls = migrationTags.map(
  (tag) => new URL(`./migrations/${tag}.sql`, import.meta.url),
);
const expandMigrationUrls = expandMigrationTags.map(
  (tag) => new URL(`./migrations/${tag}.sql`, import.meta.url),
);
const contractMigrationUrls = contractMigrationTags.map(
  (tag) => new URL(`./migrations/${tag}.sql`, import.meta.url),
);
const journalUrl = new URL("./migrations/meta/_journal.json", import.meta.url);
const databases: PGlite[] = [];

setDefaultTimeout(60_000);

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000002";
const SOURCE_ID = "20000000-0000-4000-8000-000000000001";
const RESTORE_ATTEMPT_ID = "30000000-0000-4000-8000-000000000001";
const RECEIVER_ID = "40000000-0000-4000-8000-000000000001";
const SECOND_RECEIVER_ID = "40000000-0000-4000-8000-000000000002";
const NODE_HISTORY_ID = "50000000-0000-4000-8000-000000000001";
const NODE_RECORD_ID = "60000000-0000-4000-8000-000000000001";
const NODE_INCARNATION = "70000000-0000-4000-8000-000000000001";
const NODE_ID = "docker-node-1";
const PREVIOUS_NODE_HISTORY_ID = "50000000-0000-4000-8000-000000000004";
const PREVIOUS_NODE_RECORD_ID = "60000000-0000-4000-8000-000000000004";
const PREVIOUS_NODE_INCARNATION = "70000000-0000-4000-8000-000000000004";
const PREVIOUS_NODE_ID = "old-node";
const ABA_NODE_HISTORY_ID = "50000000-0000-4000-8000-000000000005";
const ABA_NODE_RECORD_ID = "60000000-0000-4000-8000-000000000005";
const ABA_NODE_INCARNATION = "70000000-0000-4000-8000-000000000005";
const AGENT_ID = "80000000-0000-4000-8000-000000000001";
const ACTIVATION_GENERATION = "90000000-0000-4000-8000-000000000001";
const NEXT_ACTIVATION_GENERATION = "90000000-0000-4000-8000-000000000002";
const LIFECYCLE_JOB_ID = "a0000000-0000-4000-8000-000000000001";
const LIFECYCLE_EXECUTION_GENERATION = "b0000000-0000-4000-8000-000000000001";
const ATTEMPT_LIFECYCLE_REVISION = 7;
const LOCATOR_SANDBOX_ID = `agent-${AGENT_ID}`;
const OTHER_NODE_HISTORY_ID = "50000000-0000-4000-8000-000000000002";
const OTHER_NODE_RECORD_ID = "60000000-0000-4000-8000-000000000002";
const OTHER_NODE_INCARNATION = "70000000-0000-4000-8000-000000000002";
const OTHER_NODE_ID = "docker-node-2";
const REUSED_NODE_HISTORY_ID = "50000000-0000-4000-8000-000000000003";
const REUSED_NODE_RECORD_ID = "60000000-0000-4000-8000-000000000003";
const REUSED_NODE_INCARNATION = "70000000-0000-4000-8000-000000000003";
const PREVIOUS_CONTAINER_ID = "c".repeat(64);
const LOCATOR_CONTAINER_ID = "d".repeat(64);
const SECOND_LOCATOR_CONTAINER_ID = "e".repeat(64);
const LOCATOR_VPN_NODE_NAME = "candidate-vpn";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const RECEIPT_DIGEST = "b".repeat(64);
const SOURCE_RESERVED_AT = "2026-08-24T10:00:00.000Z";
const HANDOFF_AT = "2026-08-24T10:01:00.000Z";
const RECEIVER_SETTLED_AT = "2026-08-24T10:02:00.000Z";

async function applyMigration(db: PGlite): Promise<void> {
  await applyMigrationUrls(db, migrationUrls);
}

async function applyMigrationUrls(db: PGlite, urls: URL[]): Promise<void> {
  for (const migrationUrl of urls) {
    const source = await Bun.file(migrationUrl).text();
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.exec(statement);
    }
  }
}

async function prerequisiteDatabase(
  input: { existingLocator?: boolean; existingTarget?: boolean } = {},
): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE agent_node_incarnation_histories (
      id uuid PRIMARY KEY,
      docker_node_record_id uuid NOT NULL,
      node_id text NOT NULL,
      node_incarnation uuid NOT NULL,
      host_key_fingerprint text NOT NULL DEFAULT 'SHA256:test-node-key',
      CONSTRAINT agent_node_incarnation_histories_receipt_authority_unique
        UNIQUE (id, docker_node_record_id, node_incarnation)
    );
    CREATE TABLE agent_activation_publications (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      activation_generation uuid NOT NULL,
      container_id text NOT NULL,
      node_history_id uuid NOT NULL,
      docker_node_record_id uuid NOT NULL,
      node_id text NOT NULL,
      node_incarnation uuid NOT NULL,
      UNIQUE (organization_id, agent_id, activation_generation)
    );
    CREATE TABLE agent_backup_restore_operations (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      restore_attempt_id uuid NOT NULL,
      phase text NOT NULL DEFAULT 'reserved',
      expected_node_history_id uuid,
      expected_node_record_id uuid,
      expected_node_incarnation uuid,
      expected_container_id text,
      expected_image_digest text
    );
    CREATE UNIQUE INDEX agent_backup_restore_operations_attempt_uidx
      ON agent_backup_restore_operations (organization_id, restore_attempt_id);

    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY,
      node_id text NOT NULL UNIQUE,
      hostname text NOT NULL DEFAULT 'node-1.internal',
      ssh_port integer NOT NULL DEFAULT 22,
      ssh_user text NOT NULL DEFAULT 'root',
      host_key_fingerprint text DEFAULT 'SHA256:test-node-key',
      node_incarnation uuid,
      current_node_history_id uuid,
      allocated_count integer NOT NULL DEFAULT 0
    );

    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      sandbox_id text,
      node_id text,
      container_name text,
      status text NOT NULL DEFAULT 'running',
      deletion_attempt_id uuid,
      deletion_allocation_counted boolean,
      activation_generation uuid,
      lifecycle_revision bigint NOT NULL,
      lifecycle_job_id uuid,
      lifecycle_execution_generation uuid,
      replacement_cleanup_sandbox_id text,
      replacement_cleanup_node_id text,
      replacement_cleanup_container_name text,
      replacement_cleanup_attempt_id uuid,
      replacement_cleanup_container_id text,
      replacement_cleanup_vpn_node_id text,
      replacement_cleanup_vpn_node_name text,
      replacement_cleanup_preserved_vpn_node_id text,
      replacement_cleanup_vpn_registration_started_at timestamptz,
      replacement_cleanup_allocation_counted boolean,
      replacement_cleanup_created_at timestamptz
    );

    CREATE TABLE agent_sandbox_replacement_attempts (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      agent_id uuid NOT NULL DEFAULT '${AGENT_ID}',
      operation_kind text NOT NULL DEFAULT 'upgrade',
      lifecycle_revision numeric NOT NULL DEFAULT ${ATTEMPT_LIFECYCLE_REVISION},
      activation_generation uuid NOT NULL DEFAULT '${ACTIVATION_GENERATION}',
      lifecycle_job_id uuid DEFAULT '${LIFECYCLE_JOB_ID}',
      lifecycle_execution_generation uuid DEFAULT '${LIFECYCLE_EXECUTION_GENERATION}',
      restore_attempt_id uuid,
      state text NOT NULL DEFAULT 'in_flight_unresolved',
      locator_sandbox_id text,
      locator_node_id text,
      locator_container_name text,
      locator_node_record_id uuid,
      locator_node_incarnation uuid,
      locator_node_history_id uuid,
      locator_node_hostname text,
      locator_node_ssh_port integer,
      locator_node_ssh_user text,
      locator_node_host_key_fingerprint text,
      locator_secret_cleanup_version integer,
      locator_allocation_counted boolean,
      locator_vpn_node_name text,
      locator_vpn_registration_started_at timestamptz,
      locator_previous_vpn_node_id text,
      locator_recorded_at timestamptz,
      locator_container_id text,
      locator_container_recorded_at timestamptz,
      locator_vpn_node_id text,
      locator_vpn_recorded_at timestamptz,
      lifecycle_committed_at timestamptz,
      lifecycle_receipt_digest text,
      cleanup_proven_at timestamptz,
      cleanup_receipt_digest text
    );
    INSERT INTO agent_node_incarnation_histories
      (id, docker_node_record_id, node_id, node_incarnation)
    VALUES
      ('${NODE_HISTORY_ID}', '${NODE_RECORD_ID}', '${NODE_ID}', '${NODE_INCARNATION}'),
      ('${OTHER_NODE_HISTORY_ID}', '${OTHER_NODE_RECORD_ID}', '${OTHER_NODE_ID}',
        '${OTHER_NODE_INCARNATION}'),
      ('${REUSED_NODE_HISTORY_ID}', '${REUSED_NODE_RECORD_ID}', '${NODE_ID}',
        '${REUSED_NODE_INCARNATION}'),
      ('${PREVIOUS_NODE_HISTORY_ID}', '${PREVIOUS_NODE_RECORD_ID}', '${PREVIOUS_NODE_ID}',
        '${PREVIOUS_NODE_INCARNATION}'),
      ('${ABA_NODE_HISTORY_ID}', '${ABA_NODE_RECORD_ID}', '${PREVIOUS_NODE_ID}',
        '${ABA_NODE_INCARNATION}');
    INSERT INTO docker_nodes (
      id, node_id, node_incarnation, current_node_history_id, allocated_count
    ) VALUES
      ('${NODE_RECORD_ID}', '${NODE_ID}', '${NODE_INCARNATION}', '${NODE_HISTORY_ID}', 1),
      ('${PREVIOUS_NODE_RECORD_ID}', '${PREVIOUS_NODE_ID}', '${PREVIOUS_NODE_INCARNATION}',
        '${PREVIOUS_NODE_HISTORY_ID}', 1);
    INSERT INTO agent_sandboxes (
      id, organization_id, sandbox_id, node_id, container_name, status,
      activation_generation, lifecycle_revision, lifecycle_job_id,
      lifecycle_execution_generation
    ) VALUES (
      '${AGENT_ID}', '${ORGANIZATION_ID}', 'old-sandbox', 'old-node', 'old-container', 'running',
      '${ACTIVATION_GENERATION}', ${ATTEMPT_LIFECYCLE_REVISION}, '${LIFECYCLE_JOB_ID}',
      '${LIFECYCLE_EXECUTION_GENERATION}'
    );
    INSERT INTO agent_activation_publications (
      id, organization_id, agent_id, activation_generation, container_id,
      node_history_id, docker_node_record_id, node_id, node_incarnation
    ) VALUES (
      'e0000000-0000-4000-8000-000000000001', '${ORGANIZATION_ID}', '${AGENT_ID}',
      '${ACTIVATION_GENERATION}', '${PREVIOUS_CONTAINER_ID}', '${PREVIOUS_NODE_HISTORY_ID}',
      '${PREVIOUS_NODE_RECORD_ID}', '${PREVIOUS_NODE_ID}', '${PREVIOUS_NODE_INCARNATION}'
    );
  `);
  if (input.existingTarget) {
    await db.query(
      `INSERT INTO agent_backup_restore_operations
         (id, organization_id, restore_attempt_id, expected_node_record_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [SOURCE_ID, ORGANIZATION_ID, RESTORE_ATTEMPT_ID, NODE_RECORD_ID],
    );
  }
  if (input.existingLocator) {
    await db.query(
      `INSERT INTO agent_sandbox_replacement_attempts
         (id, organization_id, locator_node_id)
       VALUES ($1::uuid, $2::uuid, $3)`,
      [RECEIVER_ID, ORGANIZATION_ID, NODE_ID],
    );
  }
  return db;
}

async function database(): Promise<PGlite> {
  const db = await prerequisiteDatabase();
  await applyMigration(db);
  return db;
}

async function insertSource(
  db: PGlite,
  input: { id?: string; restoreAttemptId?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO agent_backup_restore_operations
       (id, organization_id, restore_attempt_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid)`,
    [input.id ?? SOURCE_ID, ORGANIZATION_ID, input.restoreAttemptId ?? RESTORE_ATTEMPT_ID],
  );
}

async function reserveSource(db: PGlite, nodeId: string = NODE_ID): Promise<void> {
  await db.query(
    `UPDATE agent_backup_restore_operations SET
       expected_node_history_id = $1::uuid,
       expected_node_record_id = $2::uuid,
       expected_node_incarnation = $3::uuid,
       expected_node_id = $4,
       expected_image_digest = $5,
       capacity_state = 'reserved',
       capacity_reserved_at = $6::timestamptz
     WHERE id = $7::uuid`,
    [
      NODE_HISTORY_ID,
      NODE_RECORD_ID,
      NODE_INCARNATION,
      nodeId,
      IMAGE_DIGEST,
      SOURCE_RESERVED_AT,
      SOURCE_ID,
    ],
  );
}

async function insertReceiver(
  db: PGlite,
  input: {
    activationGeneration?: string;
    id?: string;
    lifecycleRevision?: number;
    previousContainerId?: string;
    previousNodeId?: string;
    previousPlacement?: "current" | "old";
    restoreAttemptId?: string | null;
  } = {},
): Promise<void> {
  const previousIsCurrent = input.previousPlacement === "current";
  await db.query(
    `INSERT INTO agent_sandbox_replacement_attempts
       (id, organization_id, restore_attempt_id, previous_placement_absent,
        previous_sandbox_id, previous_node_id, previous_container_name,
        previous_container_id, previous_allocation_counted, previous_node_record_id,
        previous_node_incarnation, previous_node_history_id, previous_node_hostname,
        previous_node_ssh_port, previous_node_ssh_user, lifecycle_revision,
        activation_generation,
        previous_node_host_key_fingerprint)
     VALUES ($1::uuid, $2::uuid, $3::uuid, FALSE, $4, $5,
       $6, $7, TRUE, $8::uuid, $9::uuid, $10::uuid,
       'node-1.internal', 22, 'root', $11, $12::uuid, 'SHA256:test-node-key')`,
    [
      input.id ?? RECEIVER_ID,
      ORGANIZATION_ID,
      input.restoreAttemptId === undefined ? RESTORE_ATTEMPT_ID : input.restoreAttemptId,
      previousIsCurrent ? LOCATOR_SANDBOX_ID : "old-sandbox",
      input.previousNodeId ?? (previousIsCurrent ? NODE_ID : PREVIOUS_NODE_ID),
      previousIsCurrent ? LOCATOR_SANDBOX_ID : "old-container",
      input.previousContainerId ??
        (previousIsCurrent ? LOCATOR_CONTAINER_ID : PREVIOUS_CONTAINER_ID),
      previousIsCurrent ? NODE_RECORD_ID : PREVIOUS_NODE_RECORD_ID,
      previousIsCurrent ? NODE_INCARNATION : PREVIOUS_NODE_INCARNATION,
      previousIsCurrent ? NODE_HISTORY_ID : PREVIOUS_NODE_HISTORY_ID,
      input.lifecycleRevision ?? ATTEMPT_LIFECYCLE_REVISION,
      input.activationGeneration ?? ACTIVATION_GENERATION,
    ],
  );
}

async function reserveReceiver(
  db: PGlite,
  input: {
    containerId?: string;
    id?: string;
    sandboxId?: string;
    nodeHistoryId?: string;
    nodeId?: string;
    nodeIncarnation?: string;
    nodeRecordId?: string;
    reservedAt?: string;
    vpnIntent?: boolean;
  } = {},
): Promise<void> {
  await db.query(
    `UPDATE agent_sandbox_replacement_attempts SET
       locator_sandbox_id = $1,
       locator_node_id = $2,
       locator_container_name = $1,
       locator_node_record_id = $3::uuid,
       locator_node_incarnation = $4::uuid,
       locator_node_history_id = $5::uuid,
       locator_node_hostname = 'node-1.internal',
       locator_node_ssh_port = 22,
       locator_node_ssh_user = 'root',
       locator_node_host_key_fingerprint = 'SHA256:test-node-key',
       locator_secret_cleanup_version = 1,
       locator_allocation_counted = TRUE,
       locator_recorded_at = $6::timestamptz,
       locator_container_id = $8,
       locator_container_recorded_at = $6::timestamptz,
       locator_vpn_node_name = $9,
       locator_vpn_registration_started_at = $10::timestamptz,
       capacity_state = 'reserved',
       capacity_reserved_at = $6::timestamptz
     WHERE id = $7::uuid`,
    [
      input.sandboxId ?? LOCATOR_SANDBOX_ID,
      input.nodeId ?? NODE_ID,
      input.nodeRecordId ?? NODE_RECORD_ID,
      input.nodeIncarnation ?? NODE_INCARNATION,
      input.nodeHistoryId ?? NODE_HISTORY_ID,
      input.reservedAt ?? HANDOFF_AT,
      input.id ?? RECEIVER_ID,
      input.containerId ?? LOCATOR_CONTAINER_ID,
      input.vpnIntent ? LOCATOR_VPN_NODE_NAME : null,
      input.vpnIntent ? HANDOFF_AT : null,
    ],
  );
}

async function recordCandidateCleanup(
  db: PGlite,
  input: {
    attemptId?: string;
    containerId?: string;
    nodeHistoryId?: string;
    nodeId?: string;
    nodeIncarnation?: string;
    nodeRecordId?: string;
    sandboxId?: string;
    vpnIntent?: boolean;
  } = {},
): Promise<void> {
  await db.query(
    `UPDATE agent_sandboxes SET
      replacement_cleanup_sandbox_id = $1,
      replacement_cleanup_node_id = $2,
      replacement_cleanup_node_record_id = $3::uuid,
      replacement_cleanup_node_incarnation = $4::uuid,
      replacement_cleanup_node_history_id = $5::uuid,
      replacement_cleanup_node_hostname = 'node-1.internal',
      replacement_cleanup_node_ssh_port = 22,
      replacement_cleanup_node_ssh_user = 'root',
      replacement_cleanup_node_host_key_fingerprint = 'SHA256:test-node-key',
      replacement_cleanup_secret_cleanup_version = 1,
      replacement_cleanup_container_name = $1,
      replacement_cleanup_attempt_id = $6::uuid,
      replacement_cleanup_container_id = $7,
      replacement_cleanup_allocation_counted = TRUE,
      replacement_cleanup_created_at = $8::timestamptz,
      replacement_cleanup_vpn_node_name = $9,
      replacement_cleanup_vpn_registration_started_at = $10::timestamptz`,
    [
      input.sandboxId ?? LOCATOR_SANDBOX_ID,
      input.nodeId ?? NODE_ID,
      input.nodeRecordId ?? NODE_RECORD_ID,
      input.nodeIncarnation ?? NODE_INCARNATION,
      input.nodeHistoryId ?? NODE_HISTORY_ID,
      input.attemptId ?? RECEIVER_ID,
      input.containerId ?? LOCATOR_CONTAINER_ID,
      RECEIVER_SETTLED_AT,
      input.vpnIntent ? LOCATOR_VPN_NODE_NAME : null,
      input.vpnIntent ? HANDOFF_AT : null,
    ],
  );
}

async function enrichCandidateVpn(db: PGlite, vpnNodeId: string): Promise<void> {
  await db.exec("BEGIN");
  await db.query(
    `UPDATE agent_sandbox_replacement_attempts SET
      locator_vpn_node_id = $1, locator_vpn_recorded_at = $3::timestamptz
      WHERE id = $2::uuid`,
    [vpnNodeId, RECEIVER_ID, RECEIVER_SETTLED_AT],
  );
  await db.query("UPDATE agent_sandboxes SET replacement_cleanup_vpn_node_id = $1", [vpnNodeId]);
  await db.exec("COMMIT");
}

async function commitCanonicalSandbox(
  db: PGlite,
  input: {
    activationGeneration?: string;
    allocationCounted?: boolean | null;
    cleanupAllocationCounted?: boolean | null;
    cleanupAttemptId?: string | null;
    cleanupContainerId?: string | null;
    cleanupContainerName?: string;
    cleanupNodeHistoryId?: string;
    cleanupNodeId?: string;
    cleanupNodeIncarnation?: string;
    cleanupNodeRecordId?: string;
    cleanupSandboxId?: string;
    deletionAttemptId?: string | null;
    lifecycleExecutionGeneration?: string | null;
    lifecycleJobId?: string | null;
    lifecycleRevision?: number;
    nodeId?: string;
    sandboxId?: string;
  } = {},
): Promise<void> {
  const cleanupNodeId = input.cleanupNodeId ?? PREVIOUS_NODE_ID;
  const cleanupIsCurrentLocator = cleanupNodeId === NODE_ID;
  await db.query(
    `UPDATE agent_sandboxes SET
       sandbox_id = $1,
       node_id = $2,
       container_name = $1,
       activation_generation = $3::uuid,
       lifecycle_revision = $4,
       lifecycle_job_id = $5::uuid,
       lifecycle_execution_generation = $6::uuid,
       deletion_allocation_counted = $7,
       deletion_attempt_id = $8::uuid,
       replacement_cleanup_sandbox_id = $9,
       replacement_cleanup_node_id = $10,
       replacement_cleanup_node_record_id = $11::uuid,
       replacement_cleanup_node_incarnation = $12::uuid,
       replacement_cleanup_node_history_id = $13::uuid,
       replacement_cleanup_node_hostname = 'node-1.internal',
       replacement_cleanup_node_ssh_port = 22,
       replacement_cleanup_node_ssh_user = 'root',
       replacement_cleanup_node_host_key_fingerprint = 'SHA256:test-node-key',
       replacement_cleanup_secret_cleanup_version = NULL,
       replacement_cleanup_container_name = $14,
       replacement_cleanup_attempt_id = $15::uuid,
       replacement_cleanup_container_id = $16,
       replacement_cleanup_allocation_counted = $17,
       replacement_cleanup_created_at = $18::timestamptz
     WHERE id = $19::uuid AND organization_id = $20::uuid`,
    [
      input.sandboxId ?? LOCATOR_SANDBOX_ID,
      input.nodeId ?? NODE_ID,
      input.activationGeneration ?? ACTIVATION_GENERATION,
      input.lifecycleRevision ?? ATTEMPT_LIFECYCLE_REVISION + 1,
      input.lifecycleJobId === undefined ? LIFECYCLE_JOB_ID : input.lifecycleJobId,
      input.lifecycleExecutionGeneration === undefined
        ? LIFECYCLE_EXECUTION_GENERATION
        : input.lifecycleExecutionGeneration,
      input.allocationCounted === undefined ? null : input.allocationCounted,
      input.deletionAttemptId === undefined ? null : input.deletionAttemptId,
      input.cleanupSandboxId ?? "old-sandbox",
      cleanupNodeId,
      input.cleanupNodeRecordId ??
        (cleanupIsCurrentLocator ? NODE_RECORD_ID : PREVIOUS_NODE_RECORD_ID),
      input.cleanupNodeIncarnation ??
        (cleanupIsCurrentLocator ? NODE_INCARNATION : PREVIOUS_NODE_INCARNATION),
      input.cleanupNodeHistoryId ??
        (cleanupIsCurrentLocator ? NODE_HISTORY_ID : PREVIOUS_NODE_HISTORY_ID),
      input.cleanupContainerName ?? "old-container",
      input.cleanupAttemptId === undefined ? RECEIVER_ID : input.cleanupAttemptId,
      input.cleanupContainerId === undefined
        ? cleanupIsCurrentLocator
          ? LOCATOR_CONTAINER_ID
          : PREVIOUS_CONTAINER_ID
        : input.cleanupContainerId,
      input.cleanupAllocationCounted === undefined ? true : input.cleanupAllocationCounted,
      RECEIVER_SETTLED_AT,
      AGENT_ID,
      ORGANIZATION_ID,
    ],
  );
}

async function handoffSource(db: PGlite): Promise<void> {
  await db.query(
    `UPDATE agent_backup_restore_operations SET
       capacity_state = 'handed_off',
       capacity_settled_at = $1::timestamptz,
       capacity_settlement_receipt_digest = $2
     WHERE id = $3::uuid`,
    [HANDOFF_AT, RECEIPT_DIGEST, SOURCE_ID],
  );
}

async function handoffReceiverLifecycle(db: PGlite, id: string = RECEIVER_ID): Promise<void> {
  await db.query(
    `UPDATE agent_sandbox_replacement_attempts SET
       state = 'lifecycle_committed', lifecycle_committed_at = $1::timestamptz,
       lifecycle_receipt_digest = $2, capacity_state = 'handed_off',
       capacity_settled_at = $1::timestamptz,
       capacity_settlement_receipt_digest = $2,
       previous_cleanup_state = 'pending'
     WHERE id = $3::uuid`,
    [RECEIVER_SETTLED_AT, RECEIPT_DIGEST, id],
  );
}

async function clearReplacementCleanup(db: PGlite): Promise<void> {
  await db.query(
    `UPDATE agent_sandbox_replacement_attempts SET
      previous_cleanup_state = 'released',
      previous_cleanup_proven_at = $1::timestamptz,
      previous_cleanup_receipt_digest = $2
    WHERE previous_cleanup_state = 'pending'`,
    ["2026-08-24T10:03:00.000Z", RECEIPT_DIGEST],
  );
  await db.query(
    `UPDATE agent_sandbox_replacement_attempts SET
      state = 'cleanup_proven', cleanup_proven_at = $1::timestamptz,
      cleanup_receipt_digest = $2, capacity_state = 'released',
      capacity_settled_at = $1::timestamptz,
      capacity_settlement_receipt_digest = $2
    WHERE state IN ('in_flight_unresolved', 'provider_succeeded')
      AND capacity_state = 'reserved'`,
    ["2026-08-24T10:03:00.000Z", RECEIPT_DIGEST],
  );
  await db.exec(`UPDATE agent_sandboxes SET
    replacement_cleanup_sandbox_id = NULL,
    replacement_cleanup_node_id = NULL,
    replacement_cleanup_node_record_id = NULL,
    replacement_cleanup_node_incarnation = NULL,
    replacement_cleanup_node_history_id = NULL,
    replacement_cleanup_node_hostname = NULL,
    replacement_cleanup_node_ssh_port = NULL,
    replacement_cleanup_node_ssh_user = NULL,
    replacement_cleanup_node_host_key_fingerprint = NULL,
    replacement_cleanup_secret_cleanup_version = NULL,
    replacement_cleanup_container_name = NULL,
    replacement_cleanup_attempt_id = NULL,
    replacement_cleanup_container_id = NULL,
    replacement_cleanup_vpn_node_id = NULL,
    replacement_cleanup_vpn_node_name = NULL,
    replacement_cleanup_preserved_vpn_node_id = NULL,
    replacement_cleanup_vpn_registration_started_at = NULL,
    replacement_cleanup_allocation_counted = NULL,
    replacement_cleanup_created_at = NULL
  `);
}

async function commitExactHandoff(db: PGlite): Promise<void> {
  await db.exec("BEGIN");
  await handoffSource(db);
  await reserveReceiver(db);
  await db.exec("COMMIT");
}

async function prepareProviderSucceededReceiver(db: PGlite): Promise<void> {
  await insertReceiver(db, { restoreAttemptId: null });
  await reserveReceiver(db);
  await db.exec("UPDATE agent_sandbox_replacement_attempts SET state = 'provider_succeeded'");
  await recordCandidateCleanup(db);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0314 restore capacity ownership", () => {
  test("pushes the complete Drizzle restore/replacement graph into a blank database", async () => {
    const client = new PGlite();
    databases.push(client);
    const schemaDatabase = drizzle(client);
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentSandboxes,
        agentNodeIncarnationHistories,
        dockerNodes,
        agentSandboxBackups,
        agentBackupCatalogAuthorities,
        agentBackupRestoreLeases,
        agentBackupRestoreOperations,
        agentSandboxReplacementAttempts,
      } as never,
      schemaDatabase as never,
    );
    await apply();

    const constraints = await client.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint WHERE conname IN (
        'agent_backup_restore_operations_attempt_uidx',
        'agent_backup_restore_operations_node_occurrence_fkey',
        'agent_sandbox_replacement_attempts_node_occurrence_fkey',
        'agent_sandbox_replacement_attempts_previous_node_occurrence_fke',
        'agent_sandbox_replacement_attempts_restore_operation_fkey'
      ) ORDER BY conname
    `);
    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      "agent_backup_restore_operations_attempt_uidx",
      "agent_backup_restore_operations_node_occurrence_fkey",
      "agent_sandbox_replacement_attempts_node_occurrence_fkey",
      "agent_sandbox_replacement_attempts_previous_node_occurrence_fke",
      "agent_sandbox_replacement_attempts_restore_operation_fkey",
    ]);
  }, 60_000);

  test("is the exact journal tail, isolates the contract preflight, and replays safely", async () => {
    const journal = (await Bun.file(journalUrl).json()) as {
      entries: Array<{
        breakpoints: boolean;
        idx: number;
        tag: string;
        version: string;
        when: number;
      }>;
    };
    expect(journal.entries.slice(-journalTailTags.length)).toEqual(
      journalTailTags.map((tag, offset) => ({
        breakpoints: true,
        idx: 297 + offset,
        tag,
        version: "7",
        when: 1794254400005 + offset,
      })),
    );

    const expand = await Bun.file(migrationUrls[0]).text();
    expect(expand).not.toContain("LOCK TABLE");
    const preflight = await Bun.file(
      new URL("./migrations/0328_agent_capacity_contract_preflight.sql", import.meta.url),
    ).text();
    expect(preflight.match(/LOCK TABLE/g)).toHaveLength(1);
    expect(preflight).toContain('"agent_backup_restore_operations",');
    expect(preflight).toContain('"agent_sandbox_replacement_attempts",');
    expect(preflight).toContain('"agent_node_incarnation_histories"');
    expect(preflight).toContain("IN ACCESS EXCLUSIVE MODE NOWAIT");

    const db = await database();
    await insertSource(db);
    await reserveSource(db);
    await insertReceiver(db);
    await commitExactHandoff(db);
    await applyMigration(db);

    const row = await db.query<{ capacity_state: string }>(
      "SELECT capacity_state FROM agent_backup_restore_operations",
    );
    expect(row.rows).toEqual([{ capacity_state: "handed_off" }]);
  });

  test("matches Drizzle columns, checks, FKs, partial indexes, and deferred guards", async () => {
    const db = await database();
    const historySchema = getTableConfig(agentNodeIncarnationHistories);
    const restoreSchema = getTableConfig(agentBackupRestoreOperations);
    const replacementSchema = getTableConfig(agentSandboxReplacementAttempts);

    const columns = await db.query<{
      column_name: string;
      is_not_null: boolean;
      sql_type: string;
      table_name: string;
    }>(`
      SELECT relation.relname AS table_name, attribute.attname AS column_name,
        format_type(attribute.atttypid, attribute.atttypmod) AS sql_type,
        attribute.attnotnull AS is_not_null
      FROM pg_attribute AS attribute
      JOIN pg_class AS relation ON relation.oid = attribute.attrelid
      WHERE relation.relname IN (
        'agent_backup_restore_operations', 'agent_sandbox_replacement_attempts'
      ) AND attribute.attname IN (
        'expected_node_id', 'capacity_state', 'capacity_reserved_at',
        'capacity_settled_at', 'capacity_settlement_receipt_digest',
        'previous_placement_absent', 'previous_sandbox_id', 'previous_node_id',
        'previous_container_name', 'previous_container_id',
        'previous_allocation_counted', 'previous_node_record_id',
        'previous_node_incarnation', 'previous_node_history_id',
        'previous_node_hostname', 'previous_node_ssh_port', 'previous_node_ssh_user',
        'previous_node_host_key_fingerprint'
      ) AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY relation.relname, attribute.attname
    `);
    expect(columns.rows).toHaveLength(22);
    for (const row of columns.rows) {
      const schema =
        row.table_name === "agent_backup_restore_operations" ? restoreSchema : replacementSchema;
      const column = schema.columns.find(({ name }) => name === row.column_name);
      expect(column?.getSQLType()).toBe(row.sql_type);
      expect(column?.notNull).toBe(row.is_not_null);
    }

    expect(restoreSchema.checks.map(({ name }) => name)).toContain(
      "agent_backup_restore_operations_capacity_shape_check",
    );
    expect(replacementSchema.checks.map(({ name }) => name)).toContain(
      "agent_sandbox_replacement_attempts_capacity_shape_check",
    );
    expect(replacementSchema.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "agent_sandbox_replacement_attempts_previous_placement_mode_check",
        "agent_sandbox_replacement_attempts_previous_placement_shape_check",
      ]),
    );
    expect(historySchema.uniqueConstraints.map(({ name }) => name)).toContain(
      "agent_node_incarnation_histories_logical_authority_unique",
    );
    expect(restoreSchema.uniqueConstraints.map(({ name }) => name)).toContain(
      "agent_backup_restore_operations_attempt_uidx",
    );
    expect(restoreSchema.indexes.map(({ config }) => config.name)).toContain(
      "agent_backup_restore_capacity_reserved_occurrence_idx",
    );
    expect(restoreSchema.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      "agent_backup_restore_operations_node_occurrence_fkey",
    );
    expect(replacementSchema.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        "agent_sandbox_replacement_attempts_node_occurrence_fkey",
        "agent_sandbox_replacement_attempts_previous_node_occurrence_fkey",
        "agent_sandbox_replacement_attempts_restore_operation_fkey",
      ]),
    );
    expect(replacementSchema.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        "agent_sandbox_replacement_capacity_reserved_occurrence_idx",
        "agent_sandbox_replacement_restore_capacity_receiver_uidx",
      ]),
    );

    const constraints = await db.query<{ conname: string; definition: string }>(`
      SELECT conname, pg_get_constraintdef(oid, true) AS definition
      FROM pg_constraint
      WHERE conname IN (
        'agent_backup_restore_operations_capacity_shape_check',
        'agent_backup_restore_operations_attempt_uidx',
        'agent_backup_restore_operations_node_occurrence_fkey',
        'agent_node_incarnation_histories_logical_authority_unique',
        'agent_sandbox_replacement_attempts_capacity_shape_check',
        'agent_sandbox_replacement_attempts_node_occurrence_fkey',
        'agent_sandbox_replacement_attempts_previous_node_occurrence_fke',
        'agent_sandbox_replacement_attempts_previous_placement_mode_chec',
        'agent_sandbox_replacement_attempts_previous_placement_shape_che',
        'agent_sandbox_replacement_attempts_restore_operation_fkey'
      ) ORDER BY conname
    `);
    expect(constraints.rows).toHaveLength(10);
    const definitions = Object.fromEntries(
      constraints.rows.map(({ conname, definition }) => [conname, definition]),
    );
    expect(definitions.agent_sandbox_replacement_attempts_restore_operation_fkey).toContain(
      "FOREIGN KEY (organization_id, restore_attempt_id) REFERENCES agent_backup_restore_operations(organization_id, restore_attempt_id) ON DELETE RESTRICT",
    );
    expect(definitions.agent_backup_restore_operations_attempt_uidx).toBe(
      "UNIQUE (organization_id, restore_attempt_id)",
    );
    expect(definitions.agent_node_incarnation_histories_logical_authority_unique).toBe(
      "UNIQUE (id, docker_node_record_id, node_incarnation, node_id)",
    );
    expect(definitions.agent_backup_restore_operations_node_occurrence_fkey).toContain(
      "FOREIGN KEY (expected_node_history_id, expected_node_record_id, expected_node_incarnation, expected_node_id)",
    );
    expect(definitions.agent_sandbox_replacement_attempts_node_occurrence_fkey).toContain(
      "FOREIGN KEY (locator_node_history_id, locator_node_record_id, locator_node_incarnation, locator_node_id)",
    );
    expect(definitions.agent_sandbox_replacement_attempts_previous_node_occurrence_fke).toContain(
      "FOREIGN KEY (previous_node_history_id, previous_node_record_id, previous_node_incarnation, previous_node_id)",
    );
    expect(
      definitions.agent_sandbox_replacement_attempts_previous_placement_mode_chec,
    ).not.toContain("previous_placement_absent IS NULL");

    const indexes = await db.query<{ indexdef: string; indexname: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN (
        'agent_backup_restore_capacity_reserved_occurrence_idx',
        'agent_sandbox_replacement_capacity_reserved_occurrence_idx',
        'agent_sandbox_replacement_restore_capacity_receiver_uidx'
      ) ORDER BY indexname
    `);
    expect(indexes.rows).toHaveLength(3);
    const indexDefinitions = Object.fromEntries(
      indexes.rows.map(({ indexdef, indexname }) => [indexname, indexdef]),
    );
    expect(indexDefinitions.agent_backup_restore_capacity_reserved_occurrence_idx).toContain(
      "(expected_node_record_id, expected_node_id, expected_node_incarnation, expected_node_history_id)",
    );
    expect(indexDefinitions.agent_backup_restore_capacity_reserved_occurrence_idx).toContain(
      "WHERE (capacity_state = 'reserved'::text)",
    );
    expect(indexDefinitions.agent_sandbox_replacement_capacity_reserved_occurrence_idx).toContain(
      "(locator_node_record_id, locator_node_id, locator_node_incarnation, locator_node_history_id)",
    );
    expect(indexDefinitions.agent_sandbox_replacement_capacity_reserved_occurrence_idx).toContain(
      "WHERE (capacity_state = 'reserved'::text)",
    );
    expect(indexDefinitions.agent_sandbox_replacement_restore_capacity_receiver_uidx).toContain(
      "WHERE ((restore_attempt_id IS NOT NULL) AND (capacity_state IS NOT NULL))",
    );

    const triggers = await db.query<{
      tgdeferrable: boolean;
      tginitdeferred: boolean;
      tgname: string;
    }>(`
      SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger
      WHERE tgname IN (
        'agent_backup_restore_capacity_insert_guard',
        'agent_backup_restore_capacity_update_guard',
        'agent_sandbox_replacement_capacity_insert_guard',
        'agent_sandbox_replacement_capacity_update_guard',
        'agent_backup_restore_capacity_handoff_guard',
        'agent_sandbox_replacement_capacity_handoff_guard',
        'agent_sandboxes_replacement_previous_placement_guard',
        'agent_sandboxes_replacement_cleanup_release_guard'
      ) ORDER BY tgname
    `);
    expect(triggers.rows.map(({ tgname }) => tgname)).toEqual([
      "agent_backup_restore_capacity_handoff_guard",
      "agent_backup_restore_capacity_insert_guard",
      "agent_backup_restore_capacity_update_guard",
      "agent_sandbox_replacement_capacity_handoff_guard",
      "agent_sandbox_replacement_capacity_insert_guard",
      "agent_sandbox_replacement_capacity_update_guard",
      "agent_sandboxes_replacement_cleanup_release_guard",
      "agent_sandboxes_replacement_previous_placement_guard",
    ]);
    expect(
      triggers.rows
        .filter(
          ({ tgname }) =>
            tgname.includes("handoff") ||
            tgname.includes("previous_placement") ||
            tgname.includes("cleanup_release"),
        )
        .every(({ tgdeferrable, tginitdeferred }) => tgdeferrable && tginitdeferred),
    ).toBe(true);
  });

  test("keeps the expand phase writable by the old worker until contract convergence", async () => {
    const db = await prerequisiteDatabase();
    await applyMigrationUrls(db, expandMigrationUrls);

    await insertSource(db);
    await db.query(
      `UPDATE agent_backup_restore_operations SET
        expected_node_history_id = $1::uuid,
        expected_node_record_id = $2::uuid,
        expected_node_incarnation = $3::uuid,
        expected_container_id = 'legacy-container',
        expected_image_digest = $4
       WHERE id = $5::uuid`,
      [NODE_HISTORY_ID, NODE_RECORD_ID, NODE_INCARNATION, IMAGE_DIGEST, SOURCE_ID],
    );
    await db.query(
      `INSERT INTO agent_sandbox_replacement_attempts (
        id, organization_id, locator_sandbox_id, locator_node_id,
        locator_container_name, locator_node_record_id, locator_node_incarnation,
        locator_node_history_id, locator_recorded_at
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $3, $5::uuid, $6::uuid,
        $7::uuid, $8::timestamptz)`,
      [
        RECEIVER_ID,
        ORGANIZATION_ID,
        LOCATOR_SANDBOX_ID,
        NODE_ID,
        NODE_RECORD_ID,
        NODE_INCARNATION,
        NODE_HISTORY_ID,
        HANDOFF_AT,
      ],
    );

    await expect(applyMigration(db)).rejects.toThrow(/legacy restore targets/);

    await db.exec(`UPDATE agent_backup_restore_operations SET
      expected_node_history_id = NULL,
      expected_node_record_id = NULL,
      expected_node_incarnation = NULL,
      expected_container_id = NULL,
      expected_image_digest = NULL
    `);
    await db.exec("DELETE FROM agent_sandbox_replacement_attempts");
    await applyMigration(db);
  });

  test("keeps legacy cleanup writable during expand and refuses contract before drain", async () => {
    const db = await prerequisiteDatabase();
    await applyMigrationUrls(db, expandMigrationUrls);
    await db.exec(`UPDATE agent_sandboxes SET
      replacement_cleanup_sandbox_id = 'legacy-cleanup',
      replacement_cleanup_node_id = 'legacy-node',
      replacement_cleanup_container_name = 'legacy-container',
      replacement_cleanup_attempt_id = '${RECEIVER_ID}'::uuid,
      replacement_cleanup_allocation_counted = TRUE,
      replacement_cleanup_created_at = '${RECEIVER_SETTLED_AT}'::timestamptz
    `);

    const expanded = await db.query<{
      replacement_cleanup_node_record_id: string | null;
      replacement_cleanup_sandbox_id: string;
    }>(`SELECT replacement_cleanup_sandbox_id, replacement_cleanup_node_record_id
      FROM agent_sandboxes`);
    expect(expanded.rows).toEqual([
      {
        replacement_cleanup_node_record_id: null,
        replacement_cleanup_sandbox_id: "legacy-cleanup",
      },
    ]);
    await expect(applyMigrationUrls(db, contractMigrationUrls)).rejects.toThrow(
      /legacy fences to be converged/,
    );

    await clearReplacementCleanup(db);
    await applyMigrationUrls(db, contractMigrationUrls);
    const authority = await db.query<{ name: string }>(`
      SELECT conname AS name FROM pg_constraint
      WHERE conname IN (
        'agent_sandboxes_replacement_cleanup_occurrence_check',
        'agent_sandboxes_replacement_cleanup_node_occurrence_fkey'
      )
      UNION ALL
      SELECT tgname AS name FROM pg_trigger
      WHERE tgname = 'agent_sandboxes_replacement_cleanup_occurrence_guard'
      ORDER BY name
    `);
    expect(authority.rows.map(({ name }) => name)).toEqual([
      "agent_sandboxes_replacement_cleanup_node_occurrence_fkey",
      "agent_sandboxes_replacement_cleanup_occurrence_check",
      "agent_sandboxes_replacement_cleanup_occurrence_guard",
    ]);
  });

  test("requires immutable exact current cleanup occurrence authority", async () => {
    const db = await prerequisiteDatabase();
    await applyMigrationUrls(db, expandMigrationUrls);
    await insertReceiver(db, { restoreAttemptId: null });
    await reserveReceiver(db, { vpnIntent: true });
    await recordCandidateCleanup(db, { vpnIntent: true });
    await applyMigrationUrls(db, contractMigrationUrls);
    await enrichCandidateVpn(db, "123456");
    await db.exec("UPDATE agent_sandbox_replacement_attempts SET state = 'provider_succeeded'");
    await expect(
      db.exec("UPDATE agent_sandboxes SET replacement_cleanup_node_hostname = 'other.internal'"),
    ).rejects.toThrow(/occurrence authority is immutable/);

    await db.exec("UPDATE docker_nodes SET allocated_count = 0");
    await expect(
      db.exec(`UPDATE agent_sandboxes SET
        replacement_cleanup_sandbox_id = 'other-sandbox',
        replacement_cleanup_container_name = 'other-sandbox'
      `),
    ).rejects.toThrow(/exact current node occurrence/);

    await db.exec("UPDATE docker_nodes SET allocated_count = 1");
    await clearReplacementCleanup(db);
    const cleared = await db.query<{
      replacement_cleanup_node_record_id: string | null;
      replacement_cleanup_sandbox_id: string | null;
    }>(`SELECT replacement_cleanup_sandbox_id, replacement_cleanup_node_record_id
      FROM agent_sandboxes`);
    expect(cleared.rows).toEqual([
      {
        replacement_cleanup_node_record_id: null,
        replacement_cleanup_sandbox_id: null,
      },
    ]);
  });

  test("requires one exact immutable previous placement tuple", async () => {
    const malformedDb = await database();
    await expect(
      insertReceiver(malformedDb, {
        previousContainerId: "c".repeat(63),
        restoreAttemptId: null,
      }),
    ).rejects.toThrow(/previous_placement_shape_che/);

    const forgedOccurrenceDb = await database();
    await expect(
      insertReceiver(forgedOccurrenceDb, {
        previousNodeId: "invented-old-node",
        restoreAttemptId: null,
      }),
    ).rejects.toThrow(/previous_node_occurrence_fke/);

    const immutableDb = await database();
    await insertReceiver(immutableDb, { restoreAttemptId: null });
    for (const mutation of [
      `previous_placement_absent = TRUE`,
      `previous_container_id = '${"f".repeat(64)}'`,
      `previous_node_record_id = '${ABA_NODE_RECORD_ID}'::uuid`,
      `previous_node_hostname = 'forged.internal'`,
    ]) {
      await expect(
        immutableDb.exec(`UPDATE agent_sandbox_replacement_attempts SET ${mutation}`),
      ).rejects.toThrow(/previous-placement authority is immutable/);
    }
  });

  test("rejects previous-node ABA even when the logical node id is reused", async () => {
    const db = await database();
    await prepareProviderSucceededReceiver(db);
    await db.exec(`DELETE FROM docker_nodes WHERE id = '${PREVIOUS_NODE_RECORD_ID}'::uuid`);
    await db.exec(`INSERT INTO docker_nodes (
      id, node_id, node_incarnation, current_node_history_id, allocated_count
    ) VALUES ('${ABA_NODE_RECORD_ID}', '${PREVIOUS_NODE_ID}', '${ABA_NODE_INCARNATION}',
      '${ABA_NODE_HISTORY_ID}', 1)`);
    await expect(commitCanonicalSandbox(db)).rejects.toThrow(/exact current node occurrence/);
    const canonical = await db.query<{ sandbox_id: string }>(
      "SELECT sandbox_id FROM agent_sandboxes",
    );
    expect(canonical.rows).toEqual([{ sandbox_id: "old-sandbox" }]);
  });

  test("fails closed instead of inventing authority for an existing target or locator", async () => {
    const targetDb = await prerequisiteDatabase({ existingTarget: true });
    await expect(applyMigration(targetDb)).rejects.toThrow(
      /legacy restore targets to be drained or adopted/,
    );

    const locatorDb = await prerequisiteDatabase({ existingLocator: true });
    await expect(applyMigration(locatorDb)).rejects.toThrow(
      /legacy replacement locators to be drained or adopted/,
    );
  });

  test("requires insert-before-acquire and rejects direct terminal or replay rewrites", async () => {
    const db = await database();
    await expect(
      db.query(
        `INSERT INTO agent_backup_restore_operations
           (id, organization_id, restore_attempt_id, expected_node_id,
            capacity_state, capacity_reserved_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'reserved', now())`,
        [SOURCE_ID, ORGANIZATION_ID, RESTORE_ATTEMPT_ID, NODE_ID],
      ),
    ).rejects.toThrow(/must be acquired after insert/);
    await insertSource(db);
    await expect(
      db.query(
        `UPDATE agent_backup_restore_operations SET
           expected_node_history_id = $1::uuid, expected_node_record_id = $2::uuid,
           expected_node_incarnation = $3::uuid, expected_node_id = $4,
           expected_image_digest = $5, capacity_state = 'handed_off',
           capacity_reserved_at = $6::timestamptz,
           capacity_settled_at = $7::timestamptz,
           capacity_settlement_receipt_digest = $8`,
        [
          NODE_HISTORY_ID,
          NODE_RECORD_ID,
          NODE_INCARNATION,
          NODE_ID,
          IMAGE_DIGEST,
          SOURCE_RESERVED_AT,
          HANDOFF_AT,
          RECEIPT_DIGEST,
        ],
      ),
    ).rejects.toThrow(/null to reserved/);

    await reserveSource(db);
    await expect(
      db.exec("UPDATE agent_backup_restore_operations SET capacity_state = capacity_state"),
    ).rejects.toThrow(/replay must not rewrite/);
    await expect(
      db.exec("UPDATE agent_backup_restore_operations SET expected_node_id = 'other-node'"),
    ).rejects.toThrow(/write-once/);
    await expect(
      db.exec("UPDATE agent_backup_restore_operations SET phase = 'failed_terminal'"),
    ).rejects.toThrow(/capacity_shape_check/);

    await db.query(
      `UPDATE agent_backup_restore_operations SET capacity_state = 'released',
        capacity_settled_at = $1::timestamptz,
        capacity_settlement_receipt_digest = $2`,
      [HANDOFF_AT, RECEIPT_DIGEST],
    );
    await db.exec("UPDATE agent_backup_restore_operations SET phase = 'failed_terminal'");
    await expect(
      db.query(
        `UPDATE agent_backup_restore_operations
         SET capacity_settlement_receipt_digest = $1`,
        ["c".repeat(64)],
      ),
    ).rejects.toThrow(/terminal restore capacity authority is immutable/);
  });

  test("requires exact deferred handoff in one transaction and keeps finalized behind it", async () => {
    const db = await database();
    await insertSource(db);
    await reserveSource(db);
    await insertReceiver(db);

    await expect(
      db.exec("UPDATE agent_backup_restore_operations SET phase = 'finalized'"),
    ).rejects.toThrow(/capacity_shape_check/);

    await db.exec("BEGIN");
    await handoffSource(db);
    await expect(db.exec("COMMIT")).rejects.toThrow(/one exact durable receiver/);

    const exactDb = await database();
    await insertSource(exactDb);
    await reserveSource(exactDb);
    await insertReceiver(exactDb);
    await commitExactHandoff(exactDb);
    await expect(
      exactDb.exec("UPDATE agent_backup_restore_operations SET phase = 'finalized'"),
    ).rejects.toThrow(/finalized restore requires its exact committed capacity receiver/);
    await exactDb.exec(
      "UPDATE agent_sandbox_replacement_attempts SET state = 'provider_succeeded'",
    );
    await recordCandidateCleanup(exactDb);
    await exactDb.exec("BEGIN");
    await commitCanonicalSandbox(exactDb);
    await handoffReceiverLifecycle(exactDb);
    await exactDb.exec("COMMIT");
    await exactDb.exec("UPDATE agent_backup_restore_operations SET phase = 'finalized'");
    const source = await exactDb.query<{ capacity_state: string; phase: string }>(
      "SELECT capacity_state, phase FROM agent_backup_restore_operations",
    );
    expect(source.rows).toEqual([{ capacity_state: "handed_off", phase: "finalized" }]);

    const releasedDb = await database();
    await insertSource(releasedDb);
    await reserveSource(releasedDb);
    await insertReceiver(releasedDb);
    await commitExactHandoff(releasedDb);
    await releasedDb.query(
      `UPDATE agent_sandbox_replacement_attempts SET
        state = 'cleanup_proven', cleanup_proven_at = $1::timestamptz,
        cleanup_receipt_digest = $2, capacity_state = 'released',
        capacity_settled_at = $1::timestamptz,
        capacity_settlement_receipt_digest = $2`,
      [RECEIVER_SETTLED_AT, RECEIPT_DIGEST],
    );
    await expect(
      releasedDb.exec("UPDATE agent_backup_restore_operations SET phase = 'finalized'"),
    ).rejects.toThrow(/one exact durable receiver/);
  });

  test("rejects receiver-only ownership, tuple drift, timestamp drift, and a second receiver", async () => {
    for (const mismatch of [
      {
        nodeHistoryId: OTHER_NODE_HISTORY_ID,
        nodeId: OTHER_NODE_ID,
        nodeIncarnation: OTHER_NODE_INCARNATION,
        nodeRecordId: OTHER_NODE_RECORD_ID,
        reservedAt: HANDOFF_AT,
      },
      { nodeId: NODE_ID, reservedAt: "2026-08-24T10:02:00.000Z" },
    ]) {
      const db = await database();
      await insertSource(db);
      await reserveSource(db);
      await insertReceiver(db);
      await db.exec("BEGIN");
      await handoffSource(db);
      await reserveReceiver(db, mismatch);
      await expect(db.exec("COMMIT")).rejects.toThrow(/exact/);
    }

    const receiverOnlyDb = await database();
    await insertSource(receiverOnlyDb);
    await reserveSource(receiverOnlyDb);
    await insertReceiver(receiverOnlyDb);
    await receiverOnlyDb.exec("BEGIN");
    await reserveReceiver(receiverOnlyDb);
    await expect(receiverOnlyDb.exec("COMMIT")).rejects.toThrow(/handed-off source/);

    const uniqueDb = await database();
    await insertSource(uniqueDb);
    await reserveSource(uniqueDb);
    await insertReceiver(uniqueDb);
    await commitExactHandoff(uniqueDb);
    await insertReceiver(uniqueDb, { id: SECOND_RECEIVER_ID });
    await expect(reserveReceiver(uniqueDb, { id: SECOND_RECEIVER_ID })).rejects.toThrow(
      /restore_capacity_receiver_uidx/,
    );
  });

  test("rejects staged adoption but permits a pre-cutover candidate cleanup fence", async () => {
    const forgedDb = await database();
    await prepareProviderSucceededReceiver(forgedDb);
    await forgedDb.exec("BEGIN");
    await expect(
      commitCanonicalSandbox(forgedDb, { cleanupSandboxId: "forged-old-sandbox" }),
    ).rejects.toThrow(/protocol does not match/);
    await forgedDb.exec("ROLLBACK");

    const stagedDb = await database();
    await prepareProviderSucceededReceiver(stagedDb);
    await stagedDb.exec("BEGIN");
    await commitCanonicalSandbox(stagedDb);
    await expect(stagedDb.exec("COMMIT")).rejects.toThrow(
      /fresh candidate or handoff|durable attempt authority/,
    );
    const rolledBack = await stagedDb.query<{
      replacement_cleanup_attempt_id: string | null;
      sandbox_id: string;
      state: string;
    }>(`SELECT sandbox.sandbox_id, sandbox.replacement_cleanup_attempt_id, attempt.state
      FROM agent_sandboxes AS sandbox
      JOIN agent_sandbox_replacement_attempts AS attempt ON attempt.agent_id = sandbox.id`);
    expect(rolledBack.rows).toEqual([
      {
        replacement_cleanup_attempt_id: RECEIVER_ID,
        sandbox_id: "old-sandbox",
        state: "provider_succeeded",
      },
    ]);
    await expect(handoffReceiverLifecycle(stagedDb)).rejects.toThrow(/exact canonical.*placement/);

    const candidateDb = await database();
    await prepareProviderSucceededReceiver(candidateDb);
    await recordCandidateCleanup(candidateDb);
    const candidate = await candidateDb.query<{
      replacement_cleanup_sandbox_id: string;
      sandbox_id: string;
      state: string;
    }>(`
      SELECT sandbox.sandbox_id, sandbox.replacement_cleanup_sandbox_id, attempt.state
      FROM agent_sandboxes AS sandbox
      JOIN agent_sandbox_replacement_attempts AS attempt ON attempt.agent_id = sandbox.id
    `);
    expect(candidate.rows).toEqual([
      {
        replacement_cleanup_sandbox_id: LOCATOR_SANDBOX_ID,
        sandbox_id: "old-sandbox",
        state: "provider_succeeded",
      },
    ]);
  });

  test("rejects tenant-identity toggles used to hide placement drift", async () => {
    for (const [identityColumn, temporaryIdentity, originalIdentity] of [
      ["id", SECOND_RECEIVER_ID, AGENT_ID],
      ["organization_id", OTHER_ORGANIZATION_ID, ORGANIZATION_ID],
    ] as const) {
      const db = await database();
      await db.exec("BEGIN");
      await db.exec(`UPDATE agent_sandboxes SET ${identityColumn} = '${temporaryIdentity}'::uuid`);
      await db.exec(`UPDATE agent_sandboxes SET
        sandbox_id = 'hidden-sandbox', node_id = 'hidden-node',
        container_name = 'hidden-container'
      `);
      await db.exec(`UPDATE agent_sandboxes SET ${identityColumn} = '${originalIdentity}'::uuid`);
      await expect(db.exec("COMMIT")).rejects.toThrow(/tenant identity is immutable/);
    }
  });

  test("rejects candidate cleanup core drift while allowing monotone remote enrichment", async () => {
    const db = await database();
    await insertReceiver(db, { restoreAttemptId: null });
    await reserveReceiver(db, { vpnIntent: true });
    await recordCandidateCleanup(db, { vpnIntent: true });
    await enrichCandidateVpn(db, "123456");
    await db.exec("UPDATE agent_sandbox_replacement_attempts SET state = 'provider_succeeded'");
    await expect(
      db.exec(`UPDATE agent_sandboxes SET
        replacement_cleanup_sandbox_id = 'drifted-sandbox',
        replacement_cleanup_node_id = 'drifted-node',
        replacement_cleanup_container_name = 'drifted-container'
      `),
    ).rejects.toThrow(/exact current node occurrence|not fresh candidate or handoff/);

    const retained = await db.query<{
      replacement_cleanup_container_id: string;
      replacement_cleanup_node_id: string;
      replacement_cleanup_sandbox_id: string;
      replacement_cleanup_vpn_node_id: string;
      replacement_cleanup_vpn_node_name: string;
    }>(`SELECT replacement_cleanup_sandbox_id, replacement_cleanup_node_id,
      replacement_cleanup_container_id, replacement_cleanup_vpn_node_id,
      replacement_cleanup_vpn_node_name
      FROM agent_sandboxes`);
    expect(retained.rows).toEqual([
      {
        replacement_cleanup_container_id: LOCATOR_CONTAINER_ID,
        replacement_cleanup_node_id: NODE_ID,
        replacement_cleanup_sandbox_id: LOCATOR_SANDBOX_ID,
        replacement_cleanup_vpn_node_id: "123456",
        replacement_cleanup_vpn_node_name: LOCATOR_VPN_NODE_NAME,
      },
    ]);
  });

  test("blocks untracked X-to-Y staging before or after attempt start", async () => {
    for (const startAttemptFirst of [false, true]) {
      const db = await database();
      if (startAttemptFirst) await prepareProviderSucceededReceiver(db);
      await db.exec("BEGIN");
      await db.exec(`UPDATE agent_sandboxes SET
        sandbox_id = '${LOCATOR_SANDBOX_ID}', node_id = '${NODE_ID}',
        container_name = '${LOCATOR_SANDBOX_ID}', lifecycle_revision = 8
      `);
      await expect(db.exec("COMMIT")).rejects.toThrow(/fresh .*previous/);
      const canonical = await db.query<{ sandbox_id: string }>(
        "SELECT sandbox_id FROM agent_sandboxes",
      );
      expect(canonical.rows).toEqual([{ sandbox_id: "old-sandbox" }]);
    }

    for (const lifecycleRevision of [ATTEMPT_LIFECYCLE_REVISION, 19]) {
      const db = await prerequisiteDatabase();
      await db.query(
        `UPDATE agent_sandboxes SET sandbox_id = $1, node_id = $2,
          container_name = $1, lifecycle_revision = $3`,
        [LOCATOR_SANDBOX_ID, NODE_ID, lifecycleRevision],
      );
      await applyMigration(db);
      const lateBinding = `UPDATE agent_sandboxes SET
        replacement_cleanup_sandbox_id = '${LOCATOR_SANDBOX_ID}',
        replacement_cleanup_node_id = '${NODE_ID}',
        replacement_cleanup_container_name = '${LOCATOR_SANDBOX_ID}',
        replacement_cleanup_attempt_id = '${RECEIVER_ID}'::uuid,
        replacement_cleanup_allocation_counted = TRUE,
        replacement_cleanup_created_at = '${RECEIVER_SETTLED_AT}'::timestamptz,
        lifecycle_revision = lifecycle_revision + 1`;
      await expect(db.exec(lateBinding)).rejects.toThrow(
        /replacement_cleanup_occurrence_check|not fresh candidate or handoff/,
      );
      await insertReceiver(db, { lifecycleRevision, restoreAttemptId: null });
      await reserveReceiver(db);
      await db.exec("UPDATE agent_sandbox_replacement_attempts SET state = 'provider_succeeded'");
      await expect(db.exec(lateBinding)).rejects.toThrow(
        /replacement_cleanup_occurrence_check|not fresh candidate or handoff/,
      );
      await expect(handoffReceiverLifecycle(db)).rejects.toThrow(/exact canonical.*placement/);
    }
  });

  test("requires the exact canonical sandbox CAS before lifecycle capacity handoff", async () => {
    const noCasDb = await database();
    await prepareProviderSucceededReceiver(noCasDb);
    await noCasDb.exec("BEGIN");
    await handoffReceiverLifecycle(noCasDb);
    await expect(noCasDb.exec("COMMIT")).rejects.toThrow(/exact canonical.*placement/);

    for (const mismatch of [
      { sandboxId: "wrong-sandbox" },
      { lifecycleRevision: ATTEMPT_LIFECYCLE_REVISION + 2 },
      { activationGeneration: OTHER_NODE_INCARNATION },
      { lifecycleJobId: OTHER_NODE_HISTORY_ID },
      { allocationCounted: false },
      { deletionAttemptId: OTHER_NODE_HISTORY_ID },
      { cleanupAttemptId: null },
      { cleanupAllocationCounted: false },
      { cleanupSandboxId: "fake-old-sandbox" },
    ] as const) {
      const db = await database();
      await prepareProviderSucceededReceiver(db);
      await expect(
        (async () => {
          await db.exec("BEGIN");
          await commitCanonicalSandbox(db, mismatch);
          await handoffReceiverLifecycle(db);
          await db.exec("COMMIT");
        })(),
      ).rejects.toThrow(
        /exact canonical.*placement|fresh .*previous|durable attempt authority|fresh candidate or handoff|protocol does not match|replacement_cleanup_(?:occurrence|locator)_check/,
      );
    }

    const exactDb = await database();
    await prepareProviderSucceededReceiver(exactDb);
    await exactDb.exec("BEGIN");
    await commitCanonicalSandbox(exactDb);
    await handoffReceiverLifecycle(exactDb);
    await exactDb.exec("COMMIT");
    const committed = await exactDb.query<{ capacity_state: string; state: string }>(
      "SELECT state, capacity_state FROM agent_sandbox_replacement_attempts",
    );
    expect(committed.rows).toEqual([
      { capacity_state: "handed_off", state: "lifecycle_committed" },
    ]);
    await expect(
      exactDb.exec("UPDATE agent_sandboxes SET replacement_cleanup_sandbox_id = 'fake-previous'"),
    ).rejects.toThrow(
      /pending replacement cleanup permits only monotone remote enrichment|replacement cleanup protocol does not match cutover state/,
    );
    await expect(
      exactDb.exec(
        `UPDATE agent_sandboxes SET replacement_cleanup_container_id = '${"b".repeat(64)}'`,
      ),
    ).rejects.toThrow(/pending replacement cleanup permits only monotone remote enrichment/);
    await expect(
      exactDb.exec("UPDATE agent_sandboxes SET sandbox_id = 'later-drift'"),
    ).rejects.toThrow(
      /pending replacement cleanup may only be cleared exactly|replacement cleanup does not match its durable attempt authority/,
    );
    await clearReplacementCleanup(exactDb);
    const cleared = await exactDb.query<{ replacement_cleanup_attempt_id: string | null }>(
      "SELECT replacement_cleanup_attempt_id FROM agent_sandboxes",
    );
    expect(cleared.rows).toEqual([{ replacement_cleanup_attempt_id: null }]);
    await expect(
      exactDb.exec(`UPDATE agent_sandboxes SET
        sandbox_id = 'unreserved-sandbox', node_id = 'unreserved-node',
        container_name = 'unreserved-container'
      `),
    ).rejects.toThrow(/fresh .*previous/);
    await expect(
      exactDb.exec(`UPDATE agent_sandboxes SET
        replacement_cleanup_sandbox_id = '${LOCATOR_SANDBOX_ID}',
        replacement_cleanup_node_id = '${NODE_ID}',
        replacement_cleanup_container_name = '${LOCATOR_SANDBOX_ID}',
        replacement_cleanup_attempt_id = '${RECEIVER_ID}'::uuid,
        replacement_cleanup_allocation_counted = TRUE,
        replacement_cleanup_created_at = '${RECEIVER_SETTLED_AT}'::timestamptz
      `),
    ).rejects.toThrow(/not fresh candidate or handoff|replacement_cleanup_occurrence_check/);
    const notResurrected = await exactDb.query<{
      replacement_cleanup_attempt_id: string | null;
    }>("SELECT replacement_cleanup_attempt_id FROM agent_sandboxes");
    expect(notResurrected.rows).toEqual([{ replacement_cleanup_attempt_id: null }]);
  });

  test("rejects mutable-core forgery that disagrees with the previous publication", async () => {
    const db = await prerequisiteDatabase();
    await db.query(
      `UPDATE agent_sandboxes SET sandbox_id = $1, node_id = $2, container_name = $1`,
      [LOCATOR_SANDBOX_ID, NODE_ID],
    );
    await applyMigration(db);
    await expect(prepareProviderSucceededReceiver(db)).rejects.toThrow(
      /fresh candidate or handoff authority/,
    );
    const retained = await db.query<{ sandbox_id: string }>(
      "SELECT sandbox_id FROM agent_sandboxes",
    );
    expect(retained.rows).toEqual([{ sandbox_id: LOCATOR_SANDBOX_ID }]);
  });

  test("allows a later exact replacement, reactivation, and node reincarnation", async () => {
    const replacementDb = await database();
    await prepareProviderSucceededReceiver(replacementDb);
    await replacementDb.exec("BEGIN");
    await commitCanonicalSandbox(replacementDb);
    await handoffReceiverLifecycle(replacementDb);
    await replacementDb.exec("COMMIT");
    await clearReplacementCleanup(replacementDb);
    await replacementDb.exec(`
      INSERT INTO docker_nodes (
        id, node_id, node_incarnation, current_node_history_id, allocated_count
      ) VALUES (
        '${OTHER_NODE_RECORD_ID}', '${OTHER_NODE_ID}', '${OTHER_NODE_INCARNATION}',
        '${OTHER_NODE_HISTORY_ID}', 1
      )
    `);
    await replacementDb.exec(`UPDATE agent_sandboxes
      SET activation_generation = '${NEXT_ACTIVATION_GENERATION}'::uuid`);
    await replacementDb.exec(`INSERT INTO agent_activation_publications (
      id, organization_id, agent_id, activation_generation, container_id,
      node_history_id, docker_node_record_id, node_id, node_incarnation
    ) VALUES ('e0000000-0000-4000-8000-000000000002', '${ORGANIZATION_ID}',
      '${AGENT_ID}', '${NEXT_ACTIVATION_GENERATION}', '${LOCATOR_CONTAINER_ID}',
      '${NODE_HISTORY_ID}', '${NODE_RECORD_ID}', '${NODE_ID}', '${NODE_INCARNATION}')`);
    await insertReceiver(replacementDb, {
      activationGeneration: NEXT_ACTIVATION_GENERATION,
      id: SECOND_RECEIVER_ID,
      lifecycleRevision: ATTEMPT_LIFECYCLE_REVISION + 1,
      previousPlacement: "current",
      restoreAttemptId: null,
    });
    await reserveReceiver(replacementDb, {
      containerId: SECOND_LOCATOR_CONTAINER_ID,
      id: SECOND_RECEIVER_ID,
      nodeHistoryId: OTHER_NODE_HISTORY_ID,
      nodeId: OTHER_NODE_ID,
      nodeIncarnation: OTHER_NODE_INCARNATION,
      nodeRecordId: OTHER_NODE_RECORD_ID,
      sandboxId: "next-sandbox",
    });
    await replacementDb.query(
      `UPDATE agent_sandbox_replacement_attempts SET state = 'provider_succeeded'
       WHERE id = $1::uuid`,
      [SECOND_RECEIVER_ID],
    );
    await recordCandidateCleanup(replacementDb, {
      attemptId: SECOND_RECEIVER_ID,
      containerId: SECOND_LOCATOR_CONTAINER_ID,
      nodeHistoryId: OTHER_NODE_HISTORY_ID,
      nodeId: OTHER_NODE_ID,
      nodeIncarnation: OTHER_NODE_INCARNATION,
      nodeRecordId: OTHER_NODE_RECORD_ID,
      sandboxId: "next-sandbox",
    });
    await replacementDb.exec("BEGIN");
    await commitCanonicalSandbox(replacementDb, {
      activationGeneration: NEXT_ACTIVATION_GENERATION,
      cleanupAttemptId: SECOND_RECEIVER_ID,
      cleanupContainerName: LOCATOR_SANDBOX_ID,
      cleanupNodeId: NODE_ID,
      cleanupSandboxId: LOCATOR_SANDBOX_ID,
      lifecycleRevision: ATTEMPT_LIFECYCLE_REVISION + 2,
      nodeId: OTHER_NODE_ID,
      sandboxId: "next-sandbox",
    });
    await handoffReceiverLifecycle(replacementDb, SECOND_RECEIVER_ID);
    await replacementDb.exec("COMMIT");
    const replacement = await replacementDb.query<{
      capacity_state: string;
      replacement_cleanup_sandbox_id: string;
      sandbox_id: string;
    }>(`
      SELECT attempt.capacity_state, sandbox.sandbox_id,
        sandbox.replacement_cleanup_sandbox_id
      FROM agent_sandbox_replacement_attempts AS attempt
      JOIN agent_sandboxes AS sandbox ON sandbox.id = attempt.agent_id
      WHERE attempt.id = '${SECOND_RECEIVER_ID}'::uuid
    `);
    expect(replacement.rows).toEqual([
      {
        capacity_state: "handed_off",
        replacement_cleanup_sandbox_id: LOCATOR_SANDBOX_ID,
        sandbox_id: "next-sandbox",
      },
    ]);

    const reactivationDb = await database();
    await prepareProviderSucceededReceiver(reactivationDb);
    await reactivationDb.exec("BEGIN");
    await commitCanonicalSandbox(reactivationDb);
    await handoffReceiverLifecycle(reactivationDb);
    await reactivationDb.exec("COMMIT");
    await clearReplacementCleanup(reactivationDb);
    await reactivationDb.exec(`UPDATE agent_sandboxes SET
      activation_generation = '${OTHER_NODE_INCARNATION}'::uuid,
      sandbox_id = 'reactivated-sandbox', node_id = 'reactivated-node',
      container_name = 'reactivated-container'
    `);

    const rebootDb = await database();
    await prepareProviderSucceededReceiver(rebootDb);
    await rebootDb.exec("BEGIN");
    await commitCanonicalSandbox(rebootDb);
    await handoffReceiverLifecycle(rebootDb);
    await rebootDb.exec("COMMIT");
    await clearReplacementCleanup(rebootDb);
    await rebootDb.exec(`UPDATE docker_nodes SET
      id = '${REUSED_NODE_RECORD_ID}'::uuid,
      node_incarnation = '${REUSED_NODE_INCARNATION}'::uuid,
      current_node_history_id = '${REUSED_NODE_HISTORY_ID}'::uuid
      WHERE id = '${NODE_RECORD_ID}'::uuid
    `);
    await rebootDb.exec("UPDATE agent_sandboxes SET status = 'running'");
  });

  test("rejects a stale or uncounted current Docker-node occurrence", async () => {
    const staleDb = await database();
    await prepareProviderSucceededReceiver(staleDb);
    await staleDb.exec("BEGIN");
    await staleDb.exec(`DELETE FROM docker_nodes WHERE id = '${NODE_RECORD_ID}'::uuid`);
    await staleDb.exec(`
      INSERT INTO docker_nodes (
        id, node_id, node_incarnation, current_node_history_id, allocated_count
      ) VALUES (
        '${REUSED_NODE_RECORD_ID}', '${NODE_ID}', '${REUSED_NODE_INCARNATION}',
        '${REUSED_NODE_HISTORY_ID}', 1
      )
    `);
    await commitCanonicalSandbox(staleDb);
    await handoffReceiverLifecycle(staleDb);
    await expect(staleDb.exec("COMMIT")).rejects.toThrow(/exact canonical.*placement/);

    const uncountedDb = await database();
    await prepareProviderSucceededReceiver(uncountedDb);
    await uncountedDb.exec("BEGIN");
    await uncountedDb.exec(
      `UPDATE docker_nodes SET allocated_count = 0 WHERE id = '${NODE_RECORD_ID}'::uuid`,
    );
    await commitCanonicalSandbox(uncountedDb);
    await handoffReceiverLifecycle(uncountedDb);
    await expect(uncountedDb.exec("COMMIT")).rejects.toThrow(/exact canonical.*placement/);
  });

  test("requires ledger handoff for full replacements but allows stop then provision", async () => {
    const db = await database();
    await expect(
      db.exec(`UPDATE agent_sandboxes SET
        sandbox_id = 'legacy-new-sandbox',
        node_id = 'legacy-new-node',
        container_name = 'legacy-new-container'
      `),
    ).rejects.toThrow(/fresh .*previous/);
    await db.exec(`UPDATE agent_sandboxes SET
      sandbox_id = NULL, node_id = NULL, container_name = NULL, status = 'stopped'
    `);
    await db.exec(`UPDATE agent_sandboxes SET
      sandbox_id = 'provisioned-sandbox', node_id = 'provisioned-node',
      container_name = 'provisioned-container', status = 'running'
    `);
    const sandbox = await db.query<{
      container_name: string;
      node_id: string;
      sandbox_id: string;
    }>("SELECT sandbox_id, node_id, container_name FROM agent_sandboxes");
    expect(sandbox.rows).toEqual([
      {
        container_name: "provisioned-container",
        node_id: "provisioned-node",
        sandbox_id: "provisioned-sandbox",
      },
    ]);
  });

  test("rejects partial placement bridges across transactions", async () => {
    const sameActivationDb = await database();
    await sameActivationDb.exec("BEGIN");
    await sameActivationDb.exec("UPDATE agent_sandboxes SET container_name = NULL");
    await expect(sameActivationDb.exec("COMMIT")).rejects.toThrow(/fresh .*previous/);
    const retained = await sameActivationDb.query<{
      container_name: string;
      node_id: string;
      sandbox_id: string;
    }>("SELECT sandbox_id, node_id, container_name FROM agent_sandboxes");
    expect(retained.rows).toEqual([
      { container_name: "old-container", node_id: "old-node", sandbox_id: "old-sandbox" },
    ]);

    const bridgeDb = await database();
    await bridgeDb.exec(`UPDATE agent_sandboxes SET
      activation_generation = '${OTHER_NODE_INCARNATION}'::uuid,
      container_name = NULL
    `);
    await expect(
      bridgeDb.exec(`UPDATE agent_sandboxes SET
        sandbox_id = 'bridged-sandbox', node_id = 'bridged-node',
        container_name = 'bridged-container'
      `),
    ).rejects.toThrow(/fresh .*previous/);
    await expect(
      bridgeDb.exec("UPDATE agent_sandboxes SET node_id = 'mutated-partial-node'"),
    ).rejects.toThrow(/fresh .*previous/);
    await bridgeDb.exec(`UPDATE agent_sandboxes SET
      sandbox_id = NULL, node_id = NULL, container_name = NULL, status = 'stopped'
    `);
    await expect(
      bridgeDb.exec("UPDATE agent_sandboxes SET sandbox_id = 'still-partial'"),
    ).rejects.toThrow(/fresh .*previous/);
    await bridgeDb.exec(`UPDATE agent_sandboxes SET
      sandbox_id = 'reprovisioned-sandbox', node_id = 'reprovisioned-node',
      container_name = 'reprovisioned-container', status = 'running'
    `);
  });

  test("rejects invented logical node ids on both capacity ledgers", async () => {
    const sourceDb = await database();
    await insertSource(sourceDb);
    await expect(reserveSource(sourceDb, "invented-node-id")).rejects.toThrow(
      /agent_backup_restore_operations_node_occurrence_fkey/,
    );

    const receiverDb = await database();
    await insertReceiver(receiverDb, { restoreAttemptId: null });
    await expect(reserveReceiver(receiverDb, { nodeId: "invented-node-id" })).rejects.toThrow(
      /agent_sandbox_replacement_attempts_node_occurrence_fkey/,
    );
  });

  test("enforces replacement settlement states while allowing cleanup without a locator", async () => {
    const db = await database();
    await insertReceiver(db, { restoreAttemptId: null });
    await reserveReceiver(db);
    await expect(
      db.query(
        `UPDATE agent_sandbox_replacement_attempts SET
          capacity_state = 'handed_off', capacity_settled_at = $1::timestamptz,
          capacity_settlement_receipt_digest = $2`,
        [RECEIVER_SETTLED_AT, RECEIPT_DIGEST],
      ),
    ).rejects.toThrow(/capacity_shape_check/);
    await expect(
      db.query(
        `UPDATE agent_sandbox_replacement_attempts SET
          capacity_state = 'released', capacity_settled_at = $1::timestamptz,
          capacity_settlement_receipt_digest = $2`,
        [RECEIVER_SETTLED_AT, RECEIPT_DIGEST],
      ),
    ).rejects.toThrow(/capacity_shape_check/);
    await expect(
      db.exec("UPDATE agent_sandbox_replacement_attempts SET state = 'lifecycle_committed'"),
    ).rejects.toThrow(/capacity_shape_check/);
    await db.exec("UPDATE agent_sandbox_replacement_attempts SET state = 'provider_succeeded'");
    await recordCandidateCleanup(db);
    await db.exec("BEGIN");
    await commitCanonicalSandbox(db);
    await handoffReceiverLifecycle(db);
    await db.exec("COMMIT");
    await expect(
      db.exec("UPDATE agent_sandbox_replacement_attempts SET capacity_state = capacity_state"),
    ).rejects.toThrow(/replay must not rewrite|terminal replacement capacity authority/);

    const cleanupDb = await database();
    await insertReceiver(cleanupDb, { restoreAttemptId: null });
    await reserveReceiver(cleanupDb);
    await expect(
      cleanupDb.exec("UPDATE agent_sandbox_replacement_attempts SET state = 'cleanup_proven'"),
    ).rejects.toThrow(/capacity_shape_check/);
    await cleanupDb.query(
      `UPDATE agent_sandbox_replacement_attempts SET
        state = 'cleanup_proven', cleanup_proven_at = $1::timestamptz,
        cleanup_receipt_digest = $2, capacity_state = 'released',
        capacity_settled_at = $1::timestamptz,
        capacity_settlement_receipt_digest = $2`,
      [RECEIVER_SETTLED_AT, RECEIPT_DIGEST],
    );

    const noLocatorDb = await database();
    await insertReceiver(noLocatorDb, { restoreAttemptId: null });
    await noLocatorDb.query(
      `UPDATE agent_sandbox_replacement_attempts SET state = 'cleanup_proven',
        cleanup_proven_at = $1::timestamptz, cleanup_receipt_digest = $2`,
      [RECEIVER_SETTLED_AT, RECEIPT_DIGEST],
    );
    const noLocator = await noLocatorDb.query<{
      capacity_state: string | null;
      state: string;
    }>("SELECT state, capacity_state FROM agent_sandbox_replacement_attempts");
    expect(noLocator.rows).toEqual([{ capacity_state: null, state: "cleanup_proven" }]);
  });

  test("binds replacement capacity timestamps and digests to their durable proofs", async () => {
    const reservationDb = await database();
    await insertReceiver(reservationDb, { restoreAttemptId: null });
    await expect(
      reservationDb.query(
        `UPDATE agent_sandbox_replacement_attempts SET
          locator_node_id = $1, locator_node_record_id = $2::uuid,
          locator_node_incarnation = $3::uuid, locator_node_history_id = $4::uuid,
          locator_recorded_at = $5::timestamptz, capacity_state = 'reserved',
          capacity_reserved_at = $6::timestamptz
         WHERE id = $7::uuid`,
        [
          NODE_ID,
          NODE_RECORD_ID,
          NODE_INCARNATION,
          NODE_HISTORY_ID,
          HANDOFF_AT,
          SOURCE_RESERVED_AT,
          RECEIVER_ID,
        ],
      ),
    ).rejects.toThrow(/capacity_shape_check/);

    for (const mismatch of [
      {
        capacityDigest: RECEIPT_DIGEST,
        capacitySettledAt: "2026-08-24T10:03:00.000Z",
        proofDigest: RECEIPT_DIGEST,
        proofSettledAt: RECEIVER_SETTLED_AT,
        state: "lifecycle_committed",
      },
      {
        capacityDigest: "c".repeat(64),
        capacitySettledAt: RECEIVER_SETTLED_AT,
        proofDigest: RECEIPT_DIGEST,
        proofSettledAt: RECEIVER_SETTLED_AT,
        state: "lifecycle_committed",
      },
      {
        capacityDigest: RECEIPT_DIGEST,
        capacitySettledAt: "2026-08-24T10:03:00.000Z",
        proofDigest: RECEIPT_DIGEST,
        proofSettledAt: RECEIVER_SETTLED_AT,
        state: "cleanup_proven",
      },
      {
        capacityDigest: "c".repeat(64),
        capacitySettledAt: RECEIVER_SETTLED_AT,
        proofDigest: RECEIPT_DIGEST,
        proofSettledAt: RECEIVER_SETTLED_AT,
        state: "cleanup_proven",
      },
    ] as const) {
      const db = await database();
      await insertReceiver(db, { restoreAttemptId: null });
      await reserveReceiver(db);
      const capacityState = mismatch.state === "lifecycle_committed" ? "handed_off" : "released";
      const proofTimestampColumn =
        mismatch.state === "lifecycle_committed" ? "lifecycle_committed_at" : "cleanup_proven_at";
      const proofDigestColumn =
        mismatch.state === "lifecycle_committed"
          ? "lifecycle_receipt_digest"
          : "cleanup_receipt_digest";
      await expect(
        db.query(
          `UPDATE agent_sandbox_replacement_attempts SET
            state = $1, ${proofTimestampColumn} = $2::timestamptz,
            ${proofDigestColumn} = $3, capacity_state = $4,
            capacity_settled_at = $5::timestamptz,
            capacity_settlement_receipt_digest = $6
           WHERE id = $7::uuid`,
          [
            mismatch.state,
            mismatch.proofSettledAt,
            mismatch.proofDigest,
            capacityState,
            mismatch.capacitySettledAt,
            mismatch.capacityDigest,
            RECEIVER_ID,
          ],
        ),
      ).rejects.toThrow(/capacity_shape_check/);
    }
  });

  test("rejects deleting reserved owners but permits settled standalone erasure", async () => {
    const sourceDb = await database();
    await insertSource(sourceDb);
    await reserveSource(sourceDb);
    await expect(
      sourceDb.query("DELETE FROM agent_backup_restore_operations WHERE id = $1::uuid", [
        SOURCE_ID,
      ]),
    ).rejects.toThrow(/owned restore capacity cannot be deleted before settlement/);

    const receiverDb = await database();
    await insertReceiver(receiverDb, { restoreAttemptId: null });
    await reserveReceiver(receiverDb);
    await expect(
      receiverDb.query("DELETE FROM agent_sandbox_replacement_attempts WHERE id = $1::uuid", [
        RECEIVER_ID,
      ]),
    ).rejects.toThrow(/reserved replacement capacity cannot be deleted before settlement/);

    await receiverDb.query(
      `UPDATE agent_sandbox_replacement_attempts SET
        state = 'cleanup_proven', cleanup_proven_at = $1::timestamptz,
        cleanup_receipt_digest = $2, capacity_state = 'released',
        capacity_settled_at = $1::timestamptz,
        capacity_settlement_receipt_digest = $2`,
      [RECEIVER_SETTLED_AT, RECEIPT_DIGEST],
    );
    await receiverDb.query("DELETE FROM agent_sandbox_replacement_attempts WHERE id = $1::uuid", [
      RECEIVER_ID,
    ]);
    const remaining = await receiverDb.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agent_sandbox_replacement_attempts",
    );
    expect(remaining.rows).toEqual([{ count: "0" }]);
  });

  test("binds restore-linked receivers to an existing same-tenant operation", async () => {
    const db = await database();
    await expect(insertReceiver(db)).rejects.toThrow(/restore_operation_fkey/);
    await insertSource(db);
    await insertReceiver(db);
  });
});

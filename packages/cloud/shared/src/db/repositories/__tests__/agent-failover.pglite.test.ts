/**
 * Real-PGlite proofs for the node-failure records and failover state contracts.
 *
 * The harness is the repository's own PGlite client, schema-created by the two
 * committed migrations, so the hand-reviewed DDL and the guard triggers under
 * test are the artifacts that ship. Prerequisite tables are minimal stand-ins for
 * `organizations`, `docker_nodes`, `agent_node_incarnation_histories`,
 * `agent_sandboxes`, and `agent_activation_publications`; the publications are
 * the authority the freeze reads, so their shape matters even though their
 * contents are fixture data.
 *
 * PGlite is a single in-process session, so this suite proves the *contracts* and
 * the guards: a trigger needs cross-class agreement, the frozen set comes from
 * publications rather than the node handle, steps advance one at a time, a stale
 * executor is refused, and a committed cutover cannot be cancelled. Independent
 * sessions contending on the same rows are proved separately in
 * `agent-failover-postgres.integration.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../client";
import { AgentFailoverConflictError, agentFailoverRepository } from "../agent-failover";

const TIMEOUT = 120_000;

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_NODE_ID = "20000000-0000-4000-8000-000000000001";
const TARGET_NODE_ID = "20000000-0000-4000-8000-000000000002";
const SOURCE_NODE_HANDLE = "node-alpha";
const TARGET_NODE_HANDLE = "node-beta";
const SOURCE_INCARNATION = "30000000-0000-4000-8000-000000000001";
const SOURCE_HISTORY_ID = "40000000-0000-4000-8000-000000000001";
const TARGET_INCARNATION = "30000000-0000-4000-8000-000000000002";
const TARGET_HISTORY_ID = "40000000-0000-4000-8000-000000000002";
const AGENT_ID = "50000000-0000-4000-8000-000000000001";
const OTHER_AGENT_ID = "50000000-0000-4000-8000-000000000002";
const STRANGER_AGENT_ID = "50000000-0000-4000-8000-000000000003";
const SOURCE_GENERATION = "60000000-0000-4000-8000-000000000001";
const SOURCE_PUBLICATION_ID = "70000000-0000-4000-8000-000000000001";
const TARGET_GENERATION = "60000000-0000-4000-8000-000000000002";
const TARGET_PUBLICATION_ID = "70000000-0000-4000-8000-000000000002";
const STRANGER_PUBLICATION_ID = "70000000-0000-4000-8000-000000000003";
const STRANGER_GENERATION = "60000000-0000-4000-8000-000000000003";
const BACKUP_ID = "80000000-0000-4000-8000-000000000001";
const SOURCE_CONTAINER_ID = "a".repeat(64);
const TARGET_CONTAINER_ID = "b".repeat(64);
const SOURCE_RECEIPT_SHA = "c".repeat(64);
const TARGET_RECEIPT_SHA = "d".repeat(64);
const MANIFEST_SHA = "e".repeat(64);
const RESTORE_OPERATION_ID = "90000000-0000-4000-8000-000000000001";
const RESTORE_LEASE_ID = "90000000-0000-4000-8000-000000000002";
const RESTORE_LEASE_GENERATION = "90000000-0000-4000-8000-000000000003";
const RESTORE_LEASE_OWNER = "restore-worker";
const RESTORE_ATTEMPT_ID = "90000000-0000-4000-8000-000000000004";
const RESTORE_LEASE_ID_SECOND = "90000000-0000-4000-8000-000000000005";
const RESTORE_LEASE_GENERATION_SECOND = "90000000-0000-4000-8000-000000000006";
const RESTORE_OPERATION_ID_SECOND = "90000000-0000-4000-8000-000000000007";
const RESTORE_ATTEMPT_ID_SECOND = "90000000-0000-4000-8000-000000000008";
const SOURCE_LIFECYCLE_REVISION = 7;
const TARGET_LIFECYCLE_REVISION = 9;

const migrationSql = [
  readFileSync(
    new URL("../../migrations/0387_agent_failover_records.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../../migrations/0388_agent_failover_guards.sql", import.meta.url), "utf8"),
];

const PREREQUISITE_SQL = `
  CREATE TABLE IF NOT EXISTS organizations (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE IF NOT EXISTS docker_nodes (
    id uuid PRIMARY KEY,
    node_id text NOT NULL UNIQUE,
    hostname text NOT NULL,
    capacity integer NOT NULL DEFAULT 8,
    enabled boolean NOT NULL DEFAULT true,
    placement_state text NOT NULL DEFAULT 'open',
    status text NOT NULL DEFAULT 'healthy',
    allocated_count integer NOT NULL DEFAULT 0,
    node_incarnation uuid,
    current_node_history_id uuid,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS agent_node_incarnation_histories (
    id uuid PRIMARY KEY,
    docker_node_record_id uuid NOT NULL,
    node_id text NOT NULL,
    node_incarnation uuid NOT NULL,
    fleet_kind text NOT NULL,
    infrastructure_provider text NOT NULL,
    provider_server_id text,
    host_key_fingerprint text NOT NULL,
    attested_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (id, docker_node_record_id, node_incarnation)
  );
  CREATE TABLE IF NOT EXISTS agent_sandboxes (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    node_id text,
    container_name text,
    activation_generation uuid,
    lifecycle_revision bigint NOT NULL DEFAULT 0,
    UNIQUE (id, organization_id)
  );
  CREATE TABLE IF NOT EXISTS agent_backup_restore_operations (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    backup_id uuid NOT NULL,
    restore_attempt_id uuid NOT NULL,
    lease_id uuid NOT NULL,
    lease_generation uuid NOT NULL,
    lease_owner_id text NOT NULL,
    expected_manifest_sha256 text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_backup_restore_leases (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    backup_id uuid NOT NULL,
    owner_id text NOT NULL,
    generation uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL DEFAULT now() + interval '1 hour',
    released_at timestamp with time zone
  );
  CREATE TABLE IF NOT EXISTS agent_sandbox_replacement_attempts (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    restore_operation_id uuid,
    restore_lease_id uuid,
    restore_lease_owner_id text,
    restore_lease_generation uuid,
    restore_backup_id uuid,
    cleanup_proven_at timestamp with time zone,
    cleanup_receipt_digest text
  );
  CREATE TABLE IF NOT EXISTS agent_activation_publications (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    activation_generation uuid NOT NULL,
    purpose text NOT NULL,
    backup_id uuid,
    backup_manifest_sha256 text,
    activation_receipt_sha256 text NOT NULL,
    previous_activation_generation uuid,
    lifecycle_revision numeric(20, 0) NOT NULL,
    container_id text NOT NULL,
    node_history_id uuid NOT NULL,
    docker_node_record_id uuid NOT NULL,
    node_id text NOT NULL,
    node_incarnation uuid NOT NULL,
    UNIQUE (organization_id, agent_id, activation_generation)
  );
`;

interface SqlRunner {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

async function applyStatements(source: string): Promise<void> {
  const database = getPgliteClientForTests() as unknown as SqlRunner;
  await database.transaction(async (tx) => {
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) await tx.exec(statement);
    }
  });
}

function database(): SqlRunner {
  return getPgliteClientForTests() as unknown as SqlRunner;
}

async function scalar<T>(source: string): Promise<T | undefined> {
  const result = await database().query<T>(source);
  return result.rows[0];
}

/**
 * Asserts a write was refused by a schema guard. Drizzle wraps driver errors, so
 * the PostgreSQL message is matched anywhere in the cause chain.
 */
async function expectGuardRefusal(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const chain: string[] = [];
    let cursor: unknown = error;
    for (let depth = 0; depth < 6 && cursor; depth += 1) {
      chain.push(cursor instanceof Error ? cursor.message : String(cursor));
      cursor = (cursor as { cause?: unknown }).cause;
    }
    expect(chain.join("\n")).toMatch(pattern);
    return;
  }
  throw new Error("expected the guard to refuse the write, but it succeeded");
}

async function resetRows(): Promise<void> {
  // Deleting an operation lets its journal cascade; deleting a fault record lets
  // its signals and frozen set cascade. A direct delete of either child is
  // refused by the guards while the parent still exists.
  await database().exec("DELETE FROM agent_failover_operations");
  await database().exec("DELETE FROM agent_node_failure_events");
  await database().exec("DELETE FROM agent_failover_step_attempts");
  await database().exec("DELETE FROM agent_backup_restore_operations");
  await database().exec("DELETE FROM agent_backup_restore_leases");
  await database().exec("DELETE FROM agent_activation_publications");
  await database().exec("DELETE FROM agent_sandboxes");
  await database().exec("DELETE FROM agent_node_incarnation_histories");
  await database().exec("DELETE FROM docker_nodes");
  await database().exec("DELETE FROM organizations");
}

async function seedFixtures(): Promise<void> {
  await database().exec(`
    INSERT INTO organizations (id, name) VALUES ('${ORGANIZATION_ID}', 'org');
    INSERT INTO docker_nodes (id, node_id, hostname, node_incarnation, current_node_history_id, allocated_count)
      VALUES
        ('${SOURCE_NODE_ID}', '${SOURCE_NODE_HANDLE}', 'alpha.example', '${SOURCE_INCARNATION}', '${SOURCE_HISTORY_ID}', 1),
        ('${TARGET_NODE_ID}', '${TARGET_NODE_HANDLE}', 'beta.example', '${TARGET_INCARNATION}', '${TARGET_HISTORY_ID}', 0);
    INSERT INTO agent_node_incarnation_histories (
      id, docker_node_record_id, node_id, node_incarnation, fleet_kind,
      infrastructure_provider, provider_server_id, host_key_fingerprint
    ) VALUES
      ('${SOURCE_HISTORY_ID}', '${SOURCE_NODE_ID}', '${SOURCE_NODE_HANDLE}', '${SOURCE_INCARNATION}',
        'cloud', 'hetzner', '1234', 'SHA256:alpha'),
      ('${TARGET_HISTORY_ID}', '${TARGET_NODE_ID}', '${TARGET_NODE_HANDLE}', '${TARGET_INCARNATION}',
        'cloud', 'hetzner', '5678', 'SHA256:beta');
    INSERT INTO agent_sandboxes (
      id, organization_id, node_id, container_name, activation_generation, lifecycle_revision
    ) VALUES
      ('${AGENT_ID}', '${ORGANIZATION_ID}', '${SOURCE_NODE_HANDLE}', 'agent-one',
        '${SOURCE_GENERATION}', ${SOURCE_LIFECYCLE_REVISION}),
      ('${OTHER_AGENT_ID}', '${ORGANIZATION_ID}', '${SOURCE_NODE_HANDLE}', 'agent-two',
        '${SOURCE_GENERATION}', ${SOURCE_LIFECYCLE_REVISION}),
      ('${STRANGER_AGENT_ID}', '${ORGANIZATION_ID}', '${TARGET_NODE_HANDLE}', 'agent-three',
        '${STRANGER_GENERATION}', ${SOURCE_LIFECYCLE_REVISION});
    INSERT INTO agent_backup_restore_leases (
      id, organization_id, agent_id, backup_id, owner_id, generation, released_at
    ) VALUES (
      '${RESTORE_LEASE_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${BACKUP_ID}',
      '${RESTORE_LEASE_OWNER}', '${RESTORE_LEASE_GENERATION}', NULL
    );
    INSERT INTO agent_backup_restore_leases (
      id, organization_id, agent_id, backup_id, owner_id, generation, released_at
    ) VALUES (
      '${RESTORE_LEASE_ID_SECOND}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${BACKUP_ID}',
      '${RESTORE_LEASE_OWNER}', '${RESTORE_LEASE_GENERATION_SECOND}', NULL
    );
    INSERT INTO agent_backup_restore_operations (
      id, organization_id, agent_id, backup_id, restore_attempt_id, lease_id,
      lease_generation, lease_owner_id, expected_manifest_sha256
    ) VALUES
      (
        '${RESTORE_OPERATION_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${BACKUP_ID}',
        '${RESTORE_ATTEMPT_ID}', '${RESTORE_LEASE_ID}', '${RESTORE_LEASE_GENERATION}',
        '${RESTORE_LEASE_OWNER}', '${MANIFEST_SHA}'
      ),
      (
        '${RESTORE_OPERATION_ID_SECOND}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${BACKUP_ID}',
        '${RESTORE_ATTEMPT_ID_SECOND}', '${RESTORE_LEASE_ID_SECOND}',
        '${RESTORE_LEASE_GENERATION_SECOND}', '${RESTORE_LEASE_OWNER}', '${MANIFEST_SHA}'
      );
    INSERT INTO agent_activation_publications (
      id, organization_id, agent_id, activation_generation, purpose, backup_id,
      backup_manifest_sha256, activation_receipt_sha256, previous_activation_generation,
      lifecycle_revision, container_id, node_history_id, docker_node_record_id, node_id,
      node_incarnation
    ) VALUES
      ('${SOURCE_PUBLICATION_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${SOURCE_GENERATION}',
        'provision', NULL, NULL, '${SOURCE_RECEIPT_SHA}', NULL, ${SOURCE_LIFECYCLE_REVISION},
        '${SOURCE_CONTAINER_ID}', '${SOURCE_HISTORY_ID}', '${SOURCE_NODE_ID}',
        '${SOURCE_NODE_HANDLE}', '${SOURCE_INCARNATION}'),
      ('${STRANGER_PUBLICATION_ID}', '${ORGANIZATION_ID}', '${OTHER_AGENT_ID}',
        '${SOURCE_GENERATION}', 'provision', NULL, NULL, '${SOURCE_RECEIPT_SHA}', NULL,
        ${SOURCE_LIFECYCLE_REVISION}, '${SOURCE_CONTAINER_ID}', '${SOURCE_HISTORY_ID}',
        '${SOURCE_NODE_ID}', '${SOURCE_NODE_HANDLE}', '${SOURCE_INCARNATION}');
  `);
}

/** One observation from `platform_heartbeat_monitor` (class `platform_reachability`). */
async function recordReachabilitySignal(
  failureEventId: string,
  source: "platform_heartbeat_monitor" | "platform_placement_probe" = "platform_heartbeat_monitor",
  observedKinds: string[] = ["node_heartbeat_expired"],
): Promise<void> {
  for (const kind of observedKinds) {
    await agentFailoverRepository.recordFailureSignal({
      failureEventId,
      kind: kind as never,
      source,
    });
  }
}

/** Drives a record to `triggered` using two independent classes. */
async function openTriggeredFault(): Promise<{ failureEventId: string }> {
  const event = await agentFailoverRepository.openFailureRecord({
    nodeRecordId: SOURCE_NODE_ID,
    nodeId: SOURCE_NODE_HANDLE,
    nodeIncarnation: SOURCE_INCARNATION,
    nodeHistoryId: SOURCE_HISTORY_ID,
  });
  await recordReachabilitySignal(event.id);
  await agentFailoverRepository.recordFailureSignal({
    failureEventId: event.id,
    kind: "provider_reported_failure",
    source: "infrastructure_provider_api",
  });
  await agentFailoverRepository.triggerFailureRecord({ failureEventId: event.id });
  return { failureEventId: event.id };
}

/** Triggered, cordoned, and frozen, with `AGENT_ID` in the set. */
async function freezeFault(): Promise<{ failureEventId: string; agentId: string }> {
  const { failureEventId } = await openTriggeredFault();
  await agentFailoverRepository.cordonAndFreezeFailure({ failureEventId });
  return { failureEventId, agentId: AGENT_ID };
}

async function openFrozenOperation(): Promise<{ failureEventId: string; operationId: string }> {
  const { failureEventId } = await freezeFault();
  const operation = await agentFailoverRepository.openOperation({
    failureEventId,
    agentId: AGENT_ID,
  });
  return { failureEventId, operationId: operation.id };
}

async function claim(
  operationId: string,
  owner: string,
  leaseMs = 60_000,
): Promise<{ owner: string; generation: string }> {
  const receipt = await agentFailoverRepository.claimOperation({
    operationId,
    leaseOwner: owner,
    leaseMs,
  });
  if (!receipt) throw new Error(`claimOperation returned no receipt for ${operationId}`);
  return { owner: receipt.leaseOwner, generation: receipt.leaseGeneration };
}

async function expireLease(operationId: string): Promise<void> {
  await database().exec(`
    UPDATE agent_failover_operations
    SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
    WHERE id = '${operationId}'
  `);
}

/**
 * Records a restore authority and the matching target publication, so the cutover
 * chain is complete. The publication directly succeeds the frozen source
 * generation, which is what the guard requires.
 */
async function installCutoverChain(
  operationId: string,
  fence: { owner: string; generation: string },
): Promise<void> {
  await agentFailoverRepository.recordRestoreAdmission({
    operationId,
    leaseOwner: fence.owner,
    leaseGeneration: fence.generation,
    restoreOperationId: RESTORE_OPERATION_ID,
    restoreLeaseId: RESTORE_LEASE_ID,
    restoreLeaseOwner: RESTORE_LEASE_OWNER,
    restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
    restoreBackupId: BACKUP_ID,
    restoreManifestSha256: MANIFEST_SHA,
  });
  // The identity bundle is frozen first: the publication does not exist yet, and
  // a lost publish response is resolved by replaying these exact identities.
  await agentFailoverRepository.installCutoverIdentity({
    operationId,
    leaseOwner: fence.owner,
    leaseGeneration: fence.generation,
    targetPublicationId: TARGET_PUBLICATION_ID,
    targetActivationGeneration: TARGET_GENERATION,
    targetLifecycleRevision: BigInt(TARGET_LIFECYCLE_REVISION),
    targetContainerId: TARGET_CONTAINER_ID,
    targetReceiptSha256: TARGET_RECEIPT_SHA,
    targetNodeRecordId: TARGET_NODE_ID,
    targetNodeIncarnation: TARGET_INCARNATION,
    targetNodeHistoryId: TARGET_HISTORY_ID,
  });
  await publishTargetPublication(SOURCE_GENERATION);
}

/** Publishes the target activation publication the identity bundle names. */
async function publishTargetPublication(previousGeneration: string): Promise<void> {
  await database().exec(`
    INSERT INTO agent_activation_publications (
      id, organization_id, agent_id, activation_generation, purpose, backup_id,
      backup_manifest_sha256, activation_receipt_sha256, previous_activation_generation,
      lifecycle_revision, container_id, node_history_id, docker_node_record_id, node_id,
      node_incarnation
    ) VALUES (
      '${TARGET_PUBLICATION_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${TARGET_GENERATION}',
      'restore', '${BACKUP_ID}', '${MANIFEST_SHA}', '${TARGET_RECEIPT_SHA}',
      '${previousGeneration}', ${TARGET_LIFECYCLE_REVISION}, '${TARGET_CONTAINER_ID}',
      '${TARGET_HISTORY_ID}', '${TARGET_NODE_ID}', '${TARGET_NODE_HANDLE}', '${TARGET_INCARNATION}')
  `);
}

let schemaFailure: string | null = null;

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    schemaFailure = "isolated PGlite is required; refusing to mutate an ambient Postgres database";
    return;
  }
  try {
    await applyStatements(PREREQUISITE_SQL);
    for (const migration of migrationSql) await applyStatements(migration);
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

beforeEach(async () => {
  if (schemaFailure) return;
  await resetRows();
  await seedFixtures();
});

function requireSchema(): void {
  if (schemaFailure) throw new Error(`failover schema unavailable: ${schemaFailure}`);
}

describe("a trigger needs agreement across independent failure domains", () => {
  test(
    "one observation cannot trigger, by repository or by raw SQL",
    async () => {
      requireSchema();
      const event = await agentFailoverRepository.openFailureRecord({
        nodeRecordId: SOURCE_NODE_ID,
        nodeId: SOURCE_NODE_HANDLE,
        nodeIncarnation: SOURCE_INCARNATION,
        nodeHistoryId: SOURCE_HISTORY_ID,
      });
      await recordReachabilitySignal(event.id);

      await expect(
        agentFailoverRepository.triggerFailureRecord({ failureEventId: event.id }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
      await expect(
        database().exec(
          `UPDATE agent_node_failure_events SET status = 'triggered', triggered_at = now()
         WHERE id = '${event.id}'`,
        ),
      ).rejects.toThrow(/two distinct observation kinds/);
    },
    TIMEOUT,
  );

  test(
    "two probes on one network path do not corroborate each other",
    async () => {
      requireSchema();
      const event = await agentFailoverRepository.openFailureRecord({
        nodeRecordId: SOURCE_NODE_ID,
        nodeId: SOURCE_NODE_HANDLE,
        nodeIncarnation: SOURCE_INCARNATION,
        nodeHistoryId: SOURCE_HISTORY_ID,
      });
      // Both observers are declared `platform_reachability`: they fail together.
      await recordReachabilitySignal(event.id, "platform_heartbeat_monitor", [
        "node_heartbeat_expired",
      ]);
      await recordReachabilitySignal(event.id, "platform_placement_probe", [
        "node_probe_unreachable",
      ]);

      const standing = await agentFailoverRepository.findSignals(event.id);
      expect(standing.map((signal) => signal.source_class)).toEqual([
        "platform_reachability",
        "platform_reachability",
      ]);
      await expect(
        agentFailoverRepository.triggerFailureRecord({ failureEventId: event.id }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
    },
    TIMEOUT,
  );

  test(
    "cross-class evidence triggers, and evidence is frozen afterwards",
    async () => {
      requireSchema();
      const { failureEventId } = await openTriggeredFault();
      const triggered = await agentFailoverRepository.findFailureRecord(failureEventId);
      expect(triggered?.status).toBe("triggered");
      expect(triggered?.triggered_at).not.toBeNull();

      await expect(
        agentFailoverRepository.recordFailureSignal({
          failureEventId,
          kind: "container_runtime_absent",
          source: "platform_runtime_inventory",
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
    },
    TIMEOUT,
  );

  test(
    "repeat polls widen the observation count but not the verdict",
    async () => {
      requireSchema();
      const event = await agentFailoverRepository.openFailureRecord({
        nodeRecordId: SOURCE_NODE_ID,
        nodeId: SOURCE_NODE_HANDLE,
        nodeIncarnation: SOURCE_INCARNATION,
        nodeHistoryId: SOURCE_HISTORY_ID,
      });
      for (let poll = 0; poll < 4; poll += 1) {
        const standing = await agentFailoverRepository.recordFailureSignal({
          failureEventId: event.id,
          kind: "node_probe_unreachable",
          source: "platform_placement_probe",
        });
        expect(standing.observations).toBe(poll + 1);
        expect(standing.distinctClasses).toBe(1);
        expect(standing.corroborated).toBe(false);
      }
    },
    TIMEOUT,
  );

  test(
    "an undeclared observer cannot be recorded at all",
    async () => {
      requireSchema();
      const event = await agentFailoverRepository.openFailureRecord({
        nodeRecordId: SOURCE_NODE_ID,
        nodeId: SOURCE_NODE_HANDLE,
        nodeIncarnation: SOURCE_INCARNATION,
        nodeHistoryId: SOURCE_HISTORY_ID,
      });
      await expect(
        agentFailoverRepository.recordFailureSignal({
          failureEventId: event.id,
          kind: "node_probe_unreachable",
          source: "someone-elses-probe" as never,
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
    },
    TIMEOUT,
  );
});

describe("the fault scene is frozen from publications, not from the node handle", () => {
  test(
    "freezing cordons the node and captures the authorized set",
    async () => {
      requireSchema();
      const { failureEventId } = await await openTriggeredFault();
      const outcome = await agentFailoverRepository.cordonAndFreezeFailure({ failureEventId });

      expect(outcome.event.cordoned_at).not.toBeNull();
      expect(outcome.event.enumerated_at).not.toBeNull();
      expect(outcome.candidates.map((candidate) => candidate.agent_id).sort()).toEqual(
        [AGENT_ID, OTHER_AGENT_ID].sort(),
      );
      const node = await scalar<{ placement_state: string }>(
        `SELECT placement_state FROM docker_nodes WHERE id = '${SOURCE_NODE_ID}'`,
      );
      expect(node?.placement_state).toBe("cordoned");
    },
    TIMEOUT,
  );

  test(
    "an agent on another occurrence is never swept in",
    async () => {
      requireSchema();
      const { failureEventId } = await freezeFault();
      const candidates = await agentFailoverRepository.findCandidates(failureEventId);
      expect(candidates.map((candidate) => candidate.agent_id)).not.toContain(STRANGER_AGENT_ID);
    },
    TIMEOUT,
  );

  test(
    "freezing is idempotent and does not widen the set",
    async () => {
      requireSchema();
      const { failureEventId } = await freezeFault();
      const first = await agentFailoverRepository.findCandidates(failureEventId);
      const again = await agentFailoverRepository.cordonAndFreezeFailure({ failureEventId });
      expect(again.candidates).toHaveLength(first.length);
      expect(await agentFailoverRepository.findCandidates(failureEventId)).toHaveLength(
        first.length,
      );
    },
    TIMEOUT,
  );

  test(
    "a node that no longer answers to the frozen occurrence is not cordoned",
    async () => {
      requireSchema();
      const { failureEventId } = await openTriggeredFault();
      // The host rebooted: the record now carries a different occurrence.
      await database().exec(
        `UPDATE docker_nodes SET node_incarnation = '${TARGET_INCARNATION}',
        current_node_history_id = '${TARGET_HISTORY_ID}' WHERE id = '${SOURCE_NODE_ID}'`,
      );
      await expect(
        agentFailoverRepository.cordonAndFreezeFailure({ failureEventId }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
    },
    TIMEOUT,
  );

  test(
    "collection evidence cannot be added after the trigger",
    async () => {
      requireSchema();
      const { failureEventId } = await openTriggeredFault();
      await expect(
        database().exec(`
        INSERT INTO agent_node_failure_signals (
          failure_event_id, kind, source, source_class, policy_version
        ) VALUES ('${failureEventId}', 'node_probe_unreachable', 'platform_placement_probe',
          'platform_reachability', 1)
      `),
      ).rejects.toThrow(/evidence is frozen/);
    },
    TIMEOUT,
  );
});

describe("an operation can only replace a frozen instance", () => {
  test(
    "an agent outside the frozen set cannot open an operation",
    async () => {
      requireSchema();
      const { failureEventId } = await freezeFault();
      await expect(
        agentFailoverRepository.openOperation({ failureEventId, agentId: STRANGER_AGENT_ID }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
    },
    TIMEOUT,
  );

  test(
    "opening is idempotent and copies the frozen authority",
    async () => {
      requireSchema();
      const { failureEventId, operationId } = await openFrozenOperation();
      const again = await agentFailoverRepository.openOperation({
        failureEventId,
        agentId: AGENT_ID,
      });
      expect(again.id).toBe(operationId);
      expect(again.source_publication_id).toBe(SOURCE_PUBLICATION_ID);
      expect(again.source_activation_generation).toBe(SOURCE_GENERATION);
      expect(again.source_container_id).toBe(SOURCE_CONTAINER_ID);
      expect(again.source_lifecycle_revision).toBe(BigInt(SOURCE_LIFECYCLE_REVISION));
    },
    TIMEOUT,
  );

  test(
    "a second non-terminal operation for the same agent is refused",
    async () => {
      requireSchema();
      const { failureEventId } = await openFrozenOperation();
      const other = await agentFailoverRepository.openFailureRecord({
        nodeRecordId: TARGET_NODE_ID,
        nodeId: TARGET_NODE_HANDLE,
        nodeIncarnation: TARGET_INCARNATION,
        nodeHistoryId: TARGET_HISTORY_ID,
      });
      expect(failureEventId).toBeDefined();
      await expect(
        agentFailoverRepository.openOperation({ failureEventId: other.id, agentId: AGENT_ID }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
    },
    TIMEOUT,
  );
});

describe("steps advance one at a time", () => {
  test(
    "skipping ahead is refused by the repository and by the guard",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");

      for (const step of ["restore", "verify", "cutover", "fence_source"] as const) {
        await expect(
          agentFailoverRepository.beginStepAttempt({
            operationId,
            leaseOwner: fence.owner,
            leaseGeneration: fence.generation,
            step,
          }),
        ).rejects.toBeInstanceOf(AgentFailoverConflictError);
      }

      // The guard refuses a forged row that points at a skipped step.
      await database().exec(`
      UPDATE agent_failover_operations SET step = 'cutover', step_state = 'in_progress'
      WHERE id = '${operationId}'
    `);
      await expect(
        database().exec(`
        INSERT INTO agent_failover_step_attempts
          (operation_id, step, attempt, state, lease_owner, lease_generation)
        VALUES ('${operationId}', 'cutover', 1, 'started', '${fence.owner}', '${fence.generation}')
      `),
      ).rejects.toThrow(/requires every earlier step to be committed/);
    },
    TIMEOUT,
  );

  test(
    "advancing requires the current step to have succeeded",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "isolate_source",
      });
      // Still in progress: the successor is refused.
      await expect(
        agentFailoverRepository.beginStepAttempt({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          step: "check_preconditions",
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);

      // A failed step does not open the next one either.
      await agentFailoverRepository.settleStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "isolate_source",
        attempt: 1,
        outcome: "failed",
      });
      await expect(
        agentFailoverRepository.beginStepAttempt({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          step: "check_preconditions",
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);

      // Retrying the same step is the legal move, and it succeeds on the second try.
      const retry = await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "isolate_source",
      });
      expect(retry.attempt.attempt).toBe(2);
      await agentFailoverRepository.settleStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "isolate_source",
        attempt: 2,
        outcome: "succeeded",
      });
      const advanced = await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "check_preconditions",
      });
      expect(advanced.attempt.attempt).toBe(1);
      expect(advanced.operation.step).toBe("check_preconditions");
    },
    TIMEOUT,
  );
});

describe("an interrupted attempt must be reconciled before the step runs again", () => {
  test(
    "a takeover cannot re-run the step, and the guard agrees",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const first = await claim(operationId, "worker-a");
      await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: first.owner,
        leaseGeneration: first.generation,
        step: "isolate_source",
      });
      await expireLease(operationId);
      const takeover = await claim(operationId, "worker-b");

      const blocked = await agentFailoverRepository
        .beginStepAttempt({
          operationId,
          leaseOwner: takeover.owner,
          leaseGeneration: takeover.generation,
          step: "isolate_source",
        })
        .catch((error: unknown) => error);
      expect(blocked).toBeInstanceOf(AgentFailoverConflictError);
      expect((blocked as AgentFailoverConflictError).code).toBe(
        "AGENT_FAILOVER_ATTEMPT_UNRESOLVED",
      );
      await expect(
        database().exec(`
        INSERT INTO agent_failover_step_attempts
          (operation_id, step, attempt, state, lease_owner, lease_generation)
        VALUES ('${operationId}', 'isolate_source', 2, 'started', '${takeover.owner}',
          '${takeover.generation}')
      `),
      ).rejects.toThrow(/must be reconciled before the step runs again/);

      const resume = await agentFailoverRepository.readOperationResume(operationId);
      expect(resume?.unresolved).toEqual({ step: "isolate_source", attempt: 1 });

      await agentFailoverRepository.markAttemptAwaitingReconcile({
        operationId,
        leaseOwner: takeover.owner,
        leaseGeneration: takeover.generation,
        step: "isolate_source",
        attempt: 1,
        detail: { inspected: "node cordoned, no successor started" },
      });
      const reconciled = await agentFailoverRepository.reconcileStepAttempt({
        operationId,
        leaseOwner: takeover.owner,
        leaseGeneration: takeover.generation,
        step: "isolate_source",
        attempt: 1,
        action: "retried",
        detail: { observed: "no effect persisted", decision: "retry" },
      });
      expect(reconciled.attempt.settled_by_lease_owner).toBe("worker-b");
      expect(reconciled.attempt.lease_owner).toBe("worker-a");

      const retried = await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: takeover.owner,
        leaseGeneration: takeover.generation,
        step: "isolate_source",
      });
      expect(retried.attempt.attempt).toBe(2);
    },
    TIMEOUT,
  );
});

describe("a superseded executor cannot commit", () => {
  test(
    "the old generation cannot settle, open, or renew after takeover",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const first = await claim(operationId, "worker-a", 5_000);
      await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: first.owner,
        leaseGeneration: first.generation,
        step: "isolate_source",
      });
      await expireLease(operationId);
      await claim(operationId, "worker-b");

      await expect(
        agentFailoverRepository.settleStepAttempt({
          operationId,
          leaseOwner: first.owner,
          leaseGeneration: first.generation,
          step: "isolate_source",
          attempt: 1,
          outcome: "succeeded",
        }),
      ).rejects.toThrow(/not held by worker-a/);
      await expect(
        agentFailoverRepository.beginStepAttempt({
          operationId,
          leaseOwner: first.owner,
          leaseGeneration: first.generation,
          step: "isolate_source",
        }),
      ).rejects.toThrow(/not held by worker-a/);
      const renewal = await agentFailoverRepository.renewOperationLease({
        operationId,
        leaseOwner: first.owner,
        leaseGeneration: first.generation,
      });
      expect(renewal).toEqual({ renewed: false, reason: "lost" });
    },
    TIMEOUT,
  );

  test(
    "the guard refuses a stale settlement even without the repository",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const first = await claim(operationId, "worker-a");
      const opened = await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: first.owner,
        leaseGeneration: first.generation,
        step: "isolate_source",
      });
      await expireLease(operationId);
      await claim(operationId, "worker-b");

      await expect(
        database().exec(`
        UPDATE agent_failover_step_attempts
        SET state = 'succeeded', finished_at = clock_timestamp()
        WHERE id = '${opened.attempt.id}'
      `),
      ).rejects.toThrow(/superseded executor cannot settle/);
    },
    TIMEOUT,
  );
});

describe("the cutover authority chain is enforced end to end", () => {
  /**
   * Drives the operation to an open `cutover` step. `installChain` is false when
   * the test wants to prove a cutover without the authority chain is refused.
   */
  async function reachCutover(
    operationId: string,
    installChain = true,
  ): Promise<{ owner: string; generation: string }> {
    const fence = await claim(operationId, "worker-a");
    const advance = async (step: string, outcome: "succeeded" = "succeeded") => {
      const opened = await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: step as never,
      });
      await agentFailoverRepository.settleStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: step as never,
        attempt: opened.attempt.attempt,
        outcome,
      });
    };
    await advance("isolate_source");
    if (installChain) await installCutoverChain(operationId, fence);
    await agentFailoverRepository.setRecoverySource({
      operationId,
      leaseOwner: fence.owner,
      leaseGeneration: fence.generation,
      dataWatermarkAt: new Date("2026-09-10T12:00:00.000Z"),
    });
    await advance("check_preconditions");
    await advance("restore");
    await advance("verify");
    await agentFailoverRepository.beginStepAttempt({
      operationId,
      leaseOwner: fence.owner,
      leaseGeneration: fence.generation,
      step: "cutover",
    });
    return fence;
  }

  test(
    "restore cannot succeed without naming the data watermark",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "isolate_source",
      });
      await agentFailoverRepository.settleStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "isolate_source",
        attempt: 1,
        outcome: "succeeded",
      });
      await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "check_preconditions",
      });
      await agentFailoverRepository.settleStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "check_preconditions",
        attempt: 1,
        outcome: "succeeded",
      });
      await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "restore",
      });
      await expectGuardRefusal(
        agentFailoverRepository.settleStepAttempt({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          step: "restore",
          attempt: 1,
          outcome: "succeeded",
        }),
        /cannot succeed without naming the data watermark/,
      );
    },
    TIMEOUT,
  );

  test(
    "a cutover without an installed identity bundle is refused",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      // Reached honestly, but with no restore authority and no target publication.
      const fence = await reachCutover(operationId, false);
      await expectGuardRefusal(
        agentFailoverRepository.settleStepAttempt({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          step: "cutover",
          attempt: 1,
          outcome: "succeeded",
        }),
        /cutover requires an installed target activation publication/,
      );
      await expect(
        agentFailoverRepository.installCutoverIdentity({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          targetPublicationId: TARGET_PUBLICATION_ID,
          targetActivationGeneration: TARGET_GENERATION,
          targetLifecycleRevision: BigInt(TARGET_LIFECYCLE_REVISION),
          targetContainerId: TARGET_CONTAINER_ID,
          targetReceiptSha256: TARGET_RECEIPT_SHA,
          targetNodeRecordId: TARGET_NODE_ID,
          targetNodeIncarnation: TARGET_INCARNATION,
          targetNodeHistoryId: TARGET_HISTORY_ID,
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
    },
    TIMEOUT,
  );

  test(
    "a target publication must directly succeed the frozen source generation",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await agentFailoverRepository.recordRestoreAdmission({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        restoreOperationId: "90000000-0000-4000-8000-000000000001",
        restoreLeaseId: "90000000-0000-4000-8000-000000000002",
        restoreLeaseOwner: "restore-worker",
        restoreLeaseGeneration: "90000000-0000-4000-8000-000000000003",
        restoreBackupId: BACKUP_ID,
        restoreManifestSha256: MANIFEST_SHA,
      });
      // A restore publication that does not name the source generation as its
      // predecessor is a different lineage, not this failover's successor.
      await database().exec(`
      INSERT INTO agent_activation_publications (
        id, organization_id, agent_id, activation_generation, purpose, backup_id,
        backup_manifest_sha256, activation_receipt_sha256, previous_activation_generation,
        lifecycle_revision, container_id, node_history_id, docker_node_record_id, node_id,
        node_incarnation
      ) VALUES (
        '${TARGET_PUBLICATION_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${TARGET_GENERATION}',
        'restore', '${BACKUP_ID}', '${MANIFEST_SHA}', '${TARGET_RECEIPT_SHA}',
        '${STRANGER_GENERATION}', ${TARGET_LIFECYCLE_REVISION}, '${TARGET_CONTAINER_ID}',
        '${TARGET_HISTORY_ID}', '${TARGET_NODE_ID}', '${TARGET_NODE_HANDLE}', '${TARGET_INCARNATION}')
    `);
      await agentFailoverRepository.installCutoverIdentity({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        targetPublicationId: TARGET_PUBLICATION_ID,
        targetActivationGeneration: TARGET_GENERATION,
        targetLifecycleRevision: BigInt(TARGET_LIFECYCLE_REVISION),
        targetContainerId: TARGET_CONTAINER_ID,
        targetReceiptSha256: TARGET_RECEIPT_SHA,
        targetNodeRecordId: TARGET_NODE_ID,
        targetNodeIncarnation: TARGET_INCARNATION,
        targetNodeHistoryId: TARGET_HISTORY_ID,
      });
      const opened = await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "isolate_source",
      });
      expect(opened.attempt.attempt).toBe(1);
      await agentFailoverRepository.settleStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "isolate_source",
        attempt: 1,
        outcome: "succeeded",
      });
      for (const step of ["check_preconditions", "restore", "verify"] as const) {
        const attempt = await agentFailoverRepository.beginStepAttempt({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          step,
        });
        if (step === "restore") {
          await agentFailoverRepository.setRecoverySource({
            operationId,
            leaseOwner: fence.owner,
            leaseGeneration: fence.generation,
            dataWatermarkAt: new Date("2026-09-10T12:00:00.000Z"),
          });
        }
        await agentFailoverRepository.settleStepAttempt({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          step,
          attempt: attempt.attempt.attempt,
          outcome: "succeeded",
        });
      }
      await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "cutover",
      });
      await expectGuardRefusal(
        database().exec(`
        UPDATE agent_failover_step_attempts SET state = 'succeeded', finished_at = clock_timestamp()
        WHERE operation_id = '${operationId}' AND step = 'cutover' AND attempt = 1
      `),
        /must directly succeed the frozen source generation/,
      );
    },
    TIMEOUT,
  );

  test(
    "a committed cutover completes only after the source is fenced",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await reachCutover(operationId);
      await agentFailoverRepository.settleStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "cutover",
        attempt: 1,
        outcome: "succeeded",
      });

      // Fencing still has to happen before completion is honest.
      await expectGuardRefusal(
        agentFailoverRepository.finishOperation({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          status: "completed",
        }),
        /completes only after the source authority is fenced/,
      );

      const fencing = await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "fence_source",
      });
      await agentFailoverRepository.settleStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "fence_source",
        attempt: fencing.attempt.attempt,
        outcome: "succeeded",
      });
      const finished = await agentFailoverRepository.finishOperation({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        status: "completed",
      });
      expect(finished.status).toBe("completed");
    },
    TIMEOUT,
  );

  test(
    "a committed cutover cannot be cancelled or failed",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await reachCutover(operationId);
      await agentFailoverRepository.settleStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: "cutover",
        attempt: 1,
        outcome: "succeeded",
      });

      // The status write itself is refused, for every pre-cutover terminal state.
      for (const status of ["cancelled", "failed", "blocked_no_backup"] as const) {
        await expectGuardRefusal(
          database().exec(`
          UPDATE agent_failover_operations
          SET status = '${status}', completed_at = clock_timestamp(),
              last_error_code = 'AGENT_FAILOVER_ABORTED'
          WHERE id = '${operationId}'
        `),
          /cannot be cancelled or failed/,
        );
      }

      // Asking the repository to stop instead becomes bounded forward progress:
      // the operation stays non-terminal and is never marked done.
      const retried = await agentFailoverRepository.finishOperation({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        status: "cancelled",
        errorCode: "AGENT_FAILOVER_ABORTED",
        errorMessage: "operator tried to abort",
      });
      expect(retried.status).toBe("running");
      expect(retried.completed_at).toBeNull();
      expect(retried.post_cutover_attempts).toBe(1);
      // The retry released the fence so the scheduler can pick it up again; an
      // operator escalation needs a fresh claim, exactly like any other attempt.
      await database().exec(`
      UPDATE agent_failover_operations
      SET next_attempt_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = '${operationId}'
    `);
      const escalation = await claim(operationId, "operator");
      const parked = await agentFailoverRepository.parkForIntervention({
        operationId,
        leaseOwner: escalation.owner,
        leaseGeneration: escalation.generation,
        errorCode: "AGENT_FAILOVER_FENCE_STUCK",
        errorMessage: "source container refused teardown",
      });
      expect(parked.status).toBe("intervention_required");
      expect(parked.completed_at).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "intervention is unreachable before a committed cutover",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await expectGuardRefusal(
        agentFailoverRepository.parkForIntervention({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          errorCode: "AGENT_FAILOVER_FENCE_STUCK",
          errorMessage: "nothing has moved yet",
        }),
        /intervention is only reachable after a committed cutover/,
      );
    },
    TIMEOUT,
  );
});

describe("the reviewed contract gaps stay closed", () => {
  test(
    "a reconciled-continued cutover clears the same authority bar as a success",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const first = await claim(operationId, "worker-a", 5_000);
      const advance = async (step: string) => {
        const opened = await agentFailoverRepository.beginStepAttempt({
          operationId,
          leaseOwner: first.owner,
          leaseGeneration: first.generation,
          step: step as never,
        });
        await agentFailoverRepository.settleStepAttempt({
          operationId,
          leaseOwner: first.owner,
          leaseGeneration: first.generation,
          step: step as never,
          attempt: opened.attempt.attempt,
          outcome: "succeeded",
        });
      };
      // Every earlier step commits, but no restore authority and no publication is
      // ever installed.
      await advance("isolate_source");
      await agentFailoverRepository.setRecoverySource({
        operationId,
        leaseOwner: first.owner,
        leaseGeneration: first.generation,
        dataWatermarkAt: new Date("2026-09-10T12:00:00.000Z"),
      });
      await advance("check_preconditions");
      await advance("restore");
      await advance("verify");
      await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: first.owner,
        leaseGeneration: first.generation,
        step: "cutover",
      });

      // The executor dies with the cutover outcome unknown.
      await expireLease(operationId);
      const takeover = await claim(operationId, "worker-b");
      await agentFailoverRepository.markAttemptAwaitingReconcile({
        operationId,
        leaseOwner: takeover.owner,
        leaseGeneration: takeover.generation,
        step: "cutover",
        attempt: 1,
        detail: { inspected: "publish response was lost" },
      });

      // "continued" marks the cutover committed, so it must clear the same bar as
      // a direct success rather than being a way around the publication chain.
      await expectGuardRefusal(
        agentFailoverRepository.reconcileStepAttempt({
          operationId,
          leaseOwner: takeover.owner,
          leaseGeneration: takeover.generation,
          step: "cutover",
          attempt: 1,
          action: "continued",
          detail: { replay: "publication not found, assuming committed" },
        }),
        /cutover requires an installed target activation publication/,
      );

      // The refused reconcile left the attempt unreconciled, so the cutover is not
      // committed and the operation is still waiting on it.
      const attempt = await scalar<{ state: string; reconcile_action: string | null }>(
        `SELECT state, reconcile_action FROM agent_failover_step_attempts
       WHERE operation_id = '${operationId}' AND step = 'cutover' AND attempt = 1`,
      );
      expect(attempt?.state).toBe("awaiting_reconcile");
      expect(attempt?.reconcile_action).toBeNull();
      const resume = await agentFailoverRepository.readOperationResume(operationId);
      expect(resume?.cutoverCommitted).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "the identity bundle is frozen before the publication exists",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await agentFailoverRepository.recordRestoreAdmission({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        restoreOperationId: RESTORE_OPERATION_ID,
        restoreLeaseId: RESTORE_LEASE_ID,
        restoreLeaseOwner: RESTORE_LEASE_OWNER,
        restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
        restoreBackupId: BACKUP_ID,
        restoreManifestSha256: MANIFEST_SHA,
      });
      const intent = await agentFailoverRepository.installCutoverIdentity({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        targetPublicationId: TARGET_PUBLICATION_ID,
        targetActivationGeneration: TARGET_GENERATION,
        targetLifecycleRevision: BigInt(TARGET_LIFECYCLE_REVISION),
        targetContainerId: TARGET_CONTAINER_ID,
        targetReceiptSha256: TARGET_RECEIPT_SHA,
        targetNodeRecordId: TARGET_NODE_ID,
        targetNodeIncarnation: TARGET_INCARNATION,
        targetNodeHistoryId: TARGET_HISTORY_ID,
      });
      expect(intent.target_publication_id).toBe(TARGET_PUBLICATION_ID);
      const publication = await scalar<{ id: string }>(
        `SELECT id FROM agent_activation_publications WHERE id = '${TARGET_PUBLICATION_ID}'`,
      );
      expect(publication).toBeUndefined();
    },
    TIMEOUT,
  );

  test(
    "a restore admission that does not match the real rows is refused",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await expect(
        agentFailoverRepository.recordRestoreAdmission({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          restoreOperationId: "90000000-0000-4000-8000-0000000000ff",
          restoreLeaseId: RESTORE_LEASE_ID,
          restoreLeaseOwner: RESTORE_LEASE_OWNER,
          restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
          restoreBackupId: BACKUP_ID,
          restoreManifestSha256: MANIFEST_SHA,
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
      await expect(
        agentFailoverRepository.recordRestoreAdmission({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          restoreOperationId: RESTORE_OPERATION_ID,
          restoreLeaseId: RESTORE_LEASE_ID,
          restoreLeaseOwner: "someone-else",
          restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
          restoreBackupId: BACKUP_ID,
          restoreManifestSha256: MANIFEST_SHA,
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
    },
    TIMEOUT,
  );

  test(
    "a withdrawn trigger opens no new work and cannot be withdrawn mid-recovery",
    async () => {
      requireSchema();
      const { failureEventId } = await freezeFault();
      const operation = await agentFailoverRepository.openOperation({
        failureEventId,
        agentId: AGENT_ID,
      });
      expect(operation.status).toBe("pending");

      // An outstanding operation blocks the withdrawal.
      await expect(
        agentFailoverRepository.closeFailureRecord({
          failureEventId,
          status: "cleared",
          reason: "node answered again",
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);

      const fence = await claim(operation.id, "worker-a");
      await agentFailoverRepository.finishOperation({
        operationId: operation.id,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        status: "cancelled",
        errorCode: "AGENT_FAILOVER_TRIGGER_WITHDRAWN",
        errorMessage: "node answered again",
      });
      await agentFailoverRepository.closeFailureRecord({
        failureEventId,
        status: "cleared",
        reason: "node answered again",
      });

      // From a cleared record, no operation may be created for the frozen agent.
      await expect(
        agentFailoverRepository.openOperation({ failureEventId, agentId: OTHER_AGENT_ID }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
    },
    TIMEOUT,
  );

  test(
    "an event cannot be withdrawn while an operation still needs to release capacity",
    async () => {
      requireSchema();
      const { operationId, failureEventId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await agentFailoverRepository.recordRestoreAdmission({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        restoreOperationId: RESTORE_OPERATION_ID,
        restoreLeaseId: RESTORE_LEASE_ID,
        restoreLeaseOwner: RESTORE_LEASE_OWNER,
        restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
        restoreBackupId: BACKUP_ID,
        restoreManifestSha256: MANIFEST_SHA,
      });
      await agentFailoverRepository.markAwaitingCapacity({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        reason: "no_target_capacity",
      });
      await database().exec(`
        UPDATE agent_failover_operations
        SET wait_deadline_at = clock_timestamp() - INTERVAL '1 second',
            next_attempt_at = clock_timestamp() - INTERVAL '1 second'
        WHERE id = '${operationId}'
      `);
      const escalated = await agentFailoverRepository.escalateExpiredWaits();
      // restore_release_required is non-terminal and may still hold a slot, so the
      // trigger cannot be withdrawn out from under it.
      expect(escalated[0]?.status).toBe("restore_release_required");
      await expect(
        agentFailoverRepository.closeFailureRecord({
          failureEventId,
          status: "cleared",
          reason: "node answered again",
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
      // The record stays triggered, so the rest of the frozen set is unaffected.
      const event = await agentFailoverRepository.findFailureRecord(failureEventId);
      expect(event?.status).toBe("triggered");
    },
    TIMEOUT,
  );

  test(
    "an exhausted wait is escalated rather than retried",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await agentFailoverRepository.markAwaitingCapacity({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        reason: "no_target_capacity",
      });
      await database().exec(`
      UPDATE agent_failover_operations
      SET wait_deadline_at = clock_timestamp() - INTERVAL '1 second',
          next_attempt_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = '${operationId}'
    `);
      // The claim path refuses an operation whose wait has expired.
      expect(
        await agentFailoverRepository.claimNextOperation({ leaseOwner: "worker-b" }),
      ).toBeNull();

      const escalated = await agentFailoverRepository.escalateExpiredWaits();
      expect(escalated.map((operation) => operation.id)).toContain(operationId);
      expect(escalated[0]?.status).toBe("failed");
      expect(escalated[0]?.last_error_code).toBe("AGENT_FAILOVER_CAPACITY_WAIT_EXHAUSTED");
    },
    TIMEOUT,
  );

  test(
    "the database pins the declared source class",
    async () => {
      requireSchema();
      const event = await agentFailoverRepository.openFailureRecord({
        nodeRecordId: SOURCE_NODE_ID,
        nodeId: SOURCE_NODE_HANDLE,
        nodeIncarnation: SOURCE_INCARNATION,
        nodeHistoryId: SOURCE_HISTORY_ID,
      });
      // A platform probe cannot be passed off as an independent failure domain.
      await expect(
        database().exec(`
        INSERT INTO agent_node_failure_signals (
          failure_event_id, kind, source, source_class, policy_version
        ) VALUES ('${event.id}', 'node_probe_unreachable', 'platform_placement_probe',
          'infrastructure_provider', 1)
      `),
      ).rejects.toThrow(/shape_check/);
    },
    TIMEOUT,
  );

  test(
    "an operator resume requires an audit trail and clears the attempt budget",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      const advance = async (step: string) => {
        const opened = await agentFailoverRepository.beginStepAttempt({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          step: step as never,
        });
        await agentFailoverRepository.settleStepAttempt({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          step: step as never,
          attempt: opened.attempt.attempt,
          outcome: "succeeded",
        });
      };
      await advance("isolate_source");
      await installCutoverChain(operationId, fence);
      await agentFailoverRepository.setRecoverySource({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        dataWatermarkAt: new Date("2026-09-10T12:00:00.000Z"),
      });
      await advance("check_preconditions");
      await advance("restore");
      await advance("verify");
      await advance("cutover");

      await expect(
        agentFailoverRepository.resumeFromIntervention({
          operationId,
          operator: "",
          reason: "fixed",
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
      // Nothing is parked yet, so resuming is refused for that reason instead.
      await expect(
        agentFailoverRepository.resumeFromIntervention({
          operationId,
          operator: "oncall@example",
          reason: "container runtime recovered",
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);

      const parked = await agentFailoverRepository.parkForIntervention({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        errorCode: "AGENT_FAILOVER_FENCE_STUCK",
        errorMessage: "source container refused teardown",
      });
      expect(parked.status).toBe("intervention_required");

      const resumed = await agentFailoverRepository.resumeFromIntervention({
        operationId,
        operator: "oncall@example",
        reason: "container runtime recovered",
      });
      expect(resumed.status).toBe("running");
      expect(resumed.post_cutover_attempts).toBe(0);
      expect(
        await database()
          .query<{ operator: string }>(
            `SELECT operator FROM agent_failover_operator_actions WHERE operation_id = '${operationId}'`,
          )
          .then((result) => result.rows.map((row) => row.operator)),
      ).toEqual(["oncall@example"]);
    },
    TIMEOUT,
  );
});

describe("restore authority survives a stalled executor without stranding capacity", () => {
  async function expireRestoreLease(): Promise<void> {
    await database().exec(`
      UPDATE agent_backup_restore_leases
      SET expires_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = '${RESTORE_LEASE_ID}'
    `);
  }

  test(
    "an expired restore lease cannot be recorded as an admission",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await expireRestoreLease();
      await expectGuardRefusal(
        agentFailoverRepository.recordRestoreAdmission({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          restoreOperationId: RESTORE_OPERATION_ID,
          restoreLeaseId: RESTORE_LEASE_ID,
          restoreLeaseOwner: RESTORE_LEASE_OWNER,
          restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
          restoreBackupId: BACKUP_ID,
          restoreManifestSha256: MANIFEST_SHA,
        }),
        /restore lease has already expired/,
      );
    },
    TIMEOUT,
  );

  test(
    "a stalled executor can rebind to a fresh restore lease before any cutover intent",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await agentFailoverRepository.recordRestoreAdmission({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        restoreOperationId: RESTORE_OPERATION_ID,
        restoreLeaseId: RESTORE_LEASE_ID,
        restoreLeaseOwner: RESTORE_LEASE_OWNER,
        restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
        restoreBackupId: BACKUP_ID,
        restoreManifestSha256: MANIFEST_SHA,
      });

      // Re-asserting the authority it already holds is a no-op, not a rebind.
      await expect(
        agentFailoverRepository.rebindRestoreAdmission({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          restoreOperationId: RESTORE_OPERATION_ID,
          restoreLeaseId: RESTORE_LEASE_ID,
          restoreLeaseOwner: RESTORE_LEASE_OWNER,
          restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
          restoreBackupId: BACKUP_ID,
          restoreManifestSha256: MANIFEST_SHA,
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);

      // A live old lease may not be swapped out from under its holder.
      await expectGuardRefusal(
        agentFailoverRepository.rebindRestoreAdmission({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          restoreOperationId: RESTORE_OPERATION_ID_SECOND,
          restoreLeaseId: RESTORE_LEASE_ID_SECOND,
          restoreLeaseOwner: RESTORE_LEASE_OWNER,
          restoreLeaseGeneration: RESTORE_LEASE_GENERATION_SECOND,
          restoreBackupId: BACKUP_ID,
          restoreManifestSha256: MANIFEST_SHA,
        }),
        /may be rebound only from a released or expired lease/,
      );

      // Once the old attempt is provably dead, the reference really moves.
      await expireRestoreLease();
      const rebound = await agentFailoverRepository.rebindRestoreAdmission({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        restoreOperationId: RESTORE_OPERATION_ID_SECOND,
        restoreLeaseId: RESTORE_LEASE_ID_SECOND,
        restoreLeaseOwner: RESTORE_LEASE_OWNER,
        restoreLeaseGeneration: RESTORE_LEASE_GENERATION_SECOND,
        restoreBackupId: BACKUP_ID,
        restoreManifestSha256: MANIFEST_SHA,
      });
      expect(rebound.restore_operation_id).toBe(RESTORE_OPERATION_ID_SECOND);
      expect(rebound.restore_lease_id).toBe(RESTORE_LEASE_ID_SECOND);
      expect(rebound.restore_lease_generation).toBe(RESTORE_LEASE_GENERATION_SECOND);
    },
    TIMEOUT,
  );

  test(
    "a failover cannot go terminal before its slot is provably back",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      const attemptId = "90000000-0000-4000-8000-0000000000bb";
      await database().exec(`
        INSERT INTO agent_sandbox_replacement_attempts (id, organization_id, agent_id,
          restore_operation_id, restore_lease_id, restore_lease_owner_id,
          restore_lease_generation, restore_backup_id)
        VALUES ('${attemptId}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${RESTORE_OPERATION_ID}',
          '${RESTORE_LEASE_ID}', '${RESTORE_LEASE_OWNER}', '${RESTORE_LEASE_GENERATION}',
          '${BACKUP_ID}')
      `);
      await agentFailoverRepository.recordRestoreAdmission({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        restoreOperationId: RESTORE_OPERATION_ID,
        restoreLeaseId: RESTORE_LEASE_ID,
        restoreLeaseOwner: RESTORE_LEASE_OWNER,
        restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
        restoreBackupId: BACKUP_ID,
        restoreManifestSha256: MANIFEST_SHA,
        replacementAttemptId: attemptId,
      });
      await agentFailoverRepository.markAwaitingCapacity({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        reason: "no_target_capacity",
      });
      await database().exec(`
      UPDATE agent_failover_operations
      SET wait_deadline_at = clock_timestamp() - INTERVAL '1 second',
          next_attempt_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = '${operationId}'
    `);
      const escalated = await agentFailoverRepository.escalateExpiredWaits();
      // It parks where the restore runtime can release the slot, not terminal.
      expect(escalated[0]?.status).toBe("restore_release_required");

      await expectGuardRefusal(
        database().exec(`
        UPDATE agent_failover_operations
        SET status = 'failed', completed_at = clock_timestamp(),
            last_error_code = 'AGENT_FAILOVER_CAPACITY_WAIT_EXHAUSTED'
        WHERE id = '${operationId}'
      `),
        /still holds an unreleased restore lease/,
      );

      // Releasing the lease alone proves nothing about the reserved slot: the
      // slot comes back in the restore path's cleanup-finish CAS.
      await database().exec(`
      UPDATE agent_backup_restore_leases SET released_at = clock_timestamp()
      WHERE id = '${RESTORE_LEASE_ID}'
    `);
      await expectGuardRefusal(
        database().exec(`
        UPDATE agent_failover_operations
        SET status = 'failed', completed_at = clock_timestamp(),
            last_error_code = 'AGENT_FAILOVER_CAPACITY_WAIT_EXHAUSTED'
        WHERE id = '${operationId}'
      `),
        /proves cleanup and capacity release/,
      );

      // Only the restore path's proven cleanup closes the loop.
      await database().exec(`
      UPDATE agent_sandbox_replacement_attempts
      SET cleanup_proven_at = clock_timestamp(), cleanup_receipt_digest = '${MANIFEST_SHA}'
      WHERE id = '${attemptId}'
    `);
      const failed = await agentFailoverRepository.failAfterRestoreRelease({
        operationId,
        errorCode: "AGENT_FAILOVER_CAPACITY_WAIT_EXHAUSTED",
        errorMessage: "no capacity before the deadline",
      });
      expect(failed.status).toBe("failed");
    },
    TIMEOUT,
  );

  test(
    "an unrecorded reserved attempt cannot be skipped on the way to terminal",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      const attemptId = "90000000-0000-4000-8000-0000000000cc";
      // The restore path reserved a slot and recorded the attempt; this failover
      // has not learned the id yet.
      await database().exec(`
        INSERT INTO agent_sandbox_replacement_attempts (id, organization_id, agent_id,
          restore_operation_id, restore_lease_id, restore_lease_owner_id,
          restore_lease_generation, restore_backup_id, cleanup_proven_at, cleanup_receipt_digest)
        VALUES ('${attemptId}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${RESTORE_OPERATION_ID}',
          '${RESTORE_LEASE_ID}', '${RESTORE_LEASE_OWNER}', '${RESTORE_LEASE_GENERATION}',
          '${BACKUP_ID}', clock_timestamp(), '${MANIFEST_SHA}')
      `);
      await agentFailoverRepository.recordRestoreAdmission({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        restoreOperationId: RESTORE_OPERATION_ID,
        restoreLeaseId: RESTORE_LEASE_ID,
        restoreLeaseOwner: RESTORE_LEASE_OWNER,
        restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
        restoreBackupId: BACKUP_ID,
        restoreManifestSha256: MANIFEST_SHA,
      });
      await database().exec(`
        UPDATE agent_backup_restore_leases SET released_at = clock_timestamp()
        WHERE id = '${RESTORE_LEASE_ID}'
      `);

      // Omitting the attempt id does not skip the reservation check.
      await expectGuardRefusal(
        database().exec(`
          UPDATE agent_failover_operations
          SET status = 'failed', completed_at = clock_timestamp(),
              last_error_code = 'AGENT_FAILOVER_CAPACITY_WAIT_EXHAUSTED'
          WHERE id = '${operationId}'
        `),
        /record its replacement attempt before failing/,
      );

      const current = await agentFailoverRepository.findOperation(operationId);
      expect(current?.status).not.toBe("failed");
    },
    TIMEOUT,
  );

  test(
    "the attempt is attached under a live lease, before the release",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      const attemptId = "90000000-0000-4000-8000-0000000000dd";
      await database().exec(`
        INSERT INTO agent_sandbox_replacement_attempts (id, organization_id, agent_id,
          restore_operation_id, restore_lease_id, restore_lease_owner_id,
          restore_lease_generation, restore_backup_id, cleanup_proven_at, cleanup_receipt_digest)
        VALUES ('${attemptId}', '${ORGANIZATION_ID}', '${AGENT_ID}', '${RESTORE_OPERATION_ID}',
          '${RESTORE_LEASE_ID}', '${RESTORE_LEASE_OWNER}', '${RESTORE_LEASE_GENERATION}',
          '${BACKUP_ID}', clock_timestamp(), '${MANIFEST_SHA}')
      `);
      await agentFailoverRepository.recordRestoreAdmission({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        restoreOperationId: RESTORE_OPERATION_ID,
        restoreLeaseId: RESTORE_LEASE_ID,
        restoreLeaseOwner: RESTORE_LEASE_OWNER,
        restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
        restoreBackupId: BACKUP_ID,
        restoreManifestSha256: MANIFEST_SHA,
      });

      const attached = await agentFailoverRepository.attachReplacementAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        replacementAttemptId: attemptId,
      });
      expect(attached.replacement_attempt_id).toBe(attemptId);
      // One-way: a second attach is refused.
      await expect(
        agentFailoverRepository.attachReplacementAttempt({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          replacementAttemptId: attemptId,
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);

      await database().exec(`
        UPDATE agent_backup_restore_leases SET released_at = clock_timestamp()
        WHERE id = '${RESTORE_LEASE_ID}'
      `);
      const failed = await agentFailoverRepository.finishOperation({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        status: "failed",
        errorCode: "AGENT_FAILOVER_CAPACITY_WAIT_EXHAUSTED",
        errorMessage: "no capacity before the deadline",
      });
      expect(failed.status).toBe("failed");
    },
    TIMEOUT,
  );

  test(
    "a replacement attempt from another recovery is refused",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      const foreignAttemptId = "90000000-0000-4000-8000-0000000000aa";
      await database().exec(`
      INSERT INTO agent_sandbox_replacement_attempts (id, organization_id, agent_id,
        restore_operation_id, restore_lease_id, restore_lease_owner_id,
        restore_lease_generation, restore_backup_id)
      VALUES ('${foreignAttemptId}', '${ORGANIZATION_ID}', '${OTHER_AGENT_ID}',
        '${RESTORE_OPERATION_ID}', '${RESTORE_LEASE_ID}', '${RESTORE_LEASE_OWNER}',
        '${RESTORE_LEASE_GENERATION}', '${BACKUP_ID}')
    `);
      await expectGuardRefusal(
        agentFailoverRepository.recordRestoreAdmission({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          restoreOperationId: RESTORE_OPERATION_ID,
          restoreLeaseId: RESTORE_LEASE_ID,
          restoreLeaseOwner: RESTORE_LEASE_OWNER,
          restoreLeaseGeneration: RESTORE_LEASE_GENERATION,
          restoreBackupId: BACKUP_ID,
          restoreManifestSha256: MANIFEST_SHA,
          replacementAttemptId: foreignAttemptId,
        }),
        /belongs to a different recovery/,
      );
    },
    TIMEOUT,
  );
});

describe("the recovery point objective gap is reported honestly", () => {
  async function reachCutoverAndSettle(
    operationId: string,
    outcome: "succeeded" | "failed",
  ): Promise<void> {
    const fence = await claim(operationId, "worker-a");
    const advance = async (step: string) => {
      const opened = await agentFailoverRepository.beginStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: step as never,
      });
      await agentFailoverRepository.settleStepAttempt({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        step: step as never,
        attempt: opened.attempt.attempt,
        outcome: "succeeded",
      });
    };
    await advance("isolate_source");
    await installCutoverChain(operationId, fence);
    await agentFailoverRepository.setRecoverySource({
      operationId,
      leaseOwner: fence.owner,
      leaseGeneration: fence.generation,
      dataWatermarkAt: new Date("2026-09-10T12:00:00.000Z"),
    });
    await advance("check_preconditions");
    await advance("restore");
    await advance("verify");
    await agentFailoverRepository.beginStepAttempt({
      operationId,
      leaseOwner: fence.owner,
      leaseGeneration: fence.generation,
      step: "cutover",
    });
    await agentFailoverRepository.settleStepAttempt({
      operationId,
      leaseOwner: fence.owner,
      leaseGeneration: fence.generation,
      step: "cutover",
      attempt: 1,
      outcome,
    });
  }

  test(
    "a failed cutover does not end the gap",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      await reachCutoverAndSettle(operationId, "failed");
      const gap = await agentFailoverRepository.readRpoGap(operationId);
      expect(gap?.from.toISOString()).toBe("2026-09-10T12:00:00.000Z");
      expect(gap?.cutoverCommitted).toBe(false);
      expect(gap?.to).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a succeeded cutover ends the gap",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      await reachCutoverAndSettle(operationId, "succeeded");
      const gap = await agentFailoverRepository.readRpoGap(operationId);
      expect(gap?.cutoverCommitted).toBe(true);
      expect(gap?.to).not.toBeNull();
    },
    TIMEOUT,
  );

  test(
    "the source watermark may move forward but never backward",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await agentFailoverRepository.setRecoverySource({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        dataWatermarkAt: new Date("2026-09-01T00:00:00.000Z"),
      });
      const fresher = await agentFailoverRepository.setRecoverySource({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        dataWatermarkAt: new Date("2026-09-05T00:00:00.000Z"),
      });
      expect(fresher.source_data_watermark_at?.toISOString()).toBe("2026-09-05T00:00:00.000Z");
      await expect(
        agentFailoverRepository.setRecoverySource({
          operationId,
          leaseOwner: fence.owner,
          leaseGeneration: fence.generation,
          dataWatermarkAt: new Date("2026-08-01T00:00:00.000Z"),
        }),
      ).rejects.toBeInstanceOf(AgentFailoverConflictError);
      await expect(
        database().exec(`
        UPDATE agent_failover_operations
        SET source_data_watermark_at = '2026-08-01T00:00:00Z'::timestamptz
        WHERE id = '${operationId}'
      `),
      ).rejects.toThrow(/may only move forward/);
    },
    TIMEOUT,
  );
});

describe("waiting is bounded and carries a reason", () => {
  test(
    "awaiting capacity records a reason and a deadline, and holds no target",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      const waiting = await agentFailoverRepository.markAwaitingCapacity({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        reason: "no_target_capacity",
        waitMs: 60_000,
        retryAfterMs: 5_000,
      });
      expect(waiting.status).toBe("awaiting_capacity");
      expect(waiting.wait_reason).toBe("no_target_capacity");
      expect(waiting.wait_deadline_at).not.toBeNull();
      expect(waiting.target_publication_id).toBeNull();

      await expect(
        database().exec(`
        UPDATE agent_failover_operations SET wait_deadline_at = NULL WHERE id = '${operationId}'
      `),
      ).rejects.toThrow(/lease_shape_check/);
    },
    TIMEOUT,
  );

  test(
    "leaving the wait returns the operation to running",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      await agentFailoverRepository.markAwaitingCapacity({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        reason: "no_target_capacity",
      });
      await expireLease(operationId);
      // The retry horizon the wait set has arrived.
      await database().exec(`
      UPDATE agent_failover_operations
      SET next_attempt_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = '${operationId}'
    `);
      const takeover = await claim(operationId, "worker-b");
      const resumed = await agentFailoverRepository.resumeFromWait({
        operationId,
        leaseOwner: takeover.owner,
        leaseGeneration: takeover.generation,
      });
      expect(resumed.status).toBe("running");
      expect(resumed.wait_reason).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a failover never counts capacity itself",
    async () => {
      requireSchema();
      const { operationId } = await openFrozenOperation();
      const fence = await claim(operationId, "worker-a");
      // Terminal must be reachable straight from a capacity wait: the wait fields
      // are cleared with the status, not left behind to fail the shape check.
      await agentFailoverRepository.markAwaitingCapacity({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        reason: "no_target_capacity",
      });
      const finished = await agentFailoverRepository.finishOperation({
        operationId,
        leaseOwner: fence.owner,
        leaseGeneration: fence.generation,
        status: "blocked_no_backup",
        errorCode: "AGENT_BACKUP_NOT_RESTORABLE",
        errorMessage: "no restore-verified backup for this agent",
      });
      expect(finished.status).toBe("blocked_no_backup");
      expect(finished.wait_reason).toBeNull();
      expect(finished.wait_deadline_at).toBeNull();
      // The restore authority owns the slot on `docker_nodes`; this module never
      // touched it, so the pre-seeded counts are unchanged.
      const source = await scalar<{ allocated_count: number }>(
        `SELECT allocated_count FROM docker_nodes WHERE id = '${SOURCE_NODE_ID}'`,
      );
      const target = await scalar<{ allocated_count: number }>(
        `SELECT allocated_count FROM docker_nodes WHERE id = '${TARGET_NODE_ID}'`,
      );
      expect(source?.allocated_count).toBe(1);
      expect(target?.allocated_count).toBe(0);
    },
    TIMEOUT,
  );
});

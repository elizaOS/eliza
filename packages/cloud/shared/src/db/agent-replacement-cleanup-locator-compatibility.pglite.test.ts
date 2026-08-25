/** Proves expand and runtime convergence preserve every valid replacement-cleanup locator shape on real PGlite. */

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { convergeAgentSandboxSchema } from "./ensure-agent-sandbox-schema";
import { createMigrationClientSandboxExecutor } from "./migration-sandbox-schema-executor";

const migrationsDir = join(import.meta.dir, "migrations");
const historicalMigration = readFileSync(
  join(migrationsDir, "0182_warm_claim_credential_fence.sql"),
  "utf8",
);
const compatibilityMigration = readFileSync(
  join(migrationsDir, "0324_agent_replacement_cleanup_occurrence_compatibility.sql"),
  "utf8",
);
const historicalConstraintStart = historicalMigration.indexOf(
  'ALTER TABLE "agent_sandboxes"\n  DROP CONSTRAINT IF EXISTS "agent_sandboxes_replacement_cleanup_locator_check";',
);
const historicalConstraintEnd = historicalMigration.indexOf(
  'CREATE INDEX IF NOT EXISTS "agent_sandboxes_warm_claim_pending_idx"',
  historicalConstraintStart,
);

if (historicalConstraintStart < 0 || historicalConstraintEnd < 0) {
  throw new Error("Historical replacement-cleanup locator constraint was not found");
}

const historicalConstraint = historicalMigration.slice(
  historicalConstraintStart,
  historicalConstraintEnd,
);
const ATTEMPT_ID = "4f5358c9-67d1-4e74-b829-0f6bc63f72d3";
const NODE_RECORD_ID = "12aa4eba-2eb2-43c5-ae9e-899df93df617";
const NODE_INCARNATION = "28b4abbb-a964-4e4c-bfff-c9a420fa4938";
const NODE_HISTORY_ID = "710b96cb-2ce7-4e99-8d3d-101cae1a49f3";
const CONTAINER_ID = "a".repeat(64);

interface Locator {
  id: string;
  sandboxId: string | null;
  nodeId: string | null;
  nodeRecordId: string | null;
  nodeIncarnation: string | null;
  nodeHistoryId: string | null;
  nodeHostname: string | null;
  nodeSshPort: number | null;
  nodeSshUser: string | null;
  nodeHostKeyFingerprint: string | null;
  secretCleanupVersion: number | null;
  containerName: string | null;
  attemptId: string | null;
  containerId: string | null;
  vpnNodeId: string | null;
  vpnNodeName: string | null;
  preservedVpnNodeId: string | null;
  vpnRegistrationStartedAt: string | null;
  allocationCounted: boolean | null;
  createdAt: string | null;
}

const emptyLocator: Omit<Locator, "id"> = {
  sandboxId: null,
  nodeId: null,
  nodeRecordId: null,
  nodeIncarnation: null,
  nodeHistoryId: null,
  nodeHostname: null,
  nodeSshPort: null,
  nodeSshUser: null,
  nodeHostKeyFingerprint: null,
  secretCleanupVersion: null,
  containerName: null,
  attemptId: null,
  containerId: null,
  vpnNodeId: null,
  vpnNodeName: null,
  preservedVpnNodeId: null,
  vpnRegistrationStartedAt: null,
  allocationCounted: null,
  createdAt: null,
};

const logicalLocator: Partial<Locator> = {
  sandboxId: "cleanup-container",
  nodeId: "node-1",
  containerName: "cleanup-container",
  allocationCounted: true,
  createdAt: "2026-08-25T08:00:00.000Z",
};

const exactOccurrence: Partial<Locator> = {
  nodeRecordId: NODE_RECORD_ID,
  nodeIncarnation: NODE_INCARNATION,
  nodeHistoryId: NODE_HISTORY_ID,
  nodeHostname: "node-1.internal",
  nodeSshPort: 22,
  nodeSshUser: "root",
  nodeHostKeyFingerprint: "SHA256:node-1",
};

const databases: PGlite[] = [];

async function databaseWithHistoricalConstraint(): Promise<PGlite> {
  const database = new PGlite();
  databases.push(database);
  await database.exec(`
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      replacement_cleanup_sandbox_id text,
      replacement_cleanup_node_id text,
      replacement_cleanup_node_record_id uuid,
      replacement_cleanup_node_incarnation uuid,
      replacement_cleanup_node_history_id uuid,
      replacement_cleanup_node_hostname text,
      replacement_cleanup_node_ssh_port integer,
      replacement_cleanup_node_ssh_user text,
      replacement_cleanup_node_host_key_fingerprint text,
      replacement_cleanup_secret_cleanup_version integer,
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
  `);
  await database.exec(historicalConstraint);
  return database;
}

async function applyCompatibility(database: PGlite): Promise<void> {
  for (const statement of compatibilityMigration.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) await database.exec(statement);
  }
}

function locator(overrides: Partial<Locator> = {}): Locator {
  return { id: randomUUID(), ...emptyLocator, ...overrides };
}

async function insertLocator(database: PGlite, value: Locator): Promise<void> {
  await database.query(
    `INSERT INTO agent_sandboxes (
      id, replacement_cleanup_sandbox_id, replacement_cleanup_node_id,
      replacement_cleanup_node_record_id, replacement_cleanup_node_incarnation,
      replacement_cleanup_node_history_id, replacement_cleanup_node_hostname,
      replacement_cleanup_node_ssh_port, replacement_cleanup_node_ssh_user,
      replacement_cleanup_node_host_key_fingerprint,
      replacement_cleanup_secret_cleanup_version, replacement_cleanup_container_name,
      replacement_cleanup_attempt_id, replacement_cleanup_container_id,
      replacement_cleanup_vpn_node_id, replacement_cleanup_vpn_node_name,
      replacement_cleanup_preserved_vpn_node_id,
      replacement_cleanup_vpn_registration_started_at,
      replacement_cleanup_allocation_counted, replacement_cleanup_created_at
    ) VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10,
      $11, $12, $13::uuid, $14, $15, $16, $17, $18::timestamptz, $19,
      $20::timestamptz)`,
    [
      value.id,
      value.sandboxId,
      value.nodeId,
      value.nodeRecordId,
      value.nodeIncarnation,
      value.nodeHistoryId,
      value.nodeHostname,
      value.nodeSshPort,
      value.nodeSshUser,
      value.nodeHostKeyFingerprint,
      value.secretCleanupVersion,
      value.containerName,
      value.attemptId,
      value.containerId,
      value.vpnNodeId,
      value.vpnNodeName,
      value.preservedVpnNodeId,
      value.vpnRegistrationStartedAt,
      value.allocationCounted,
      value.createdAt,
    ],
  );
}

function legacyLocator(): Locator {
  return locator({ ...logicalLocator, attemptId: ATTEMPT_ID });
}

function exactCandidate(overrides: Partial<Locator> = {}): Locator {
  return locator({
    ...logicalLocator,
    ...exactOccurrence,
    attemptId: ATTEMPT_ID,
    secretCleanupVersion: 1,
    ...overrides,
  });
}

function exactPreviousPrimary(overrides: Partial<Locator> = {}): Locator {
  return locator({
    ...logicalLocator,
    ...exactOccurrence,
    attemptId: ATTEMPT_ID,
    containerId: CONTAINER_ID,
    vpnNodeId: "old-primary-vpn-node-id",
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("0324 replacement-cleanup locator compatibility", () => {
  test("replaces 0182 and replays while accepting null, legacy, candidate, and primary bundles", async () => {
    const database = await databaseWithHistoricalConstraint();
    await expect(insertLocator(database, exactPreviousPrimary())).rejects.toThrow(
      /agent_sandboxes_replacement_cleanup_locator_check/,
    );

    await applyCompatibility(database);
    await applyCompatibility(database);
    await insertLocator(database, locator());
    await insertLocator(database, legacyLocator());
    await insertLocator(
      database,
      exactCandidate({
        containerId: "c".repeat(64),
        vpnNodeId: "candidate-vpn-node-id",
        vpnNodeName: "candidate-vpn-node",
        vpnRegistrationStartedAt: "2026-08-25T08:01:00.000Z",
      }),
    );
    await insertLocator(database, exactPreviousPrimary());

    const rows = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM agent_sandboxes",
    );
    expect(rows.rows).toEqual([{ count: 4 }]);
  });

  test("rejects partial bundles and forged candidate or previous-primary authority", async () => {
    const database = await databaseWithHistoricalConstraint();
    await applyCompatibility(database);
    const invalidLocators = [
      locator({ nodeRecordId: NODE_RECORD_ID }),
      locator({ sandboxId: "partial-core" }),
      locator({ ...logicalLocator, nodeRecordId: NODE_RECORD_ID, attemptId: ATTEMPT_ID }),
      exactCandidate({ secretCleanupVersion: null }),
      exactCandidate({ attemptId: null }),
      exactCandidate({
        vpnNodeName: "candidate-vpn",
        vpnRegistrationStartedAt: null,
      }),
      exactPreviousPrimary({ attemptId: null }),
      exactPreviousPrimary({ containerId: "b".repeat(63) }),
      exactPreviousPrimary({ containerId: "B".repeat(64) }),
      exactPreviousPrimary({ vpnNodeName: "forged-primary-vpn" }),
      locator({ ...logicalLocator, containerId: CONTAINER_ID }),
    ];

    for (const invalid of invalidLocators) {
      await expect(insertLocator(database, invalid)).rejects.toThrow(/replacement_cleanup/);
    }
  });

  test("runtime convergence replaces the historical check with the same exact contract", async () => {
    const database = await databaseWithHistoricalConstraint();
    await expect(insertLocator(database, exactPreviousPrimary())).rejects.toThrow(
      /agent_sandboxes_replacement_cleanup_locator_check/,
    );
    let replacements = 0;
    const executor = createMigrationClientSandboxExecutor(async (text, params) => {
      if (
        !text.includes(
          'DROP CONSTRAINT IF EXISTS "agent_sandboxes_replacement_cleanup_locator_check"',
        )
      ) {
        return { rows: [] };
      }
      replacements += 1;
      return database.query(text, params);
    });

    await convergeAgentSandboxSchema(executor);
    await insertLocator(database, exactPreviousPrimary());
    await convergeAgentSandboxSchema(executor);
    await insertLocator(database, exactCandidate());
    expect(replacements).toBe(2);

    const definition = await database.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'agent_sandboxes_replacement_cleanup_locator_check'
    `);
    expect(definition.rows).toHaveLength(1);
    expect(definition.rows[0]?.definition).toContain("replacement_cleanup_node_record_id");
    expect(definition.rows[0]?.definition).toContain("^[0-9a-f]{64}$");
  });
});

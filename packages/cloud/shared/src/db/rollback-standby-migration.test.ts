/**
 * Applies the rollback-standby migration to real PGlite and proves its durable
 * identity contract rejects partial or phase-inconsistent lifecycle rows.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const AGENT_ID = "00000000-0000-4000-8000-000000017183";
const SOURCE_JOB_ID = "00000000-0000-4000-8000-000000117183";
const ROLLOUT_ID = "00000000-0000-4000-8000-000000217183";
const BLUE_ATTEMPT_ID = "00000000-0000-4000-8000-000000317183";
const DECISION_JOB_ID = "00000000-0000-4000-8000-000000417183";
const BACKUP_ID = "00000000-0000-4000-8000-000000517183";
const RESTORE_VALIDATION_ID = "00000000-0000-4000-8000-000000617183";
const RESTORE_CANDIDATE_ATTEMPT_ID = "00000000-0000-4000-8000-000000717183";
const RESTORE_AGGREGATE_SHA256 = "c".repeat(64);
const migrationUrl = new URL("./migrations/0188_rollback_standby_state.sql", import.meta.url);

let dbWrite: typeof import("./client").dbWrite;
let closeDb: typeof import("./client").closeDatabaseConnectionsForTests | undefined;
let databaseReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("./client"));
    await dbWrite.execute(`
      CREATE TABLE "agent_sandboxes" (
        "id" uuid PRIMARY KEY,
        "status" text NOT NULL DEFAULT 'pending',
        "deletion_attempt_id" uuid,
        "deletion_started_at" timestamp with time zone
      );
    `);
    const migration = readFileSync(fileURLToPath(migrationUrl), "utf8");
    for (const statement of migration.split(/;\s*(?=ALTER TABLE|CREATE INDEX|$)/)) {
      if (statement.trim()) await dbWrite.execute(statement);
    }
  } catch (error) {
    databaseReady = false;
    console.warn("[rollback-standby-migration] PGlite setup failed", error);
  }
}, TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

function validStandbyColumns(state: "pausing" | "paused", agentId = AGENT_ID): string {
  return `
    "rollback_standby_state",
    "rollback_standby_generation",
    "rollback_standby_rollout_id",
    "rollback_standby_source_job_id",
    "rollback_standby_sandbox_id",
    "rollback_standby_node_id",
    "rollback_standby_container_name",
    "rollback_standby_container_id",
    "rollback_standby_bridge_url",
    "rollback_standby_health_url",
    "rollback_standby_bridge_port",
    "rollback_standby_web_ui_port",
    "rollback_standby_headscale_ip",
    "rollback_standby_vpn_node_id",
    "rollback_standby_docker_image",
    "rollback_standby_image_digest",
    "rollback_standby_environment_revision",
    "rollback_standby_allocation_counted",
    "rollback_standby_primary_sandbox_id",
    "rollback_standby_primary_node_id",
    "rollback_standby_primary_container_name",
    "rollback_standby_primary_container_id",
    "rollback_standby_primary_vpn_node_id",
    "rollback_standby_primary_replacement_attempt_id",
    "rollback_standby_created_at"
  ) VALUES (
    '${agentId}',
    '${state}',
    '${SOURCE_JOB_ID}',
    '${ROLLOUT_ID}',
    '${SOURCE_JOB_ID}',
    'old-sandbox',
    'old-node',
    'old-container',
    ${state === "pausing" ? "NULL" : "'sha256:old-container'"},
    'https://old.example',
    'https://old.example/api/health',
    2137,
    2138,
    '100.64.0.10',
    'old-vpn',
    'ghcr.io/elizaos/eliza:sha-old',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    7,
    TRUE,
    'blue-sandbox',
    'blue-node',
    'blue-container',
    'sha256:blue-container',
    'blue-vpn',
    '${BLUE_ATTEMPT_ID}',
    NOW()
  )`;
}

async function expectStandbyConstraintViolation(query: PromiseLike<unknown>): Promise<void> {
  try {
    await query;
    throw new Error("Expected rollback standby contract violation");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const cause = error instanceof Error ? error.cause : undefined;
    const diagnostic = `${error instanceof Error ? error.message : ""} ${
      cause instanceof Error ? cause.message : ""
    }`;
    expect(diagnostic).toContain("agent_sandboxes_rollback_standby_contract_check");
  }
}

describe("0188 rollback standby state", () => {
  test("is registered once in the migration journal", () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const warmClaimEntries = journal.entries.filter(
      (entry) => entry.tag === "0182_warm_claim_credential_fence",
    );
    const rollbackStandbyEntries = journal.entries.filter(
      (entry) => entry.tag === "0188_rollback_standby_state",
    );
    expect(warmClaimEntries).toHaveLength(1);
    expect(rollbackStandbyEntries).toHaveLength(1);
    expect(rollbackStandbyEntries[0].idx).toBeGreaterThan(warmClaimEntries[0].idx);
    expect(rollbackStandbyEntries[0].when).toBeGreaterThan(warmClaimEntries[0].when);
    expect(
      journal.entries.findIndex((entry) => entry.tag === "0188_rollback_standby_state"),
    ).toBeGreaterThan(
      journal.entries.findIndex((entry) => entry.tag === "0182_warm_claim_credential_fence"),
    );
  });

  test("accepts the exact pausing and paused phases but rejects partial identity", async () => {
    expect(databaseReady).toBe(true);
    await dbWrite.execute(`
      INSERT INTO "agent_sandboxes" ("id", ${validStandbyColumns("pausing")};
    `);

    await expectStandbyConstraintViolation(
      dbWrite.execute(`
        INSERT INTO "agent_sandboxes" ("id", "rollback_standby_state")
        VALUES ('00000000-0000-4000-8000-000000417183', 'paused');
      `),
    );

    await expectStandbyConstraintViolation(
      dbWrite.execute(`
        UPDATE "agent_sandboxes"
        SET "rollback_standby_state" = 'paused'
        WHERE "id" = '${AGENT_ID}';
      `),
    );

    await dbWrite.execute(`
      UPDATE "agent_sandboxes"
      SET
        "rollback_standby_state" = 'paused',
        "rollback_standby_container_id" = 'sha256:old-container'
      WHERE "id" = '${AGENT_ID}';
    `);
    const persisted = await dbWrite.execute(`
      SELECT "rollback_standby_state", "rollback_standby_container_id"
      FROM "agent_sandboxes"
      WHERE "id" = '${AGENT_ID}';
    `);
    expect(persisted.rows).toEqual([
      {
        rollback_standby_state: "paused",
        rollback_standby_container_id: "sha256:old-container",
      },
    ]);

    await expectStandbyConstraintViolation(
      dbWrite.execute(`
        UPDATE "agent_sandboxes"
        SET
          "rollback_standby_state" = 'retiring',
          "rollback_standby_decision_job_id" = '${DECISION_JOB_ID}',
          "rollback_standby_verified_backup_id" = '${BACKUP_ID}'
        WHERE "id" = '${AGENT_ID}';
      `),
    );

    await dbWrite.execute(`
      UPDATE "agent_sandboxes"
      SET
        "rollback_standby_state" = 'retiring',
        "rollback_standby_decision_job_id" = '${DECISION_JOB_ID}',
        "rollback_standby_verified_backup_id" = '${BACKUP_ID}',
        "rollback_standby_restore_validation_id" = '${RESTORE_VALIDATION_ID}',
        "rollback_standby_restore_validation_aggregate_sha256" = '${RESTORE_AGGREGATE_SHA256}',
        "rollback_standby_restore_candidate_provider_sandbox_id" =
          'restore-candidate-217183',
        "rollback_standby_restore_candidate_replacement_attempt_id" =
          '${RESTORE_CANDIDATE_ATTEMPT_ID}'
      WHERE "id" = '${AGENT_ID}';
    `);
    const retiring = await dbWrite.execute(`
      SELECT
        "rollback_standby_state",
        "rollback_standby_restore_validation_id",
        "rollback_standby_restore_validation_aggregate_sha256",
        "rollback_standby_restore_candidate_provider_sandbox_id",
        "rollback_standby_restore_candidate_replacement_attempt_id"
      FROM "agent_sandboxes"
      WHERE "id" = '${AGENT_ID}';
    `);
    expect(retiring.rows).toEqual([
      {
        rollback_standby_state: "retiring",
        rollback_standby_restore_validation_id: RESTORE_VALIDATION_ID,
        rollback_standby_restore_validation_aggregate_sha256: RESTORE_AGGREGATE_SHA256,
        rollback_standby_restore_candidate_provider_sandbox_id: "restore-candidate-217183",
        rollback_standby_restore_candidate_replacement_attempt_id: RESTORE_CANDIDATE_ATTEMPT_ID,
      },
    ]);
  });

  test("creates the partial pending index", async () => {
    expect(databaseReady).toBe(true);
    const indexes = await dbWrite.execute(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'agent_sandboxes'
        AND indexname = 'agent_sandboxes_rollback_standby_pending_idx';
    `);
    expect(indexes.rows).toEqual([{ indexname: "agent_sandboxes_rollback_standby_pending_idx" }]);
  });
});

test("PGlite schema applied — rollback standby migration proofs never silently skip", () => {
  expect(databaseReady).toBe(true);
});

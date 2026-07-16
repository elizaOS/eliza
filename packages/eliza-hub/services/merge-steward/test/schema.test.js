import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { QUEUE_STATES } from "../src/policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPaths = [
  join(__dirname, "..", "db", "migrations", "001_steward_runtime.sql"),
  join(__dirname, "..", "db", "migrations", "002_postgres_store_payloads.sql"),
  join(__dirname, "..", "db", "migrations", "003_agent_claims.sql"),
  join(__dirname, "..", "db", "migrations", "004_run_success_status.sql"),
  join(__dirname, "..", "db", "migrations", "005_active_queue_lane_locks.sql"),
];
const workPagesMigrationPath = join(
  __dirname,
  "..",
  "db",
  "migrations",
  "010_work_pages.sql",
);

describe("production database schema", () => {
  it("defines the steward runtime tables and core indexes", async () => {
    const sql = await migrationSql();

    for (const table of [
      "steward_queue_items",
      "steward_runs",
      "steward_run_nodes",
      "steward_attempts",
      "steward_run_events",
      "steward_approvals",
      "steward_human_requests",
      "steward_signals",
      "steward_webhook_deliveries",
      "steward_repo_policies",
      "steward_events",
      "steward_agent_claims",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }

    assert.match(
      sql,
      /DROP INDEX IF EXISTS steward_queue_items_running_lane_idx/,
    );
    assert.match(
      sql,
      /steward_queue_items_active_lane_idx[\s\S]+WHERE queue_state IN \('running', 'building_integration'\)/,
    );
    assert.match(
      sql,
      /pg_advisory_xact_lock\(hashtext\(candidate_row\.repo\), hashtext\(candidate_row\.target_branch\)\)/,
    );
    assert.match(sql, /UNIQUE \(provider, delivery_id\)/);
    assert.match(sql, /UNIQUE \(run_id, seq\)/);
    assert.match(sql, /UNIQUE \(run_id, node_id, iteration, attempt\)/);
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /payload_json jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(sql, /steward_events_delivery_id_idx/);
    assert.match(sql, /UNIQUE \(repo, resource_kind, resource_id\)/);
  });

  it("keeps queue, run, attempt, approval, signal, claim, and repo policy states constrained", async () => {
    const sql = await migrationSql();

    assert.match(
      sql,
      /queue_state IN \([\s\S]+'observed'[\s\S]+'queued'[\s\S]+'running'[\s\S]+'merged'[\s\S]+'failed'/,
    );
    for (const queueState of Object.values(QUEUE_STATES)) {
      assert.match(sql, new RegExp(`'${queueState}'`));
    }
    assert.match(
      sql,
      /status IN \([\s\S]+'waiting_approval'[\s\S]+'waiting_event'[\s\S]+'recovering'/,
    );
    assert.match(
      sql,
      /steward_runs_status_check CHECK \([\s\S]+'succeeded'[\s\S]+'failed'/,
    );
    assert.match(
      sql,
      /status IN \([\s\S]+'running'[\s\S]+'recovering'[\s\S]+'succeeded'[\s\S]+'failed'[\s\S]+'cancelled'/,
    );
    assert.match(
      sql,
      /status IN \('requested', 'approved', 'denied', 'expired', 'cancelled'\)/,
    );
    assert.match(
      sql,
      /status IN \('received', 'consumed', 'expired', 'ignored'\)/,
    );
    assert.match(
      sql,
      /status IN \('active', 'released', 'expired', 'cancelled'\)/,
    );
    assert.match(sql, /queue_mode IN \('disabled', 'serialized', 'batched'\)/);
  });

  it("defines durable work pages for agent planning context", async () => {
    const sql = await readFile(workPagesMigrationPath, "utf8");

    assert.match(sql, /CREATE TABLE IF NOT EXISTS steward_work_pages\b/);
    assert.match(
      sql,
      /kind IN \('agent_plan', 'runbook', 'release_note', 'decision', 'spec', 'note'\)/,
    );
    assert.match(sql, /state IN \('active', 'archived'\)/);
    assert.match(sql, /body_format text NOT NULL DEFAULT 'markdown'/);
    assert.match(sql, /payload_json jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(sql, /steward_work_pages_work_item_idx/);
    assert.match(sql, /steward_work_pages_pull_request_idx/);
  });
});

async function migrationSql() {
  const migrations = await Promise.all(
    migrationPaths.map((migrationPath) => readFile(migrationPath, "utf8")),
  );
  return migrations.join("\n");
}

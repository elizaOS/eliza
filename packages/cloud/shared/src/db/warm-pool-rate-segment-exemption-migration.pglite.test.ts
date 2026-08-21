/** Proves 0297 corrects warm-pool rate authority without rewriting billing history. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const ORG = "00000000-0000-4000-8000-000000000011";
const POOL_LEGACY = "00000000-0000-4000-8000-000000000101";
const POOL_ALREADY_EXEMPT = "00000000-0000-4000-8000-000000000102";
const DEDICATED = "00000000-0000-4000-8000-000000000103";
const SHARED = "00000000-0000-4000-8000-000000000104";

const migration = readFileSync(
  new URL("./migrations/0297_warm_pool_rate_segment_exemption.sql", import.meta.url),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const schemaSql = `
  CREATE TABLE agent_sandboxes (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    status text NOT NULL,
    execution_tier text NOT NULL,
    last_backup_at timestamptz,
    lifecycle_revision bigint NOT NULL DEFAULT 0,
    pool_status text
  );
  CREATE TABLE compute_billing_rate_segments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    workload_kind text NOT NULL,
    workload_id uuid NOT NULL,
    lifecycle_revision bigint NOT NULL,
    billing_state text NOT NULL,
    rate_per_hour numeric(16,6) NOT NULL,
    effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
`;

// Exact pre-0297 agent classification and trigger column list from 0265.
const oldRateTriggerSql = `
  CREATE FUNCTION append_agent_compute_billing_rate_segment() RETURNS trigger AS $$
  DECLARE next_state text;
  DECLARE next_rate numeric(16,6);
  BEGIN
    next_state := CASE
      WHEN NEW.execution_tier = 'shared' THEN 'exempt'
      WHEN NEW.status = 'running' THEN 'running'
      WHEN NEW.status = 'stopped' AND NEW.last_backup_at IS NOT NULL THEN 'backup'
      ELSE 'not_billable'
    END;
    next_rate := CASE next_state WHEN 'running' THEN 0.010000
      WHEN 'backup' THEN 0.002500 ELSE 0.000000 END;
    IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.execution_tier, NEW.last_backup_at)
        IS DISTINCT FROM ROW(OLD.status, OLD.execution_tier, OLD.last_backup_at) THEN
      INSERT INTO compute_billing_rate_segments
        (organization_id, workload_kind, workload_id, lifecycle_revision,
         billing_state, rate_per_hour, effective_at)
      VALUES (NEW.organization_id, 'agent', NEW.id, NEW.lifecycle_revision,
        next_state, next_rate, clock_timestamp());
    END IF;
    RETURN NEW;
  END $$ LANGUAGE plpgsql;
  CREATE TRIGGER agent_compute_billing_rate_segment_append
    AFTER INSERT OR UPDATE OF status, execution_tier, last_backup_at
    ON agent_sandboxes FOR EACH ROW
    EXECUTE FUNCTION append_agent_compute_billing_rate_segment();
`;

interface SegmentRow {
  id: string;
  workload_id: string;
  billing_state: string;
  rate_per_hour: string;
}

let database: PGlite;
let historicalSegments: SegmentRow[];

beforeAll(async () => {
  database = new PGlite();
  await database.exec(schemaSql);
  await database.exec(oldRateTriggerSql);
  await database.exec(`
    INSERT INTO agent_sandboxes
      (id, organization_id, status, execution_tier, lifecycle_revision, pool_status)
    VALUES
      ('${POOL_LEGACY}', '${ORG}', 'running', 'dedicated-always', 10, 'unclaimed'),
      ('${POOL_ALREADY_EXEMPT}', '${ORG}', 'running', 'dedicated-always', 20, 'unclaimed'),
      ('${DEDICATED}', '${ORG}', 'running', 'dedicated-always', 30, NULL),
      ('${SHARED}', '${ORG}', 'running', 'shared', 40, NULL);
    UPDATE compute_billing_rate_segments
      SET effective_at = '2026-08-20T00:00:00Z';
    INSERT INTO compute_billing_rate_segments
      (organization_id, workload_kind, workload_id, lifecycle_revision,
       billing_state, rate_per_hour, effective_at)
    VALUES ('${ORG}', 'agent', '${POOL_ALREADY_EXEMPT}', 20,
      'exempt', 0.000000, '2026-08-20T01:00:00Z');
  `);
  const before = await database.query<SegmentRow>(`
    SELECT id::text, workload_id::text, billing_state, rate_per_hour::text
    FROM compute_billing_rate_segments ORDER BY workload_id, effective_at, id
  `);
  historicalSegments = before.rows;
  await database.exec(`
    CREATE FUNCTION reject_rate_segment_rewrite() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'compute billing rate history is immutable';
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER compute_billing_rate_segments_immutable
      BEFORE UPDATE OR DELETE ON compute_billing_rate_segments FOR EACH ROW
      EXECUTE FUNCTION reject_rate_segment_rewrite();
  `);
  await database.exec(migration);
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("warm-pool rate-segment exemption migration", () => {
  test("is limited to append-only rate classification", () => {
    expect(migration).toContain("NEW.pool_status IS NOT NULL OR NEW.execution_tier = 'shared'");
    expect(migration).toContain("UPDATE OF status, execution_tier, last_backup_at, pool_status");
    expect(migration).not.toContain("UPDATE compute_billing_rate_segments");
    expect(migration).not.toContain("DELETE FROM compute_billing_rate_segments");
    expect(migration).not.toContain("agent_compute_stop_intents");
    expect(migration).not.toContain("job_execution_leases");
    expect(migration).not.toContain("billing_status");
  });

  test("preserves every historical row and appends only the missing pool correction", async () => {
    const after = await database.query<SegmentRow>(`
      SELECT id::text, workload_id::text, billing_state, rate_per_hour::text
      FROM compute_billing_rate_segments ORDER BY workload_id, effective_at, id
    `);
    const preserved = after.rows.filter((row) =>
      historicalSegments.some((historical) => historical.id === row.id),
    );
    expect(preserved).toEqual(historicalSegments);

    const byWorkload = after.rows.reduce<Record<string, SegmentRow[]>>((grouped, row) => {
      (grouped[row.workload_id] ??= []).push(row);
      return grouped;
    }, {});
    expect(
      byWorkload[POOL_LEGACY]?.map(({ billing_state, rate_per_hour }) => ({
        billing_state,
        rate_per_hour,
      })),
    ).toEqual([
      { billing_state: "running", rate_per_hour: "0.010000" },
      { billing_state: "exempt", rate_per_hour: "0.000000" },
    ]);
    expect(byWorkload[POOL_ALREADY_EXEMPT]).toHaveLength(2);
    expect(byWorkload[DEDICATED]?.at(-1)).toMatchObject({
      billing_state: "running",
      rate_per_hour: "0.010000",
    });
    expect(byWorkload[SHARED]?.at(-1)).toMatchObject({
      billing_state: "exempt",
      rate_per_hour: "0.000000",
    });
  });

  test("classifies every future pool transition at zero without changing non-pool prices", async () => {
    const beforeUnrelated = await database.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM compute_billing_rate_segments
      WHERE workload_id = '${DEDICATED}'
    `);
    await database.exec(`
      UPDATE agent_sandboxes SET lifecycle_revision = lifecycle_revision + 1
        WHERE id = '${DEDICATED}';
    `);
    const afterUnrelated = await database.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM compute_billing_rate_segments
      WHERE workload_id = '${DEDICATED}'
    `);
    expect(afterUnrelated.rows).toEqual(beforeUnrelated.rows);

    await database.exec(`
      UPDATE agent_sandboxes SET status = 'stopped', last_backup_at = now()
        WHERE id IN ('${POOL_LEGACY}', '${DEDICATED}');
      UPDATE agent_sandboxes SET pool_status = 'unclaimed'
        WHERE id = '${DEDICATED}';
    `);
    const latest = await database.query<{
      workload_id: string;
      billing_state: string;
      rate_per_hour: string;
    }>(`
      SELECT DISTINCT ON (workload_id) workload_id::text, billing_state, rate_per_hour::text
      FROM compute_billing_rate_segments
      WHERE workload_id IN ('${POOL_LEGACY}', '${DEDICATED}')
      ORDER BY workload_id, effective_at DESC, id DESC
    `);
    expect(latest.rows).toEqual([
      { workload_id: POOL_LEGACY, billing_state: "exempt", rate_per_hour: "0.000000" },
      { workload_id: DEDICATED, billing_state: "exempt", rate_per_hour: "0.000000" },
    ]);

    await database.exec(`
      UPDATE agent_sandboxes SET pool_status = NULL WHERE id = '${DEDICATED}';
    `);
    const resumed = await database.query<{ billing_state: string; rate_per_hour: string }>(`
      SELECT billing_state, rate_per_hour::text
      FROM compute_billing_rate_segments WHERE workload_id = '${DEDICATED}'
      ORDER BY effective_at DESC, id DESC LIMIT 1
    `);
    expect(resumed.rows).toEqual([{ billing_state: "backup", rate_per_hour: "0.002500" }]);
  });

  test("does not append another correction when replayed against an exempt latest segment", async () => {
    const before = await database.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM compute_billing_rate_segments
    `);
    await database.exec(migration);
    const after = await database.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM compute_billing_rate_segments
    `);
    expect(after.rows).toEqual(before.rows);
  });
});

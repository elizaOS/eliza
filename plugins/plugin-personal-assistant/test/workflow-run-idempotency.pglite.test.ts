/**
 * Real-PGlite proof for workflow-run idempotency storage. The fixture starts
 * from the pre-idempotency schema so the same compatibility repair used in
 * production must add/backfill/index the column before repository claims run.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LifeOpsWorkflowRun } from "../src/contracts/index.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.ts";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const WORKFLOW_A = "workflow-a";
const WORKFLOW_B = "workflow-b";
const STARTED_AT = "2026-08-21T12:00:00.000Z";
const FINISHED_AT = "2026-08-21T12:01:00.000Z";

function createRuntime(pg: PGlite): IAgentRuntime {
  return {
    agentId: AGENT_A,
    adapter: { db: drizzle(pg) },
  } as unknown as IAgentRuntime;
}

function runningRun(args: {
  id: string;
  agentId?: string;
  workflowId?: string;
  idempotencyKey?: string | null;
}): LifeOpsWorkflowRun {
  return {
    id: args.id,
    agentId: args.agentId ?? AGENT_A,
    workflowId: args.workflowId ?? WORKFLOW_A,
    idempotencyKey: args.idempotencyKey ?? null,
    startedAt: STARTED_AT,
    finishedAt: null,
    status: "running",
    result: {},
    auditRef: null,
  };
}

async function createLegacyWorkflowRunsTable(pg: PGlite): Promise<void> {
  await pg.exec(`
    CREATE SCHEMA app_lifeops;
    CREATE TABLE app_lifeops.life_workflow_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      result_json TEXT NOT NULL DEFAULT '{}',
      audit_ref TEXT
    );
    CREATE INDEX idx_life_workflow_runs_workflow
      ON app_lifeops.life_workflow_runs (agent_id, workflow_id, started_at);
  `);
}

describe("LifeOps workflow-run idempotency storage (real PGlite)", () => {
  let pg: PGlite;
  let runtime: IAgentRuntime;
  let repository: LifeOpsRepository;

  beforeEach(async () => {
    pg = new PGlite();
    await createLegacyWorkflowRunsTable(pg);
    runtime = createRuntime(pg);
    repository = new LifeOpsRepository(runtime);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("backfills one recent legacy key per scope and creates the partial unique index", async () => {
    await pg.exec(`
      INSERT INTO app_lifeops.life_workflow_runs
        (id, agent_id, workflow_id, started_at, finished_at, status, result_json)
      VALUES
        ('legacy-old', '${AGENT_A}', '${WORKFLOW_A}',
         '2026-08-21T10:00:00.000Z', '${FINISHED_AT}', 'success',
         '{"idempotencyKey":"legacy-key"}'),
        ('legacy-new', '${AGENT_A}', '${WORKFLOW_A}',
         '2026-08-21T11:00:00.000Z', '${FINISHED_AT}', 'success',
         '{"idempotencyKey":"legacy-key"}'),
        ('legacy-other-agent', '${AGENT_B}', '${WORKFLOW_A}',
         '2026-08-21T09:00:00.000Z', '${FINISHED_AT}', 'success',
         '{"idempotencyKey":"legacy-key"}'),
        ('legacy-other-workflow', '${AGENT_A}', '${WORKFLOW_B}',
         '2026-08-21T09:00:00.000Z', '${FINISHED_AT}', 'success',
         '{"idempotencyKey":"legacy-key"}'),
        ('legacy-unkeyed', '${AGENT_A}', '${WORKFLOW_A}',
         '2026-08-21T08:00:00.000Z', '${FINISHED_AT}', 'success', '{}'),
        ('legacy-empty-key', '${AGENT_A}', '${WORKFLOW_A}',
         '2026-08-21T07:00:00.000Z', '${FINISHED_AT}', 'success',
         '{"idempotencyKey":""}'),
        ('legacy-non-string-key', '${AGENT_A}', '${WORKFLOW_A}',
         '2026-08-21T06:00:00.000Z', '${FINISHED_AT}', 'success',
         '{"idempotencyKey":42}'),
        ('legacy-nul-payload', '${AGENT_A}', '${WORKFLOW_A}',
         '2026-08-21T05:00:00.000Z', '${FINISHED_AT}', 'success',
         '{"idempotencyKey":"nul-payload-key","payload":"\\u0000"}'),
        ('legacy-malformed', '${AGENT_A}', '${WORKFLOW_A}',
         '2026-08-21T04:00:00.000Z', '${FINISHED_AT}', 'success',
         '{not-json');
    `);

    await LifeOpsRepository.ensureWorkflowRunIdempotencyKey(runtime);
    // The repair is a startup compatibility pass and must remain repeatable.
    await LifeOpsRepository.ensureWorkflowRunIdempotencyKey(runtime);

    const migrated = await pg.query<{
      id: string;
      idempotency_key: string | null;
    }>(`
      SELECT id, idempotency_key
        FROM app_lifeops.life_workflow_runs
       ORDER BY id
    `);
    const keysById = Object.fromEntries(
      migrated.rows.map((row) => [row.id, row.idempotency_key]),
    );
    expect(keysById).toMatchObject({
      "legacy-old": null,
      "legacy-new": "legacy-key",
      "legacy-other-agent": "legacy-key",
      "legacy-other-workflow": "legacy-key",
      "legacy-unkeyed": null,
      "legacy-empty-key": null,
      "legacy-non-string-key": null,
      "legacy-nul-payload": "nul-payload-key",
      "legacy-malformed": null,
    });

    const marker = await pg.query<{ description: string }>(`
      SELECT description.description
        FROM pg_catalog.pg_description AS description
        JOIN pg_catalog.pg_class AS index_class
          ON index_class.oid = description.objoid
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = index_class.relnamespace
       WHERE namespace.nspname = 'app_lifeops'
         AND index_class.relname = 'idx_life_workflow_runs_idempotency'
         AND description.classoid = 'pg_catalog.pg_class'::regclass
         AND description.objsubid = 0
    `);
    expect(marker.rows).toEqual([
      {
        description: "elizaos:life_workflow_runs:idempotency-backfill:v1",
      },
    ]);

    const indexes = await pg.query<{ indexdef: string }>(`
      SELECT indexdef
        FROM pg_indexes
       WHERE schemaname = 'app_lifeops'
         AND tablename = 'life_workflow_runs'
         AND indexname = 'idx_life_workflow_runs_idempotency'
    `);
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]?.indexdef).toMatch(
      /UNIQUE INDEX .*agent_id, workflow_id, idempotency_key.*WHERE \(idempotency_key IS NOT NULL\)/i,
    );

    await expect(
      pg.exec(`
        INSERT INTO app_lifeops.life_workflow_runs
          (id, agent_id, workflow_id, idempotency_key, started_at, status)
        VALUES
          ('duplicate-key', '${AGENT_A}', '${WORKFLOW_A}', 'legacy-key',
           '${STARTED_AT}', 'running')
      `),
    ).rejects.toThrow(/duplicate key|unique/i);

    await pg.exec(`
      INSERT INTO app_lifeops.life_workflow_runs
        (id, agent_id, workflow_id, idempotency_key, started_at, status)
      VALUES
        ('null-key-a', '${AGENT_A}', '${WORKFLOW_A}', NULL,
         '${STARTED_AT}', 'running'),
        ('null-key-b', '${AGENT_A}', '${WORKFLOW_A}', NULL,
         '${STARTED_AT}', 'running')
    `);
  });

  it("deduplicates a pre-index populated column before creating the unique index", async () => {
    await pg.exec(`
      ALTER TABLE app_lifeops.life_workflow_runs
        ADD COLUMN idempotency_key TEXT;
      INSERT INTO app_lifeops.life_workflow_runs
        (id, agent_id, workflow_id, idempotency_key, started_at, status)
      VALUES
        ('populated-old', '${AGENT_A}', '${WORKFLOW_A}', 'duplicate-key',
         '2026-08-21T10:00:00.000Z', 'success'),
        ('populated-new', '${AGENT_A}', '${WORKFLOW_A}', 'duplicate-key',
         '2026-08-21T11:00:00.000Z', 'success');
    `);

    await LifeOpsRepository.ensureWorkflowRunIdempotencyKey(runtime);

    const migrated = await pg.query<{
      id: string;
      idempotency_key: string | null;
    }>(`
      SELECT id, idempotency_key
        FROM app_lifeops.life_workflow_runs
       ORDER BY id
    `);
    expect(migrated.rows).toEqual([
      { id: "populated-new", idempotency_key: "duplicate-key" },
      { id: "populated-old", idempotency_key: null },
    ]);
  });

  it("backfills every row across the 500-row keyset page boundary", async () => {
    const rowCount = 503;
    const values = Array.from({ length: rowCount }, (_, index) => {
      const ordinal = String(index).padStart(4, "0");
      return `('paged-${ordinal}', '${AGENT_A}', '${WORKFLOW_A}',
        '2026-08-21T10:00:00.000Z', 'success',
        '{"idempotencyKey":"paged-key-${ordinal}"}')`;
    }).join(",\n");
    await pg.exec(`
      INSERT INTO app_lifeops.life_workflow_runs
        (id, agent_id, workflow_id, started_at, status, result_json)
      VALUES ${values};
    `);

    await LifeOpsRepository.ensureWorkflowRunIdempotencyKey(runtime);

    const migrated = await pg.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count
        FROM app_lifeops.life_workflow_runs
       WHERE idempotency_key IS NOT NULL
    `);
    expect(migrated.rows).toEqual([{ count: rowCount }]);

    const temporaryIndexes = await pg.query<{ indexname: string }>(`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'app_lifeops'
         AND indexname = 'idx_life_workflow_runs_idempotency_backfill_scan'
    `);
    expect(temporaryIndexes.rows).toEqual([]);
  });

  it("elects one concurrent keyed claimant, scopes keys, and CAS-finalizes only the winner", async () => {
    await LifeOpsRepository.ensureWorkflowRunIdempotencyKey(runtime);
    const contenders = Array.from({ length: 8 }, (_, index) =>
      runningRun({
        id: `contender-${index}`,
        idempotencyKey: "shared-key",
      }),
    );

    const outcomes = await Promise.all(
      contenders.map((run) => repository.claimWorkflowRun(run)),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winnerIndex = outcomes.findIndex((outcome) => outcome);
    const winner = contenders[winnerIndex];
    if (!winner) {
      throw new Error("expected one workflow-run claim winner");
    }

    const persistedWinner = await repository.getWorkflowRunByIdempotencyKey(
      AGENT_A,
      WORKFLOW_A,
      "shared-key",
    );
    expect(persistedWinner).toEqual(winner);
    expect(
      await repository.getWorkflowRunByIdempotencyKey(
        AGENT_B,
        WORKFLOW_A,
        "shared-key",
      ),
    ).toBeNull();
    expect(
      await repository.getWorkflowRunByIdempotencyKey(
        AGENT_A,
        WORKFLOW_B,
        "shared-key",
      ),
    ).toBeNull();

    expect(
      await repository.claimWorkflowRun(
        runningRun({
          id: "other-agent",
          agentId: AGENT_B,
          idempotencyKey: "shared-key",
        }),
      ),
    ).toBe(true);
    expect(
      await repository.claimWorkflowRun(
        runningRun({
          id: "other-workflow",
          workflowId: WORKFLOW_B,
          idempotencyKey: "shared-key",
        }),
      ),
    ).toBe(true);
    expect(
      await repository.claimWorkflowRun(
        runningRun({ id: "unkeyed-a", idempotencyKey: null }),
      ),
    ).toBe(true);
    expect(
      await repository.claimWorkflowRun(
        runningRun({ id: "unkeyed-b", idempotencyKey: null }),
      ),
    ).toBe(true);

    const loser = contenders.find((run) => run.id !== winner.id);
    if (!loser) {
      throw new Error("expected at least one losing workflow-run claimant");
    }
    expect(
      await repository.completeWorkflowRun({
        ...loser,
        finishedAt: FINISHED_AT,
        status: "success",
        result: { shouldNotPersist: true },
      }),
    ).toBe(false);
    expect(
      await repository.completeWorkflowRun({
        ...winner,
        idempotencyKey: "wrong-key",
        finishedAt: FINISHED_AT,
        status: "success",
        result: { shouldNotPersist: true },
      }),
    ).toBe(false);

    const completed: LifeOpsWorkflowRun = {
      ...winner,
      finishedAt: FINISHED_AT,
      status: "success",
      result: { output: "persisted-once" },
      auditRef: "audit-winner",
    };
    expect(await repository.completeWorkflowRun(completed)).toBe(true);
    expect(await repository.completeWorkflowRun(completed)).toBe(false);
    expect(
      await repository.getWorkflowRunByIdempotencyKey(
        AGENT_A,
        WORKFLOW_A,
        "shared-key",
      ),
    ).toEqual(completed);

    const unkeyedRuns = (
      await repository.listWorkflowRuns(AGENT_A, WORKFLOW_A)
    ).filter((run) => run.idempotencyKey === null);
    expect(unkeyedRuns.map((run) => run.id).sort()).toEqual([
      "unkeyed-a",
      "unkeyed-b",
    ]);
  });
});

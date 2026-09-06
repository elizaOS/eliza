/** Exercises work-thread merges against real PGlite transactions, including late conflicts, event failures, and replay. */
import { PGlite } from "@electric-sql/pglite";
import { stringToUuid } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkThreadRepository } from "../src/lifeops/repositories/work-threads.js";
import { OptimisticLockError } from "../src/lifeops/sql.js";
import type { WorkThread } from "../src/lifeops/work-threads/types.js";

const agentId = stringToUuid("work-thread-merge-pglite");
const timestamp = "2026-09-05T12:00:00.000Z";
function thread(id: string): WorkThread {
  return {
    id,
    agentId,
    title: id,
    summary: `Original ${id}`,
    status: "active",
    primarySourceRef: { connector: "test", roomId: id },
    sourceRefs: [{ connector: "test", roomId: id }],
    participantEntityIds: [],
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
  };
}

describe("atomic work-thread merges (real PGlite)", () => {
  let pg: PGlite;
  let repository: WorkThreadRepository;
  const target = thread("target");
  const first = thread("source-one");
  const second = thread("source-two");
  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE SCHEMA app_lifeops;
      CREATE TABLE app_lifeops.life_work_threads (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, owner_entity_id TEXT,
        status TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        current_plan_summary TEXT, primary_source_ref_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL, participant_entity_ids_json TEXT NOT NULL,
        current_scheduled_task_id TEXT, workflow_run_id TEXT, approval_id TEXT,
        last_message_memory_id TEXT, metadata_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, last_activity_at TEXT NOT NULL
      );
      CREATE TABLE app_lifeops.life_work_thread_events (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, work_thread_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL, type TEXT NOT NULL, reason TEXT, detail_json TEXT
      );
    `);
    repository = new WorkThreadRepository({
      agentId,
      adapter: { db: drizzle(pg) },
    });
    for (const row of [target, first, second])
      await repository.upsertWorkThread(agentId, row);
  });
  afterEach(async () => {
    await pg.close();
  });
  async function rows() {
    return (
      await pg.query("SELECT * FROM app_lifeops.life_work_threads ORDER BY id")
    ).rows;
  }
  async function events() {
    return (
      await pg.query(
        "SELECT * FROM app_lifeops.life_work_thread_events ORDER BY id",
      )
    ).rows;
  }
  function merge(sources = [first, second]) {
    return repository.mergeWorkThreadsAtomic({
      agentId,
      target,
      sources,
      mergeRequestId: "merge-request",
      nextTarget: {
        ...target,
        summary: "Merged work",
        sourceRefs: [
          target.primarySourceRef,
          ...sources.map((s) => s.primarySourceRef),
        ],
      },
    });
  }
  it("rolls back target and earlier source writes when a later source version conflicts", async () => {
    const before = await rows();
    await expect(
      merge([first, { ...second, version: 99 }]),
    ).rejects.toBeInstanceOf(OptimisticLockError);
    expect(await rows()).toEqual(before);
    expect(await events()).toEqual([]);
  });
  it("rolls back all state and the target event if a source event insert fails", async () => {
    const before = await rows();
    await pg.exec(
      "ALTER TABLE app_lifeops.life_work_thread_events ADD CONSTRAINT reject_source_event CHECK (type <> 'merged_into')",
    );
    await expect(merge()).rejects.toThrow();
    expect(await rows()).toEqual(before);
    expect(await events()).toEqual([]);
  });
  it("commits state and events together and replays the durable result without another write", async () => {
    const result = await merge();
    expect(result).toEqual({
      targetWorkThreadId: target.id,
      sourceWorkThreadIds: [first.id, second.id],
    });
    expect(await repository.getWorkThread(agentId, target.id)).toMatchObject({
      summary: "Merged work",
      status: "active",
      version: 2,
    });
    for (const source of [first, second]) {
      expect(await repository.getWorkThread(agentId, source.id)).toMatchObject({
        status: "stopped",
        version: 2,
        metadata: { mergedIntoWorkThreadId: target.id },
      });
    }
    expect(
      await repository.findWorkThreadMergeEvent({
        agentId,
        targetWorkThreadId: target.id,
        mergeRequestId: "merge-request",
      }),
    ).toMatchObject({ sourceWorkThreadIds: [first.id, second.id] });
    const committed = { rows: await rows(), events: await events() };
    expect(await merge()).toEqual(result);
    expect({ rows: await rows(), events: await events() }).toEqual(committed);
  });
});

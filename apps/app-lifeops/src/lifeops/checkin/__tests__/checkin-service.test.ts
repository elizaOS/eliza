import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CheckinService,
  __resetCheckinMissingSourceLog,
} from "../checkin-service.js";

interface CheckinTestHarness {
  runtime: IAgentRuntime;
  pgClient: PGlite;
  execute: (statement: string) => Promise<unknown>;
  close: () => Promise<void>;
}

const BOOTSTRAP_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS life_task_definitions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS life_task_occurrences (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    due_at TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

async function createCheckinHarness(
  agentId = "00000000-0000-0000-0000-000000000099",
): Promise<CheckinTestHarness> {
  const pgClient = new PGlite();
  const db = drizzle(pgClient);
  for (const statement of BOOTSTRAP_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
  const runtime = {
    agentId,
    adapter: { db },
  } as unknown as IAgentRuntime;
  return {
    runtime,
    pgClient,
    execute: (statement: string) => db.execute(sql.raw(statement)),
    close: async () => {
      await pgClient.close();
    },
  };
}

describe("CheckinService", () => {
  let harness: CheckinTestHarness;

  beforeEach(async () => {
    __resetCheckinMissingSourceLog();
    harness = await createCheckinHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("runMorningCheckin lists seeded overdue todos with escalation level 0", async () => {
    const agentId = String(harness.runtime.agentId);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await harness.execute(
      `INSERT INTO life_task_definitions (id, agent_id, title, status, created_at)
       VALUES ('def-1', '${agentId}', 'Drink water', 'active', '${createdAt}')`,
    );
    await harness.execute(
      `INSERT INTO life_task_occurrences (id, agent_id, definition_id, due_at, state, created_at, updated_at)
       VALUES ('occ-1', '${agentId}', 'def-1', '${yesterday}', 'pending', '${createdAt}', '${createdAt}')`,
    );

    const service = new CheckinService(harness.runtime);
    const report = await service.runMorningCheckin();

    expect(report.kind).toBe("morning");
    expect(report.escalationLevel).toBe(0);
    expect(report.overdueTodos).toHaveLength(1);
    expect(report.overdueTodos[0]).toMatchObject({
      id: "occ-1",
      title: "Drink water",
    });
    expect(report.todaysMeetings).toEqual([]);
    expect(report.yesterdaysWins).toEqual([]);
    expect(report.reportId).toMatch(/.+/);
    // overdue + wins share life_task_* tables (bootstrapped), so no error.
    expect(report.collectorErrors.overdueTodos).toBeNull();
    expect(report.collectorErrors.yesterdaysWins).toBeNull();
    // life_calendar_events is NOT bootstrapped in this harness, so the
    // meetings collector must surface an error rather than silently [] .
    expect(report.collectorErrors.todaysMeetings).toMatch(/.+/);
  });

  it("recordCheckinAcknowledgement clears unack count so next escalation returns to 0", async () => {
    const service = new CheckinService(harness.runtime);
    const first = await service.runMorningCheckin();
    expect(await service.getEscalationLevel()).toBe(1);
    await service.recordCheckinAcknowledgement({ reportId: first.reportId });
    expect(await service.getEscalationLevel()).toBe(0);
  });
});

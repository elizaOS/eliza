/**
 * Real-PGlite upgrade coverage for legacy session summaries. The frozen
 * pre-upgrade schema and row survive a close, current-schema boot, and reopen.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { PGliteClientManager } from "../../pglite/manager";
import { RuntimeMigrator } from "../../runtime-migrator/runtime-migrator";
import * as currentSqlSchema from "../../schema";

const LEGACY_PLUGIN_NAME = "@elizaos/plugin-sql";
const legacySessionSummaries = pgTable(
  "session_summaries",
  {
    id: uuid("id").primaryKey().notNull(),
    agentId: uuid("agent_id").notNull(),
    roomId: uuid("room_id").notNull(),
    entityId: uuid("entity_id"),
    summary: text("summary").notNull(),
    messageCount: integer("message_count").notNull(),
    lastMessageOffset: integer("last_message_offset").default(0).notNull(),
    startTime: timestamp("start_time").notNull(),
    endTime: timestamp("end_time").notNull(),
    topics: jsonb("topics").$type<string[]>(),
    metadata: jsonb("metadata"),
    embedding: real("embedding").array(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
  },
  (table) => [
    index("session_summaries_agent_room_idx").on(table.agentId, table.roomId),
    index("session_summaries_entity_idx").on(table.entityId),
    index("session_summaries_start_time_idx").on(table.startTime),
  ]
);

interface SessionSummaryRow {
  id: string;
  summary: string;
  message_count: number;
  last_message_offset: number;
  topics: string[] | null;
  metadata: Record<string, unknown> | null;
  embedding: number[] | null;
}

describe("legacy session summaries migration compatibility", () => {
  const managers: PGliteClientManager[] = [];
  const dataDirectories: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
    for (const dataDirectory of dataDirectories.splice(0)) {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  async function openDatabase(dataDirectory: string) {
    const manager = new PGliteClientManager({ dataDir: dataDirectory });
    managers.push(manager);
    await manager.initialize();
    return { manager, db: drizzle(manager.getConnection()) };
  }

  it("boots the current SQL schema without deleting a persisted legacy summary", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "session-summary-schema-upgrade-"));
    dataDirectories.push(dataDirectory);
    const summaryId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const roomId = crypto.randomUUID();
    const entityId = crypto.randomUUID();

    const firstBoot = await openDatabase(dataDirectory);
    const legacyMigrator = new RuntimeMigrator(firstBoot.db);
    await legacyMigrator.migrate(
      LEGACY_PLUGIN_NAME,
      { legacySessionSummaries },
      { verbose: false }
    );
    await firstBoot.db.execute(sql`
      INSERT INTO session_summaries (
        id,
        agent_id,
        room_id,
        entity_id,
        summary,
        message_count,
        last_message_offset,
        start_time,
        end_time,
        topics,
        metadata,
        embedding,
        created_at,
        updated_at
      ) VALUES (
        ${summaryId}::uuid,
        ${agentId}::uuid,
        ${roomId}::uuid,
        ${entityId}::uuid,
        'Owner prefers complete migration receipts.',
        42,
        37,
        '2026-08-22T12:00:00.000Z'::timestamp,
        '2026-08-22T12:30:00.000Z'::timestamp,
        ${JSON.stringify(["migration", "desktop"])}::jsonb,
        ${JSON.stringify({ source: "legacy-summarizer", durable: true })}::jsonb,
        ARRAY[0.125, -0.5, 0.75]::real[],
        '2026-08-22T12:31:00.000Z'::timestamp,
        '2026-08-22T12:32:00.000Z'::timestamp
      )
    `);
    await firstBoot.manager.close();

    const upgradedBoot = await openDatabase(dataDirectory);
    const currentMigrator = new RuntimeMigrator(upgradedBoot.db);
    await currentMigrator.migrate(LEGACY_PLUGIN_NAME, currentSqlSchema, { verbose: false });

    const result = await upgradedBoot.db.execute<SessionSummaryRow>(sql`
      SELECT
        id,
        summary,
        message_count,
        last_message_offset,
        topics,
        metadata,
        embedding
      FROM session_summaries
      WHERE id = ${summaryId}::uuid
    `);
    expect(result.rows).toEqual([
      {
        id: summaryId,
        summary: "Owner prefers complete migration receipts.",
        message_count: 42,
        last_message_offset: 37,
        topics: ["migration", "desktop"],
        metadata: { source: "legacy-summarizer", durable: true },
        embedding: [0.125, -0.5, 0.75],
      },
    ]);

    const indexes = await upgradedBoot.db.execute<{ indexname: string }>(sql`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'session_summaries'
       ORDER BY indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "session_summaries_agent_room_idx",
      "session_summaries_entity_idx",
      "session_summaries_pkey",
      "session_summaries_start_time_idx",
    ]);
  }, 120_000);
});

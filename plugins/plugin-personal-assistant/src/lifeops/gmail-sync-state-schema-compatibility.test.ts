/**
 * Real-PGlite upgrade coverage for the durable Gmail synchronization cursor.
 * The legacy fixture is independent from the current descriptor so removing a
 * persisted column makes the startup migration fail instead of weakening the test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { integer, pgSchema, text, unique } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { PGliteClientManager } from "../../../plugin-sql/src/pglite/manager.js";
import { RuntimeMigrator } from "../../../plugin-sql/src/runtime-migrator/runtime-migrator.js";
import { lifeOpsSchema } from "./schema.js";

const LEGACY_PLUGIN_NAME = "@elizaos/plugin-personal-assistant";
const legacyLifeOpsSchema = pgSchema("app_lifeops");
const legacyGmailSyncStates = legacyLifeOpsSchema.table(
  "life_gmail_sync_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    mailbox: text("mailbox").notNull(),
    grantId: text("grant_id"),
    maxResults: integer("max_results").notNull().default(0),
    historyId: text("history_id"),
    cursorStatus: text("cursor_status").notNull().default("seeded"),
    fullResyncReason: text("full_resync_reason"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique().on(
      table.agentId,
      table.provider,
      table.side,
      table.grantId,
      table.mailbox,
    ),
  ],
);

interface GmailSyncStateRow {
  id: string;
  history_id: string | null;
  cursor_status: string;
  full_resync_reason: string | null;
  max_results: number;
}

describe("Gmail sync-state schema compatibility", () => {
  const managers: PGliteClientManager[] = [];
  const dataDirectories: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      managers.splice(0).map((manager) => manager.close()),
    );
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

  it("boots the current schema over a legacy database without losing its cursor", async () => {
    const dataDirectory = mkdtempSync(
      join(tmpdir(), "lifeops-gmail-schema-upgrade-"),
    );
    dataDirectories.push(dataDirectory);

    const firstBoot = await openDatabase(dataDirectory);
    const legacyMigrator = new RuntimeMigrator(firstBoot.db);
    await legacyMigrator.migrate(
      LEGACY_PLUGIN_NAME,
      { legacyGmailSyncStates },
      { verbose: false },
    );
    await firstBoot.db.execute(sql`
      INSERT INTO app_lifeops.life_gmail_sync_states (
        id,
        agent_id,
        provider,
        side,
        mailbox,
        grant_id,
        max_results,
        history_id,
        cursor_status,
        full_resync_reason,
        synced_at,
        updated_at
      ) VALUES (
        'legacy-cursor',
        'legacy-agent',
        'google',
        'owner',
        'INBOX',
        'legacy-grant',
        250,
        '987654321',
        'incremental',
        'history-expired',
        '2026-08-22T12:00:00.000Z',
        '2026-08-22T12:00:01.000Z'
      )
    `);
    await firstBoot.manager.close();

    const upgradedBoot = await openDatabase(dataDirectory);
    const currentMigrator = new RuntimeMigrator(upgradedBoot.db);
    await currentMigrator.migrate(LEGACY_PLUGIN_NAME, lifeOpsSchema, {
      verbose: false,
    });

    const result = await upgradedBoot.db.execute<GmailSyncStateRow>(sql`
      SELECT id, history_id, cursor_status, full_resync_reason, max_results
        FROM app_lifeops.life_gmail_sync_states
       WHERE id = 'legacy-cursor'
    `);
    expect(result.rows).toEqual([
      {
        id: "legacy-cursor",
        history_id: "987654321",
        cursor_status: "incremental",
        full_resync_reason: "history-expired",
        max_results: 250,
      },
    ]);
  }, 120_000);
});

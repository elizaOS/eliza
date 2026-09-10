/**
 * Exercises the Calendar carve-out against real PostgreSQL-compatible PGlite
 * schemas, including historical source columns and durable failure receipts.
 */

import { PGlite } from "@electric-sql/pglite";
import type { CarveOutDatabase } from "@elizaos/plugin-sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureCalendarSourceIdentity,
  migrateCalendarTable,
  migrateCalendarTables,
  type SqlExecutor,
} from "./migration.ts";

let database: PGlite;
let exec: SqlExecutor;
let carveOutDatabase: CarveOutDatabase;

beforeEach(async () => {
  database = new PGlite();
  exec = async (statement) => {
    const result = await database.query<Record<string, unknown>>(statement);
    return result.rows;
  };
  carveOutDatabase = {
    execute: exec,
    transaction: (operation) =>
      database.transaction(async (transaction) =>
        operation(async (statement) => {
          const result =
            await transaction.query<Record<string, unknown>>(statement);
          return result.rows;
        }),
      ),
  };
  await database.exec(`
    CREATE SCHEMA app_lifeops;
    CREATE SCHEMA app_calendar;

    CREATE TABLE app_lifeops.life_calendar_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      location TEXT NOT NULL,
      status TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      is_all_day BOOLEAN NOT NULL,
      timezone TEXT,
      html_link TEXT,
      conference_link TEXT,
      organizer_json TEXT,
      attendees_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE app_lifeops.life_calendar_sync_states (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      window_start_at TEXT NOT NULL,
      window_end_at TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE app_calendar.life_calendar_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      connector_account_id TEXT,
      purge_resync_required BOOLEAN NOT NULL DEFAULT FALSE,
      purge_resync_reason TEXT,
      grant_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      location TEXT NOT NULL,
      status TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      is_all_day BOOLEAN NOT NULL,
      timezone TEXT,
      html_link TEXT,
      conference_link TEXT,
      organizer_json TEXT,
      attendees_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE app_calendar.life_calendar_sync_states (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      connector_account_id TEXT,
      grant_id TEXT,
      purge_resync_required BOOLEAN NOT NULL DEFAULT FALSE,
      purge_resync_reason TEXT,
      window_start_at TEXT NOT NULL,
      window_end_at TEXT NOT NULL,
      next_sync_token TEXT,
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO app_lifeops.life_calendar_events (
      id, agent_id, provider, side, calendar_id, external_event_id, title,
      description, location, status, start_at, end_at, is_all_day, timezone,
      html_link, conference_link, organizer_json, attendees_json, metadata_json,
      synced_at, updated_at
    ) VALUES (
      'event-1', 'agent-1', 'google', 'owner', 'primary', 'external-1',
      'Historical event', 'description', 'location', 'confirmed',
      '2026-09-03T14:00:00.000Z', '2026-09-03T15:00:00.000Z', FALSE, 'UTC',
      'https://calendar.example/event-1', NULL, '{"name":"Owner"}', '[]',
      '{"source":"legacy"}', '2026-09-03T13:00:00.000Z',
      '2026-09-03T13:00:00.000Z'
    );
    INSERT INTO app_lifeops.life_calendar_sync_states (
      id, agent_id, provider, side, calendar_id, window_start_at,
      window_end_at, synced_at, updated_at
    ) VALUES (
      'sync-1', 'agent-1', 'google', 'owner', 'primary',
      '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
      '2026-09-03T13:00:00.000Z', '2026-09-03T13:00:00.000Z'
    );
  `);
}, 120_000);

afterEach(async () => {
  await database.close();
});

describe("Calendar historical source migration", () => {
  it("copies both historical tables with defaults and leaves their source rows untouched", async () => {
    const sourceEventsBefore = await database.query(
      "SELECT * FROM app_lifeops.life_calendar_events ORDER BY id",
    );
    const sourceSyncBefore = await database.query(
      "SELECT * FROM app_lifeops.life_calendar_sync_states ORDER BY id",
    );

    await expect(
      migrateCalendarTable(exec, "life_calendar_events"),
    ).resolves.toMatchObject({ outcome: "copied" });
    await expect(
      migrateCalendarTable(exec, "life_calendar_sync_states"),
    ).resolves.toMatchObject({ outcome: "copied" });

    const events = await database.query<{
      id: string;
      connector_account_id: string | null;
      grant_id: string | null;
      purge_resync_required: boolean;
      purge_resync_reason: string | null;
      title: string;
    }>(`
      SELECT id, connector_account_id, grant_id, purge_resync_required,
             purge_resync_reason, title
        FROM app_calendar.life_calendar_events
    `);
    expect(events.rows).toEqual([
      {
        id: "event-1",
        connector_account_id: "legacy:google:owner",
        grant_id: "legacy:google:owner",
        purge_resync_required: false,
        purge_resync_reason: null,
        title: "Historical event",
      },
    ]);

    const syncStates = await database.query<{
      id: string;
      connector_account_id: string | null;
      grant_id: string | null;
      purge_resync_required: boolean;
      purge_resync_reason: string | null;
    }>(`
      SELECT id, connector_account_id, grant_id, purge_resync_required,
             purge_resync_reason
        FROM app_calendar.life_calendar_sync_states
    `);
    expect(syncStates.rows).toEqual([
      {
        id: "agent-1:google:owner:grant:legacy:google:owner:calendar:primary",
        connector_account_id: "legacy:google:owner",
        grant_id: "legacy:google:owner",
        purge_resync_required: false,
        purge_resync_reason: null,
      },
    ]);

    expect(
      await database.query(
        "SELECT * FROM app_lifeops.life_calendar_events ORDER BY id",
      ),
    ).toEqual(sourceEventsBefore);
    expect(
      await database.query(
        "SELECT * FROM app_lifeops.life_calendar_sync_states ORDER BY id",
      ),
    ).toEqual(sourceSyncBefore);

    const sourceColumns = await database.query<{ column_name: string }>(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'app_lifeops'
         AND table_name IN ('life_calendar_events', 'life_calendar_sync_states')
    `);
    expect(sourceColumns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining([
        "connector_account_id",
        "grant_id",
        "purge_resync_required",
        "purge_resync_reason",
      ]),
    );
  });

  it("upgrades an already canonicalized calendar without duplicate rows or lost sync metadata", async () => {
    // Reproduce the prior release: raw table copy followed by source-identity
    // normalization, with no durable carve-out receipt.
    await database.exec(`
      INSERT INTO app_calendar.life_calendar_events (
        id, agent_id, provider, side, calendar_id, external_event_id, title,
        description, location, status, start_at, end_at, is_all_day, timezone,
        html_link, conference_link, organizer_json, attendees_json, metadata_json,
        synced_at, updated_at
      ) SELECT * FROM app_lifeops.life_calendar_events;
      INSERT INTO app_calendar.life_calendar_sync_states (
        id, agent_id, provider, side, calendar_id, window_start_at,
        window_end_at, synced_at, updated_at
      ) SELECT * FROM app_lifeops.life_calendar_sync_states;
      ALTER TABLE app_lifeops.life_calendar_events
        ADD COLUMN grant_id TEXT, ADD COLUMN connector_account_id TEXT;
      ALTER TABLE app_lifeops.life_calendar_sync_states
        ADD COLUMN grant_id TEXT, ADD COLUMN connector_account_id TEXT;
    `);
    await ensureCalendarSourceIdentity(exec);
    await database.exec(`
      UPDATE app_calendar.life_calendar_sync_states
         SET next_sync_token = 'preserve-live-provider-cursor';
      INSERT INTO app_lifeops.life_calendar_events
        SELECT 'event-2', agent_id, provider, side, calendar_id, 'external-2',
          title, description, location, status, start_at, end_at, is_all_day,
          timezone, html_link, conference_link, organizer_json, attendees_json,
          metadata_json, synced_at, updated_at, grant_id, connector_account_id
          FROM app_lifeops.life_calendar_events WHERE id = 'event-1';
    `);
    const legacyEvents = await exec(
      "SELECT * FROM app_lifeops.life_calendar_events ORDER BY id",
    );
    const legacySync = await exec(
      "SELECT * FROM app_lifeops.life_calendar_sync_states ORDER BY id",
    );

    await expect(migrateCalendarTables(carveOutDatabase)).resolves.toEqual([
      { table: "life_calendar_events", outcome: "copied" },
      { table: "life_calendar_sync_states", outcome: "copied" },
    ]);
    expect(
      await exec(
        "SELECT id FROM app_calendar.life_calendar_events ORDER BY id",
      ),
    ).toEqual([{ id: "event-1" }, { id: "event-2" }]);
    expect(
      await exec(`SELECT id, grant_id, connector_account_id, next_sync_token
      FROM app_calendar.life_calendar_sync_states`),
    ).toEqual([
      {
        id: "agent-1:google:owner:grant:legacy:google:owner:calendar:primary",
        grant_id: "legacy:google:owner",
        connector_account_id: "legacy:google:owner",
        next_sync_token: "preserve-live-provider-cursor",
      },
    ]);
    expect(
      await exec("SELECT * FROM app_lifeops.life_calendar_events ORDER BY id"),
    ).toEqual(legacyEvents);
    expect(
      await exec(
        "SELECT * FROM app_lifeops.life_calendar_sync_states ORDER BY id",
      ),
    ).toEqual(legacySync);

    await database.exec("DELETE FROM app_calendar.life_calendar_sync_states");
    await expect(migrateCalendarTables(carveOutDatabase)).resolves.toEqual([
      { table: "life_calendar_events", outcome: "already-migrated" },
      { table: "life_calendar_sync_states", outcome: "already-migrated" },
    ]);
    expect(
      await exec("SELECT * FROM app_calendar.life_calendar_sync_states"),
    ).toEqual([]);
  });

  it("rolls back canonical normalization and leaves no receipt when source values conflict", async () => {
    await database.exec(`
      INSERT INTO app_calendar.life_calendar_sync_states (
        id, agent_id, provider, side, calendar_id, window_start_at,
        window_end_at, synced_at, updated_at
      ) SELECT * FROM app_lifeops.life_calendar_sync_states;
      UPDATE app_calendar.life_calendar_sync_states
        SET window_end_at = '2026-11-01T00:00:00.000Z';
    `);
    const targetBefore = await exec(
      "SELECT * FROM app_calendar.life_calendar_sync_states",
    );
    await expect(migrateCalendarTables(carveOutDatabase)).rejects.toMatchObject(
      {
        code: "CARVE_OUT_MIGRATION_COLLISION",
      },
    );
    expect(
      await exec("SELECT * FROM app_calendar.life_calendar_sync_states"),
    ).toEqual(targetBefore);
    expect(
      await exec(`SELECT status FROM app_eliza_migrations.carve_out_receipts
      WHERE migration_key = 'calendar/life_calendar_sync_states/v2'`),
    ).toEqual([]);
  });
  it("fails closed on a missing required column without completing its receipt", async () => {
    await database.exec(
      "ALTER TABLE app_lifeops.life_calendar_events DROP COLUMN title",
    );

    await expect(migrateCalendarTables(carveOutDatabase)).rejects.toThrow(
      "missing required column(s): title",
    );

    const receipts = await database.query<{ status: string }>(`
      SELECT status
        FROM app_eliza_migrations.carve_out_receipts
       WHERE migration_key = 'calendar/life_calendar_events/v2'
    `);
    expect(receipts.rows).toEqual([]);

    const targetCount = await database.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
        FROM app_calendar.life_calendar_events
    `);
    const sourceCount = await database.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
        FROM app_lifeops.life_calendar_events
    `);
    expect(targetCount.rows[0]?.count).toBe("0");
    expect(sourceCount.rows[0]?.count).toBe("1");
  });

  it("repairs past a completed v1 receipt exactly once and honors the completed v2 receipt", async () => {
    await database.exec(`
      CREATE SCHEMA app_eliza_migrations;
      CREATE TABLE app_eliza_migrations.carve_out_receipts (
        migration_key TEXT PRIMARY KEY,
        holder_token TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        outcome TEXT
      );
      INSERT INTO app_eliza_migrations.carve_out_receipts (
        migration_key, holder_token, status, completed_at, outcome
      ) VALUES (
        'calendar/life_calendar_events/v1', NULL, 'completed', now(), 'copied'
      );
    `);

    await expect(migrateCalendarTables(carveOutDatabase)).resolves.toEqual([
      { table: "life_calendar_events", outcome: "copied" },
      { table: "life_calendar_sync_states", outcome: "copied" },
    ]);

    const receipts = await database.query<{
      migration_key: string;
      status: string;
    }>(`
      SELECT migration_key, status
        FROM app_eliza_migrations.carve_out_receipts
       WHERE migration_key IN (
         'calendar/life_calendar_events/v1',
         'calendar/life_calendar_events/v2'
       )
       ORDER BY migration_key
    `);
    expect(receipts.rows).toEqual([
      {
        migration_key: "calendar/life_calendar_events/v1",
        status: "completed",
      },
      {
        migration_key: "calendar/life_calendar_events/v2",
        status: "completed",
      },
    ]);

    await database.exec(
      "DELETE FROM app_calendar.life_calendar_events WHERE id = 'event-1'",
    );
    await expect(migrateCalendarTables(carveOutDatabase)).resolves.toEqual([
      { table: "life_calendar_events", outcome: "already-migrated" },
      { table: "life_calendar_sync_states", outcome: "already-migrated" },
    ]);

    const targetCount = await database.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
        FROM app_calendar.life_calendar_events
       WHERE id = 'event-1'
    `);
    expect(targetCount.rows[0]?.count).toBe("0");
  });
});

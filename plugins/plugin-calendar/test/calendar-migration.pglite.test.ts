/**
 * Calendar source-identity migration against PostgreSQL-compatible PGlite,
 * including legacy constraint replacement and sync-cursor schema upgrade.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureCalendarSourceIdentity,
  type SqlExecutor,
} from "../src/service/migration.js";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA app_calendar;
    CREATE TABLE app_calendar.life_calendar_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      connector_account_id TEXT,
      grant_id TEXT,
      CONSTRAINT legacy_calendar_event_unique
        UNIQUE (agent_id, provider, side, calendar_id, external_event_id)
    );
    CREATE TABLE app_calendar.life_calendar_sync_states (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      connector_account_id TEXT,
      grant_id TEXT,
      CONSTRAINT legacy_calendar_sync_unique
        UNIQUE (agent_id, provider, side, calendar_id)
    );
    INSERT INTO app_calendar.life_calendar_events VALUES (
      'legacy-event', 'agent-1', 'google', 'owner', 'primary', 'event-1',
      'account-a', NULL
    );
    INSERT INTO app_calendar.life_calendar_sync_states VALUES (
      'legacy-sync', 'agent-1', 'google', 'owner', 'primary', 'account-a', NULL
    );
  `);
});

afterAll(async () => {
  await pg.close();
});

describe("calendar source identity migration", () => {
  it("backfills grant identity, adds sync cursors, and permits identical provider ids across accounts", async () => {
    const exec: SqlExecutor = async (statement) => {
      const result = await pg.query<Record<string, unknown>>(statement);
      return result.rows;
    };
    await ensureCalendarSourceIdentity(exec);

    const migrated = await pg.query<{
      id: string;
      grant_id: string;
      connector_account_id: string;
      next_sync_token: string | null;
    }>(`
      SELECT id, grant_id, connector_account_id, next_sync_token
        FROM app_calendar.life_calendar_sync_states
    `);
    expect(migrated.rows).toEqual([
      {
        id: "agent-1:google:owner:grant:account-a:calendar:primary",
        grant_id: "account-a",
        connector_account_id: "account-a",
        next_sync_token: null,
      },
    ]);

    await pg.exec(`
      INSERT INTO app_calendar.life_calendar_events VALUES (
        'account-b-event', 'agent-1', 'google', 'owner', 'primary', 'event-1',
        'account-b', 'account-b'
      );
      INSERT INTO app_calendar.life_calendar_sync_states (
        id, agent_id, provider, side, calendar_id, connector_account_id,
        grant_id, next_sync_token
      ) VALUES (
        'account-b-sync', 'agent-1', 'google', 'owner', 'primary', 'account-b',
        'account-b', 'sync-b'
      );
    `);

    const eventCount = await pg.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM app_calendar.life_calendar_events",
    );
    const syncCount = await pg.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM app_calendar.life_calendar_sync_states",
    );
    expect(eventCount.rows[0]?.count).toBe("2");
    expect(syncCount.rows[0]?.count).toBe("2");
  });
});

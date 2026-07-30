/**
 * Non-destructive data migration for the calendar tables carved out of
 * @elizaos/plugin-personal-assistant.
 *
 * The two legacy calendar tables (`life_calendar_events`,
 * `life_calendar_sync_states`)
 * used to live in the `app_lifeops` PostgreSQL schema, created by
 * plugin-personal-assistant. They now live in `app_calendar`, created by this
 * plugin's drizzle schema. Existing installs still hold the owner's calendar
 * rows in `app_lifeops`, so on first boot we copy them across — once,
 * idempotently, and WITHOUT ever touching the source.
 *
 * Guards (per table, independently):
 *   1. Skip if the source table does not exist (fresh install / already dropped).
 *   2. Skip if the target table is non-empty (migration already ran, or the
 *      plugin owns live data).
 *   3. Otherwise copy every source row that is not already present in the target
 *      (a doubly-safe NOT EXISTS guard on the primary key).
 *
 * The source table is NEVER dropped or altered. Copies name the shared columns
 * explicitly so the calendar-owned target can add sync metadata without
 * making older personal-assistant source tables unreadable.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

export const CALENDAR_MIGRATION_LOG_PREFIX = "[Calendar]";
export const CALENDAR_MIGRATION_SERVICE_TYPE = "calendar_migration";

const SOURCE_SCHEMA = "app_lifeops";
const TARGET_SCHEMA = "app_calendar";

export const MIGRATED_CALENDAR_TABLES = [
  "life_calendar_events",
  "life_calendar_sync_states",
] as const;

export type MigratedCalendarTable = (typeof MIGRATED_CALENDAR_TABLES)[number];

const MIGRATED_CALENDAR_COLUMNS: Record<
  MigratedCalendarTable,
  readonly string[]
> = {
  life_calendar_events: [
    "id",
    "agent_id",
    "provider",
    "side",
    "calendar_id",
    "external_event_id",
    "connector_account_id",
    "purge_resync_required",
    "purge_resync_reason",
    "grant_id",
    "title",
    "description",
    "location",
    "status",
    "start_at",
    "end_at",
    "is_all_day",
    "timezone",
    "html_link",
    "conference_link",
    "organizer_json",
    "attendees_json",
    "metadata_json",
    "synced_at",
    "updated_at",
  ],
  life_calendar_sync_states: [
    "id",
    "agent_id",
    "provider",
    "side",
    "calendar_id",
    "connector_account_id",
    "grant_id",
    "purge_resync_required",
    "purge_resync_reason",
    "window_start_at",
    "window_end_at",
    "synced_at",
    "updated_at",
  ],
};

export type SqlExecutor = (
  sql: string,
) => Promise<Array<Record<string, unknown>>>;

export interface TableMigrationResult {
  table: MigratedCalendarTable;
  outcome: "copied" | "source-missing" | "target-non-empty";
}

/**
 * Upgrades the original calendar-only uniqueness to full source identity.
 * Every Google account exposes a `primary` calendar, so omitting the grant
 * lets one account overwrite another even though both reads succeeded.
 */
export async function ensureCalendarSourceIdentity(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`
    ALTER TABLE ${TARGET_SCHEMA}.life_calendar_sync_states
      ADD COLUMN IF NOT EXISTS next_sync_token TEXT`);
  await exec(`
    UPDATE ${TARGET_SCHEMA}.life_calendar_events
       SET grant_id = COALESCE(
             grant_id,
             connector_account_id,
             CASE
               WHEN provider = 'apple_calendar' THEN 'apple-calendar'
               ELSE 'legacy:' || provider || ':' || side
             END
           ),
           connector_account_id = COALESCE(
             connector_account_id,
             grant_id,
             CASE
               WHEN provider = 'apple_calendar' THEN 'apple-calendar'
               ELSE 'legacy:' || provider || ':' || side
             END
           )
     WHERE grant_id IS NULL OR connector_account_id IS NULL`);
  await exec(`
    UPDATE ${TARGET_SCHEMA}.life_calendar_sync_states
       SET grant_id = COALESCE(
             grant_id,
             connector_account_id,
             CASE
               WHEN provider = 'apple_calendar' THEN 'apple-calendar'
               ELSE 'legacy:' || provider || ':' || side
             END
           ),
           connector_account_id = COALESCE(
             connector_account_id,
             grant_id,
             CASE
               WHEN provider = 'apple_calendar' THEN 'apple-calendar'
               ELSE 'legacy:' || provider || ':' || side
             END
           )
     WHERE grant_id IS NULL OR connector_account_id IS NULL`);
  await exec(`
    UPDATE ${TARGET_SCHEMA}.life_calendar_sync_states
       SET id = agent_id || ':' || provider || ':' || side || ':grant:' ||
                grant_id || ':calendar:' || calendar_id`);
  await exec(`
    DO $calendar_source_identity$
    DECLARE
      constraint_name text;
    BEGIN
      FOR constraint_name IN
        SELECT c.conname
          FROM pg_constraint AS c
         WHERE c.conrelid = '${TARGET_SCHEMA}.life_calendar_events'::regclass
           AND c.contype = 'u'
           AND pg_get_constraintdef(c.oid) LIKE
             'UNIQUE (agent_id, provider, side, calendar_id, external_event_id)%'
      LOOP
        EXECUTE format(
          'ALTER TABLE ${TARGET_SCHEMA}.life_calendar_events DROP CONSTRAINT %I',
          constraint_name
        );
      END LOOP;

      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = '${TARGET_SCHEMA}.life_calendar_events'::regclass
           AND conname = 'calendar_events_source_external_unique'
      ) THEN
        ALTER TABLE ${TARGET_SCHEMA}.life_calendar_events
          ADD CONSTRAINT calendar_events_source_external_unique
          UNIQUE (
            agent_id, provider, side, grant_id, calendar_id, external_event_id
          );
      END IF;
    END
    $calendar_source_identity$`);
  await exec(`
    DO $calendar_sync_source_identity$
    DECLARE
      constraint_name text;
    BEGIN
      FOR constraint_name IN
        SELECT c.conname
          FROM pg_constraint AS c
         WHERE c.conrelid = '${TARGET_SCHEMA}.life_calendar_sync_states'::regclass
           AND c.contype = 'u'
           AND pg_get_constraintdef(c.oid) LIKE
             'UNIQUE (agent_id, provider, side, calendar_id)%'
      LOOP
        EXECUTE format(
          'ALTER TABLE ${TARGET_SCHEMA}.life_calendar_sync_states DROP CONSTRAINT %I',
          constraint_name
        );
      END LOOP;

      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = '${TARGET_SCHEMA}.life_calendar_sync_states'::regclass
           AND conname = 'calendar_sync_states_source_unique'
      ) THEN
        ALTER TABLE ${TARGET_SCHEMA}.life_calendar_sync_states
          ADD CONSTRAINT calendar_sync_states_source_unique
          UNIQUE (agent_id, provider, side, grant_id, calendar_id);
      END IF;
    END
    $calendar_sync_source_identity$`);
}

/**
 * Subscription sources never existed in the legacy LifeOps schema. Creating
 * their table here as well as in Drizzle keeps direct migration callers and
 * older plugin-sql boot orders safe without adding it to the legacy copy set.
 */
export async function ensureIcsCalendarSourceTable(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.life_calendar_sources (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'ics',
      side TEXT NOT NULL DEFAULT 'owner',
      name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      secret_ref TEXT NOT NULL,
      url_fingerprint TEXT NOT NULL,
      origin TEXT NOT NULL,
      etag TEXT,
      last_modified TEXT,
      content_hash TEXT,
      sync_status TEXT NOT NULL DEFAULT 'never',
      last_error_code TEXT,
      last_error_message TEXT,
      last_error_retryable BOOLEAN,
      last_synced_at TEXT,
      last_attempted_at TEXT,
      sync_generation INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT calendar_sources_agent_fingerprint_unique
        UNIQUE (agent_id, url_fingerprint)
    )`);
}

/**
 * Secret cleanup is an outbox owned by the calendar database. Rotation and
 * source deletion enqueue an opaque vault reference in the same statement as
 * the source mutation, so a vault outage cannot permanently orphan a URL.
 */
export async function ensureIcsSecretCleanupTable(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.life_calendar_secret_cleanup (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      secret_ref TEXT NOT NULL,
      reason TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CONSTRAINT calendar_secret_cleanup_agent_ref_unique
        UNIQUE (agent_id, secret_ref)
    )`);
  await exec(`
    CREATE INDEX IF NOT EXISTS calendar_secret_cleanup_drain_idx
      ON ${TARGET_SCHEMA}.life_calendar_secret_cleanup (
        agent_id, created_at, id
      )`);
}

/**
 * Feed selection is an independently versioned row per exact source. The
 * composite primary key is the concurrency boundary: provider, side, grant,
 * account, and calendar identifiers are never collapsed into a delimiter key.
 */
export async function ensureCalendarFeedPreferenceTable(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.life_calendar_feed_preferences (
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      connector_account_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      included BOOLEAN NOT NULL DEFAULT TRUE,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      CONSTRAINT calendar_feed_preferences_source_pk PRIMARY KEY (
        agent_id,
        provider,
        side,
        grant_id,
        connector_account_id,
        calendar_id
      ),
      CONSTRAINT calendar_feed_preferences_version_nonnegative
        CHECK (version >= 0)
    )`);
  await exec(`
    DO $calendar_feed_preference_version$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid =
               '${TARGET_SCHEMA}.life_calendar_feed_preferences'::regclass
           AND conname =
               'calendar_feed_preferences_version_nonnegative'
      ) THEN
        ALTER TABLE ${TARGET_SCHEMA}.life_calendar_feed_preferences
          ADD CONSTRAINT calendar_feed_preferences_version_nonnegative
          CHECK (version >= 0);
      END IF;
    END
    $calendar_feed_preference_version$`);
}

/**
 * Push channels are calendar-owned state rather than connector credentials.
 * The explicit migration path creates their table before a public callback can
 * arrive, including direct PGlite and older plugin-sql boot orders.
 */
export async function ensureGoogleCalendarWatchChannelTable(
  exec: SqlExecutor,
): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.google_calendar_watch_channels (
      channel_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      connector_account_id TEXT NOT NULL,
      side TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      calendar_summary TEXT NOT NULL,
      calendar_access_role TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      window_start_at TEXT NOT NULL,
      window_end_at TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      token_sha256 TEXT NOT NULL,
      resource_id TEXT,
      resource_uri TEXT,
      expiration_at TEXT,
      state TEXT NOT NULL,
      last_message_number TEXT NOT NULL DEFAULT '0',
      pending_message_number TEXT,
      last_notification_at TEXT,
      last_sync_at TEXT,
      sync_lease_token TEXT,
      sync_lease_expires_at TEXT,
      renewal_channel_id TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      last_error_retryable BOOLEAN,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  await exec(`
    CREATE INDEX IF NOT EXISTS calendar_watch_binding_idx
      ON ${TARGET_SCHEMA}.google_calendar_watch_channels (
        agent_id, connector_account_id, grant_id, calendar_id
      )`);
  await exec(`
    CREATE INDEX IF NOT EXISTS calendar_watch_maintenance_idx
      ON ${TARGET_SCHEMA}.google_calendar_watch_channels (
        agent_id, state, expiration_at
      )`);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function sourceTableExists(
  exec: SqlExecutor,
  table: MigratedCalendarTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT to_regclass('${SOURCE_SCHEMA}.${table}') IS NOT NULL AS present`,
  );
  return rows[0]?.present === true || rows[0]?.present === "true";
}

async function targetTableIsEmpty(
  exec: SqlExecutor,
  table: MigratedCalendarTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT NOT EXISTS (SELECT 1 FROM ${TARGET_SCHEMA}.${quoteIdent(table)}) AS empty`,
  );
  return rows[0]?.empty === true || rows[0]?.empty === "true";
}

export async function migrateCalendarTable(
  exec: SqlExecutor,
  table: MigratedCalendarTable,
): Promise<TableMigrationResult> {
  if (!(await sourceTableExists(exec, table))) {
    return { table, outcome: "source-missing" };
  }
  if (!(await targetTableIsEmpty(exec, table))) {
    return { table, outcome: "target-non-empty" };
  }

  const target = `${TARGET_SCHEMA}.${quoteIdent(table)}`;
  const source = `${SOURCE_SCHEMA}.${quoteIdent(table)}`;
  const columns = MIGRATED_CALENDAR_COLUMNS[table];
  const targetColumns = columns.map(quoteIdent).join(", ");
  const sourceColumns = columns
    .map((column) => `s.${quoteIdent(column)}`)
    .join(", ");
  await exec(
    `INSERT INTO ${target} (${targetColumns})
       SELECT ${sourceColumns} FROM ${source} AS s
       WHERE NOT EXISTS (
         SELECT 1 FROM ${target} AS t WHERE t.id = s.id
       )`,
  );
  return { table, outcome: "copied" };
}

export async function migrateCalendarTables(
  exec: SqlExecutor,
): Promise<TableMigrationResult[]> {
  await exec(`CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA}`);
  await ensureIcsCalendarSourceTable(exec);
  await ensureIcsSecretCleanupTable(exec);
  await ensureCalendarFeedPreferenceTable(exec);
  await ensureGoogleCalendarWatchChannelTable(exec);
  const results: TableMigrationResult[] = [];
  for (const table of MIGRATED_CALENDAR_TABLES) {
    results.push(await migrateCalendarTable(exec, table));
  }
  await ensureCalendarSourceIdentity(exec);
  return results;
}

type RuntimeDb = {
  execute: (query: unknown) => Promise<unknown>;
};

function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb {
  const db = runtime.db as RuntimeDb | undefined;
  if (!db || typeof db.execute !== "function") {
    throw new Error(
      `${CALENDAR_MIGRATION_LOG_PREFIX} runtime.db is unavailable — @elizaos/plugin-sql must be loaded before @elizaos/plugin-calendar.`,
    );
  }
  return db;
}

function extractRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result.filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    );
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) {
      return rows.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null && !Array.isArray(row),
      );
    }
  }
  return [];
}

/**
 * Service whose `start()` performs the one-time, guarded, non-destructive copy
 * of the owner's calendar rows from `app_lifeops` into `app_calendar`.
 */
export class CalendarMigrationService extends Service {
  static override readonly serviceType = CALENDAR_MIGRATION_SERVICE_TYPE;

  override capabilityDescription =
    "Non-destructive one-time copy of calendar rows from app_lifeops into app_calendar during the plugin-calendar carve-out.";

  static async start(
    runtime: IAgentRuntime,
  ): Promise<CalendarMigrationService> {
    const service = new CalendarMigrationService(runtime);
    await service.run();
    return service;
  }

  private async run(): Promise<void> {
    const db = getRuntimeDb(this.runtime);
    const { sql } = await import("drizzle-orm");
    const exec: SqlExecutor = async (statement) =>
      extractRows(await db.execute(sql.raw(statement)));

    const results = await migrateCalendarTables(exec);
    const copied = results.filter((r) => r.outcome === "copied");
    if (copied.length > 0) {
      logger.info(
        { tables: copied.map((r) => r.table) },
        `${CALENDAR_MIGRATION_LOG_PREFIX} copied ${copied.length} calendar table(s) from ${SOURCE_SCHEMA} to ${TARGET_SCHEMA}`,
      );
    } else {
      logger.debug(
        { results },
        `${CALENDAR_MIGRATION_LOG_PREFIX} no calendar tables required copying (already migrated or fresh install)`,
      );
    }
  }

  override async stop(): Promise<void> {}
}

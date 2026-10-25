/**
 * Calendar feed preference tests use real PGlite rows and transactions,
 * including separate runtime objects racing one CAS token and forced rollback
 * after the preference row changes but before the ICS provider row can commit.
 */

import { PGlite } from "@electric-sql/pglite";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  calendarFeedPreferenceKey,
  ensureCalendarFeedIncludes,
  getCalendarFeedPreference,
  setCalendarFeedIncluded,
} from "./feed-preferences.js";
import {
  ensureCalendarFeedPreferenceTable,
  ensureIcsCalendarSourceTable,
  type SqlExecutor,
} from "./migration.js";

const AGENT_ID = "calendar-preference-pglite-agent";

interface PreferenceHarness {
  pg: PGlite;
  runtime: IAgentRuntime;
  secondRuntime: IAgentRuntime;
  cache: Map<string, unknown>;
}

const openDatabases: PGlite[] = [];

function source(
  overrides: Partial<Parameters<typeof calendarFeedPreferenceKey>[0]> = {},
) {
  return {
    provider: "google" as const,
    side: "owner" as const,
    grantId: "connector-account:account-a",
    connectorAccountId: "account-a",
    calendarId: "primary",
    ...overrides,
  };
}

async function harness(initialCache?: unknown): Promise<PreferenceHarness> {
  const pg = new PGlite();
  openDatabases.push(pg);
  await pg.exec("CREATE SCHEMA app_calendar");
  const execute: SqlExecutor = async (statement) =>
    (await pg.query<Record<string, unknown>>(statement)).rows;
  await ensureCalendarFeedPreferenceTable(execute);
  await ensureIcsCalendarSourceTable(execute);
  const cache = new Map<string, unknown>();
  if (initialCache !== undefined) {
    cache.set("calendar:feed-preferences", initialCache);
  }
  const runtime = (db: ReturnType<typeof drizzle>) =>
    ({
      agentId: AGENT_ID,
      adapter: { db },
      getCache: async <T>(key: string) => cache.get(key) as T | undefined,
    }) as unknown as IAgentRuntime;
  return {
    pg,
    runtime: runtime(drizzle(pg)),
    secondRuntime: runtime(drizzle(pg)),
    cache,
  };
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((pg) => pg.close()));
});

describe("calendar feed preference SQL revisions", { timeout: 30_000 }, () => {
  it("upgrades an existing preference table with the nonnegative version constraint", async () => {
    const pg = new PGlite();
    openDatabases.push(pg);
    await pg.exec(`
      CREATE SCHEMA app_calendar;
      CREATE TABLE app_calendar.life_calendar_feed_preferences (
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        side TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        connector_account_id TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        included BOOLEAN NOT NULL DEFAULT TRUE,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (
          agent_id,
          provider,
          side,
          grant_id,
          connector_account_id,
          calendar_id
        )
      );
    `);
    const execute: SqlExecutor = async (statement) =>
      (await pg.query<Record<string, unknown>>(statement)).rows;

    await ensureCalendarFeedPreferenceTable(execute);

    await expect(
      pg.exec(`
        INSERT INTO app_calendar.life_calendar_feed_preferences (
          agent_id,
          provider,
          side,
          grant_id,
          connector_account_id,
          calendar_id,
          included,
          version,
          updated_at
        ) VALUES (
          'agent',
          'google',
          'owner',
          'grant',
          'account',
          'primary',
          TRUE,
          -1,
          '2026-07-27T00:00:00.000Z'
        )
      `),
    ).rejects.toThrow(/calendar_feed_preferences_version_nonnegative/u);
  });

  it("migrates the two-field cache value once without leaving cache authoritative", async () => {
    const identity = source();
    const legacyKey = `${identity.grantId}:${identity.calendarId}`;
    const { runtime, cache } = await harness({
      calendarFeedIncludes: { [legacyKey]: false },
      calendarFeedVersions: { [legacyKey]: 4 },
      updatedAt: "2026-07-27T00:00:00.000Z",
    });

    await expect(
      getCalendarFeedPreference(runtime, identity),
    ).resolves.toMatchObject({ included: false, version: 4, key: identity });

    cache.set("calendar:feed-preferences", {
      calendarFeedIncludes: { [legacyKey]: true },
      calendarFeedVersions: { [legacyKey]: 99 },
    });
    await expect(
      getCalendarFeedPreference(runtime, identity),
    ).resolves.toMatchObject({ included: false, version: 4 });
  });

  it("allows exactly one cross-runtime write for the same listed version", async () => {
    const identity = source();
    const { runtime, secondRuntime, pg } = await harness();
    await ensureCalendarFeedIncludes(runtime, [identity]);

    const outcomes = await Promise.allSettled([
      setCalendarFeedIncluded(runtime, identity, false, 0),
      setCalendarFeedIncluded(secondRuntime, identity, false, 0),
    ]);

    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(ElizaError);
      if (!(rejected.reason instanceof ElizaError)) {
        throw rejected.reason;
      }
      expect(rejected.reason.code).toBe("CALENDAR_SOURCE_SELECTION_CONFLICT");
    }
    const persisted = await pg.query<{ included: boolean; version: number }>(
      `SELECT included, version
         FROM app_calendar.life_calendar_feed_preferences`,
    );
    expect(persisted.rows).toEqual([{ included: false, version: 1 }]);
  });

  it("returns a true no-op without consuming the selection version or touching ICS", async () => {
    const identity = source({
      provider: "ics",
      grantId: "ics-source",
      connectorAccountId: "ics-source",
      calendarId: "ics-source",
    });
    const { runtime, pg } = await harness();
    await pg.exec(`
      INSERT INTO app_calendar.life_calendar_sources (
        id, agent_id, provider, side, name, enabled, secret_ref,
        url_fingerprint, origin, created_at, updated_at
      ) VALUES (
        'ics-source', '${AGENT_ID}', 'ics', 'owner', 'Family', TRUE,
        'secret-ref', 'fingerprint', 'https://calendar.example.test',
        '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'
      );
    `);
    await ensureCalendarFeedIncludes(runtime, [
      { ...identity, initialIncluded: true },
    ]);
    await pg.exec(`
      CREATE FUNCTION reject_noop_ics_update() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'a no-op must not update the provider row';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_noop_ics_update
        BEFORE UPDATE ON app_calendar.life_calendar_sources
        FOR EACH ROW EXECUTE FUNCTION reject_noop_ics_update();
    `);

    await expect(
      setCalendarFeedIncluded(runtime, identity, true, 0),
    ).resolves.toMatchObject({
      included: true,
      previousVersion: 0,
      currentVersion: 0,
      changed: false,
    });

    const preference = await pg.query<{
      included: boolean;
      version: number;
    }>(
      "SELECT included, version FROM app_calendar.life_calendar_feed_preferences",
    );
    expect(preference.rows).toEqual([{ included: true, version: 0 }]);
  });

  it("keeps delimiter collisions and provider/account aliases independent", async () => {
    const first = source({
      grantId: "a:b",
      connectorAccountId: "account:a",
      calendarId: "c",
    });
    const second = source({
      provider: "microsoft",
      grantId: "a",
      connectorAccountId: "account:b",
      calendarId: "b:c",
    });
    const { runtime } = await harness();

    expect(calendarFeedPreferenceKey(first)).not.toBe(
      calendarFeedPreferenceKey(second),
    );
    await ensureCalendarFeedIncludes(runtime, [first, second]);
    await Promise.all([
      setCalendarFeedIncluded(runtime, first, false, 0),
      setCalendarFeedIncluded(runtime, second, true, 0),
    ]);

    await expect(
      getCalendarFeedPreference(runtime, first),
    ).resolves.toMatchObject({ included: false, version: 1 });
    await expect(
      getCalendarFeedPreference(runtime, second),
    ).resolves.toMatchObject({ included: true, version: 0 });
  });

  it("rejects an aliased ICS namespace before it can create a preference row", async () => {
    const { runtime, pg } = await harness();
    await expect(
      setCalendarFeedIncluded(
        runtime,
        source({
          provider: "ics",
          grantId: "ics-source",
          connectorAccountId: "different-source",
          calendarId: "ics-source",
        }),
        false,
        0,
      ),
    ).rejects.toMatchObject({
      code: "CALENDAR_SOURCE_IDENTITY_INVALID",
    });
    const persisted = await pg.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM app_calendar.life_calendar_feed_preferences",
    );
    expect(persisted.rows).toEqual([{ count: 0 }]);
  });

  it("rejects a stale no-op instead of accepting an obsolete UI token", async () => {
    const identity = source();
    const { runtime } = await harness();
    await setCalendarFeedIncluded(runtime, identity, false, 0);

    await expect(
      setCalendarFeedIncluded(runtime, identity, false, 0),
    ).rejects.toMatchObject({
      code: "CALENDAR_SOURCE_SELECTION_CONFLICT",
    });
  });

  it("rolls back preference and ICS provider rows when the provider step fails", async () => {
    const identity = source({
      provider: "ics",
      grantId: "ics-source",
      connectorAccountId: "ics-source",
      calendarId: "ics-source",
    });
    const { runtime, pg } = await harness();
    await pg.exec(`
      INSERT INTO app_calendar.life_calendar_sources (
        id, agent_id, provider, side, name, enabled, secret_ref,
        url_fingerprint, origin, created_at, updated_at
      ) VALUES (
        'ics-source', '${AGENT_ID}', 'ics', 'owner', 'Family', TRUE,
        'secret-ref', 'fingerprint', 'https://calendar.example.test',
        '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'
      );
    `);
    await ensureCalendarFeedIncludes(runtime, [
      { ...identity, initialIncluded: true },
    ]);
    await pg.exec(`
      CREATE FUNCTION reject_ics_selection() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced provider persistence failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_ics_selection_update
        BEFORE UPDATE ON app_calendar.life_calendar_sources
        FOR EACH ROW EXECUTE FUNCTION reject_ics_selection();
    `);

    await expect(
      setCalendarFeedIncluded(runtime, identity, false, 0),
    ).rejects.toMatchObject({
      code: "CALENDAR_SOURCE_ATOMIC_COMMIT_FAILED",
      context: {
        consistency: "rolled_back",
        retryable: true,
      },
    });

    const preference = await pg.query<{
      included: boolean;
      version: number;
    }>(
      "SELECT included, version FROM app_calendar.life_calendar_feed_preferences",
    );
    const provider = await pg.query<{ enabled: boolean }>(
      "SELECT enabled FROM app_calendar.life_calendar_sources WHERE id = 'ics-source'",
    );
    expect(preference.rows).toEqual([{ included: true, version: 0 }]);
    expect(provider.rows).toEqual([{ enabled: true }]);
  });
});

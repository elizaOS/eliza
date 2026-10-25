/**
 * Proves group participant ordinal assignment on real PostgreSQL sessions.
 *
 * `MAX(ordinal) + 1` is only safe if no two assignments for one binding can
 * read the same maximum, and "first claimant keeps the name" is only safe if
 * no two claimants can read the same set of taken names. PGlite serializes
 * transactions and therefore cannot establish either interleaving; only real
 * concurrent backends can show that the per-binding advisory lock actually
 * queues them. Without the lock the burst test hands out duplicate ordinals
 * (or fails on the unique index) and the name race admits two holders.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../lib/services/tenant-db/__tests__/ephemeral-postgres";

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
};
const ORG_ID = "75000000-0000-4000-8000-000000000001";
const USER_ID = "75000000-0000-4000-8000-000000000011";
const BINDING_ID = "75000000-0000-4000-8000-000000000021";
const OTHER_BINDING_ID = "75000000-0000-4000-8000-000000000022";
const SKIP_REASON =
  "[group participants PostgreSQL] SKIPPED - set APPS_TENANT_DB_EPHEMERAL=1 with Docker or APPS_TENANT_DB_TEST_DSN";

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let repository:
  | typeof import("./personal-shared-group-participants").personalSharedGroupParticipantsRepository
  | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<string> {
  databaseName = `eliza_group_participants_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function recordTurn(platformUserId: string, bindingId = BINDING_ID, displayName?: string | null) {
  if (!repository) throw new Error("real PostgreSQL repository is unavailable");
  return repository.recordTurn({ bindingId, platformUserId, displayName });
}

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: isolatedDsn ?? undefined });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

if (!postgres) {
  console.warn(SKIP_REASON);
} else {
  isolatedDsn = await createIsolatedDatabase(postgres.dsn);
  process.env.DATABASE_URL = isolatedDsn;
  process.env.TEST_DATABASE_URL = isolatedDsn;
  ({ closeDatabaseConnectionsForTests } = await import("../client"));
  ({ personalSharedGroupParticipantsRepository: repository } = await import(
    "./personal-shared-group-participants"
  ));
}

beforeAll(async () => {
  if (!isolatedDsn) return;
  await withClient(async (client) => {
    await client.query(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE users (id uuid PRIMARY KEY);
    `);
    for (const file of [
      "0297_personal_shared_group_bindings.sql",
      "0311_personal_shared_group_participants.sql",
    ]) {
      await client.query(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    await client.query("INSERT INTO organizations (id) VALUES ($1)", [ORG_ID]);
    await client.query("INSERT INTO users (id) VALUES ($1)", [USER_ID]);
  });
});

beforeEach(async () => {
  if (!isolatedDsn) return;
  await withClient(async (client) => {
    await client.query(
      "TRUNCATE personal_shared_group_participants, personal_shared_group_bindings CASCADE",
    );
    for (const id of [BINDING_ID, OTHER_BINDING_ID]) {
      await client.query(
        `INSERT INTO personal_shared_group_bindings
           (id, organization_id, owner_user_id, personal_agent_id, platform, project,
            connector_account_id, provider_chat_id, conversation_id,
            created_by_platform_user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'agent-1', 'blooio', 'eliza-app',
           '+15550000001', $4, $5, '+15551234567')`,
        [id, ORG_ID, USER_ID, `chat:${id}`, `group:${id}`],
      );
    }
  });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  if (postgres && databaseName) {
    const admin = new Client({ connectionString: postgres.dsn });
    await admin.connect();
    try {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      await admin.end();
    }
  }
  await postgres?.stop();
  postgres = null;
  restoreEnv("DATABASE_URL", ORIGINAL_ENV.DATABASE_URL);
  restoreEnv("TEST_DATABASE_URL", ORIGINAL_ENV.TEST_DATABASE_URL);
});

describe.skipIf(!postgres)("group participant ordinals on real PostgreSQL", () => {
  test("a burst of first-time speakers takes a contiguous 1..N with no duplicate", async () => {
    const handles = Array.from({ length: 12 }, (_, index) => `+1555000${1000 + index}`);
    const turns = await Promise.all(handles.map((handle) => recordTurn(handle)));

    const ordinals = turns.map(({ actor }) => actor.ordinal).sort((a, b) => a - b);
    expect(ordinals).toEqual(Array.from({ length: handles.length }, (_, i) => i + 1));
    expect(new Set(turns.map(({ actor }) => actor.platformUserId)).size).toBe(handles.length);
    // Every claimant's own ordinal is the one persisted for its handle.
    const stored = await withClient((client) =>
      client.query<{ platform_user_id: string; ordinal: number }>(
        "SELECT platform_user_id, ordinal FROM personal_shared_group_participants WHERE binding_id = $1 ORDER BY ordinal",
        [BINDING_ID],
      ),
    );
    expect(stored.rows.map(({ ordinal }) => ordinal)).toEqual(ordinals);
    for (const { actor } of turns) {
      expect(
        stored.rows.find(({ platform_user_id }) => platform_user_id === actor.platformUserId)
          ?.ordinal,
      ).toBe(actor.ordinal);
    }
  });

  test("concurrent turns from one participant register them once", async () => {
    const turns = await Promise.all(Array.from({ length: 8 }, () => recordTurn("+15551234567")));
    expect(new Set(turns.map(({ actor }) => actor.ordinal))).toEqual(new Set([1]));
    const stored = await withClient((client) =>
      client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM personal_shared_group_participants WHERE binding_id = $1",
        [BINDING_ID],
      ),
    );
    expect(stored.rows[0]?.count).toBe(1);
  });

  test("a concurrent burst across two bindings numbers each from 1", async () => {
    const handles = Array.from({ length: 6 }, (_, index) => `+1555111${1000 + index}`);
    await Promise.all([
      ...handles.map((handle) => recordTurn(handle, BINDING_ID)),
      ...handles.map((handle) => recordTurn(handle, OTHER_BINDING_ID)),
    ]);
    const stored = await withClient((client) =>
      client.query<{ binding_id: string; ordinals: number[] }>(
        `SELECT binding_id, array_agg(ordinal ORDER BY ordinal) AS ordinals
         FROM personal_shared_group_participants GROUP BY binding_id ORDER BY binding_id`,
        [],
      ),
    );
    expect(stored.rows).toHaveLength(2);
    for (const row of stored.rows) {
      expect(row.ordinals).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });

  test("a concurrent name race leaves exactly one holder", async () => {
    // Both members claim `Nubs` at once. The lock that serializes ordinal
    // assignment also serializes the read of already-taken names, so the loser
    // sees the winner's claim and falls back to their ordinal instead of both
    // rendering as the same person.
    const turns = await Promise.all([
      recordTurn("+15550001111", BINDING_ID, "Nubs"),
      recordTurn("+15550002222", BINDING_ID, "Nubs"),
      recordTurn("+15550003333", BINDING_ID, "Nubs"),
    ]);
    const named = turns.filter(({ actor }) => actor.displayName === "Nubs");
    expect(named).toHaveLength(1);
    const stored = await withClient((client) =>
      client.query<{ display_name: string | null; count: string }>(
        `SELECT display_name, count(*)::text AS count
         FROM personal_shared_group_participants
         WHERE binding_id = $1 GROUP BY display_name ORDER BY display_name NULLS LAST`,
        [BINDING_ID],
      ),
    );
    expect(stored.rows).toEqual([
      { display_name: "Nubs", count: "1" },
      { display_name: null, count: "2" },
    ]);
  });

  test("a binding's advisory lock does not block a different binding", async () => {
    // The lock is keyed on the binding, so one slow group can never serialize
    // every other group's turns behind it.
    const holder = new Client({ connectionString: isolatedDsn ?? undefined });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        BINDING_ID,
        "personal-shared-group-participant-ordinal",
      ]);
      const other = await recordTurn("+15559990000", OTHER_BINDING_ID);
      expect(other.actor.ordinal).toBe(1);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });
});

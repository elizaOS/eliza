/**
 * Exercises inbound-media admission on real PostgreSQL sessions. The harness
 * proves quota contention cannot overshoot and that a reclaim blocked on a row
 * lock receives a full post-lock lease; PGlite serializes transactions and
 * cannot establish either interleaving.
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
const ORG_ID = "73000000-0000-4000-8000-000000000001";
const USER_ID = "73000000-0000-4000-8000-000000000011";
const CONNECTOR_ID = "+15550000003";
const SKIP_REASON =
  "[inbound media PostgreSQL] SKIPPED - set APPS_TENANT_DB_EPHEMERAL=1 with Docker or APPS_TENANT_DB_TEST_DSN";

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let repository:
  | typeof import("./personal-shared-inbound-media").personalSharedInboundMediaRepository
  | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<string> {
  databaseName = `eliza_inbound_media_${randomUUID().replaceAll("-", "")}`;
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

function admission(sourceMessageId: string, senderLimit = 5) {
  if (!repository) throw new Error("real PostgreSQL repository is unavailable");
  return repository.admit({
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: CONNECTOR_ID,
    sourceMessageId,
    organizationId: ORG_ID,
    userId: USER_ID,
    mediaDigest: `digest:${sourceMessageId}`,
    imageCount: 1,
    ceilings: { senderDailyImages: senderLimit, connectorDailyImages: 100 },
  });
}

if (!postgres) {
  console.warn(SKIP_REASON);
} else {
  isolatedDsn = await createIsolatedDatabase(postgres.dsn);
  process.env.DATABASE_URL = isolatedDsn;
  process.env.TEST_DATABASE_URL = isolatedDsn;
  ({ closeDatabaseConnectionsForTests } = await import("../client"));
  ({ personalSharedInboundMediaRepository: repository } = await import(
    "./personal-shared-inbound-media"
  ));
}

beforeAll(async () => {
  if (!isolatedDsn) return;
  const client = new Client({ connectionString: isolatedDsn });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE users (id uuid PRIMARY KEY);
    `);
    await client.query(
      readFileSync(
        new URL("../migrations/0310_personal_shared_inbound_media_admission.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query("INSERT INTO organizations (id) VALUES ($1)", [ORG_ID]);
    await client.query("INSERT INTO users (id) VALUES ($1)", [USER_ID]);
  } finally {
    await client.end();
  }
});

beforeEach(async () => {
  if (!isolatedDsn) return;
  const client = new Client({ connectionString: isolatedDsn });
  await client.connect();
  try {
    await client.query(
      "TRUNCATE personal_shared_inbound_media_descriptions, personal_shared_inbound_media_quotas",
    );
  } finally {
    await client.end();
  }
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

describe.skipIf(!postgres)("inbound-media admission on real PostgreSQL", () => {
  test("parallel distinct messages cannot overshoot one sender ceiling", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => admission(`pg-burst-${index}`, 3)),
    );
    expect(results.filter(({ kind }) => kind === "claimed")).toHaveLength(3);
    expect(results.filter(({ kind }) => kind === "exhausted")).toHaveLength(5);

    const client = new Client({ connectionString: isolatedDsn! });
    await client.connect();
    try {
      const ledger = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM personal_shared_inbound_media_descriptions",
      );
      const sender = await client.query<{ image_count: number }>(
        "SELECT image_count FROM personal_shared_inbound_media_quotas WHERE scope = 'sender'",
      );
      expect(ledger.rows[0]?.count).toBe(3);
      expect(sender.rows[0]?.image_count).toBe(3);
    } finally {
      await client.end();
    }
  });

  test("a row-lock-delayed reclaim receives a full post-lock lease", async () => {
    const first = await admission("pg-reclaim");
    expect(first.kind).toBe("claimed");

    const holder = new Client({ connectionString: isolatedDsn! });
    const observer = new Client({ connectionString: isolatedDsn! });
    await Promise.all([holder.connect(), observer.connect()]);
    try {
      await holder.query(
        "UPDATE personal_shared_inbound_media_descriptions SET lease_expires_at = now() - interval '1 second' WHERE source_message_id = 'pg-reclaim'",
      );
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM personal_shared_inbound_media_descriptions WHERE source_message_id = 'pg-reclaim' FOR UPDATE",
      );

      const reclaim = admission("pg-reclaim");
      const deadline = Date.now() + 10_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const waiters = await observer.query<{ count: number }>(`
          SELECT count(*)::int AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND cardinality(pg_blocking_pids(pid)) > 0
        `);
        if ((waiters.rows[0]?.count ?? 0) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await holder.query("COMMIT");

      const reclaimed = await reclaim;
      expect(reclaimed.kind).toBe("claimed");
      const lease = await observer.query<{ seconds_remaining: number }>(`
        SELECT extract(epoch FROM (lease_expires_at - clock_timestamp()))::float8 AS seconds_remaining
        FROM personal_shared_inbound_media_descriptions
        WHERE source_message_id = 'pg-reclaim'
      `);
      expect(lease.rows[0]?.seconds_remaining).toBeGreaterThan(119);
      const quotas = await observer.query<{ image_count: number }>(
        "SELECT image_count FROM personal_shared_inbound_media_quotas WHERE scope = 'sender'",
      );
      expect(quotas.rows[0]?.image_count).toBe(2);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await Promise.all([holder.end(), observer.end()]);
    }
  });
});

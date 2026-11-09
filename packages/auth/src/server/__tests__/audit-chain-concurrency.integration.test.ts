/** Proves same-tenant audit writes inside request transactions cannot wedge each other. */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  withTenantAuditedTransactionOnDb,
  writeAuditEvent,
} from "../db/audit-chain";
import { rowsFromExecute } from "../db/audit-codec";
import {
  closeDb,
  getDb,
  setPGLiteOverride,
  withTenantTransactionDatabase,
} from "../db/client";
import { createPGLiteDb } from "../db/pglite";
import {
  tenantContextForInternalJob,
  withTenantRlsTransaction,
} from "../db/tenant-rls-context";

const databaseUrl = process.env.LOGIN_TEST_DATABASE_URL;
if (process.env.LOGIN_REQUIRE_POSTGRES_TESTS === "1" && !databaseUrl) {
  throw new Error(
    "LOGIN_TEST_DATABASE_URL is required by the PostgreSQL test lane",
  );
}

async function withEnvironment<T>(
  environment: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function audit(tenantId: string, action: string) {
  return writeAuditEvent({ tenantId, actorType: "system", action });
}

/** Mirrors tenantAuth: the whole handler runs inside one bound tenant transaction. */
function tenantRequest<T>(
  driver: "postgres-js" | "pglite",
  tenantId: string,
  handler: () => Promise<T>,
): Promise<T> {
  return withTenantRlsTransaction(
    getDb() as never,
    driver,
    tenantContextForInternalJob({ tenantId, job: "audit-concurrency-test" }),
    (tx) => withTenantTransactionDatabase(tx as never, { tenantId }, handler),
  );
}

async function chainState(tenantId: string) {
  const db = getDb();
  const events = rowsFromExecute<{ seq: number | string }>(
    await db.execute(
      sql`SELECT seq FROM audit_events WHERE tenant_id = ${tenantId} ORDER BY seq`,
    ),
  ).map((row) => Number(row.seq));
  const head = rowsFromExecute<{
    expected_seq: number | string;
    expected_count: number | string;
  }>(
    await db.execute(
      sql`SELECT expected_seq, expected_count FROM audit_chain_heads WHERE tenant_id = ${tenantId}`,
    ),
  )[0];
  return {
    events,
    expectedSeq: Number(head?.expected_seq),
    expectedCount: Number(head?.expected_count),
  };
}

function expectContiguous(
  state: Awaited<ReturnType<typeof chainState>>,
  count: number,
) {
  expect(state.events).toEqual(
    Array.from({ length: count }, (_, index) => index + 1),
  );
  expect(state.expectedSeq).toBe(count);
  expect(state.expectedCount).toBe(count);
}

test("embedded PGlite still serializes same-tenant audit appends in process", async () => {
  await withEnvironment(
    {
      STEWARD_DB_MODE: "pglite",
      STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
    },
    async () => {
      const database = await createPGLiteDb("memory://");
      setPGLiteOverride(database.db, () => database.client.close());
      try {
        await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            audit("pglite-tenant", `test.parallel.${index}`),
          ),
        );
        await tenantRequest("pglite", "pglite-tenant", async () => {
          await audit("pglite-tenant", "test.request.first");
          await audit("pglite-tenant", "test.request.second");
        });
        expectContiguous(await chainState("pglite-tenant"), 10);
      } finally {
        await closeDb();
      }
    },
  );
}, 60_000);

test.skipIf(!databaseUrl)(
  "overlapping same-tenant requests on PostgreSQL both commit their audits",
  async () => {
    if (!databaseUrl) throw new Error("LOGIN_TEST_DATABASE_URL is required");
    const url = new URL(databaseUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error(
        "The PostgreSQL integration harness requires a loopback database server",
      );
    }
    const admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const databaseName = `eliza_audit_test_${randomBytes(8).toString("hex")}`;
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    url.pathname = `/${databaseName}`;
    try {
      const owner = postgres(url.toString(), {
        max: 1,
        onnotice: () => undefined,
      });
      await owner.unsafe(`
        CREATE TABLE audit_events (
          id bigserial PRIMARY KEY,
          tenant_id varchar(64) NOT NULL,
          seq bigint NOT NULL,
          prev_hash bytea NOT NULL,
          hmac bytea NOT NULL,
          actor_type varchar(32) NOT NULL,
          actor_id varchar(255),
          action varchar(128) NOT NULL,
          resource_type varchar(64),
          resource_id varchar(255),
          metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
          ip_address text,
          user_agent text,
          request_id text,
          created_at timestamptz DEFAULT now() NOT NULL
        );
        CREATE UNIQUE INDEX audit_events_tenant_seq_idx ON audit_events (tenant_id, seq);
        CREATE TABLE audit_chain_heads (
          tenant_id varchar(64) PRIMARY KEY,
          expected_seq bigint NOT NULL,
          expected_count bigint NOT NULL,
          head_hmac bytea NOT NULL,
          floor_seq bigint DEFAULT 0 NOT NULL,
          floor_hmac bytea,
          updated_at timestamptz DEFAULT now() NOT NULL
        );
      `);
      await owner.end();

      await withEnvironment(
        {
          DATABASE_URL: url.toString(),
          DATABASE_DRIVER: "postgres-js",
          STEWARD_DB_MODE: undefined,
          STEWARD_PGLITE_MEMORY: undefined,
          STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
        },
        async () => {
          try {
            let releaseFirst!: () => void;
            const firstMayFinish = new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
            let firstAudited!: () => void;
            const firstHoldsLock = new Promise<void>((resolve) => {
              firstAudited = resolve;
            });

            // A audits (now holding the tenant lock until commit) and waits.
            const first = tenantRequest("postgres-js", "tenant-a", async () => {
              await audit("tenant-a", "test.first.one");
              firstAudited();
              await firstMayFinish;
              await audit("tenant-a", "test.first.two");
            });
            await firstHoldsLock;
            // B and C block on A's advisory lock. Before the fix one of them
            // held the in-process queue while waiting, so A's second audit
            // queued behind it and neither request could ever finish.
            const second = tenantRequest(
              "postgres-js",
              "tenant-a",
              async () => {
                await audit("tenant-a", "test.second.one");
                await audit("tenant-a", "test.second.two");
              },
            );
            const third = tenantRequest("postgres-js", "tenant-a", async () => {
              await audit("tenant-a", "test.third.one");
              await withTenantAuditedTransactionOnDb(
                getDb(),
                "tenant-a",
                async (_tx, appendRequiredAudit) => {
                  await appendRequiredAudit({
                    tenantId: "tenant-a",
                    actorType: "system",
                    action: "test.third.helper",
                  });
                },
              );
            });
            await new Promise((resolve) => setTimeout(resolve, 200));

            // Another tenant is not blocked while tenant-a's lock is held.
            await tenantRequest("postgres-js", "tenant-b", async () => {
              await audit("tenant-b", "test.other.one");
              await audit("tenant-b", "test.other.two");
            });

            releaseFirst();
            await Promise.all([first, second, third]);

            expectContiguous(await chainState("tenant-a"), 6);
            expectContiguous(await chainState("tenant-b"), 2);
          } finally {
            await closeDb();
          }
        },
      );
    } finally {
      await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
      await admin.end();
    }
  },
  60_000,
);

/**
 * Cross-connection PostgreSQL proofs for exact-restore capacity recount.
 *
 * PGlite validates the query shape, but only real PostgreSQL can prove that the
 * node-row lock serializes recount with reservation, cleanup, and lifecycle
 * transfer writers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import {
  countAllocatedWorkloadsOnNodeWithDatabase,
  reconcileAllocatedWorkloadsOnNodeWithDatabase,
} from "./docker-node-workload-queries";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "./tenant-db/__tests__/ephemeral-postgres";

const SKIP_REASON =
  "[docker capacity recount] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const NODE_ID = "exact-restore-capacity-postgres";
const NODE_RECORD_ID = "10000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "20000000-0000-4000-8000-000000000001";
const RESTORE_ID = "30000000-0000-4000-8000-000000000001";
const SANDBOX_ID = "40000000-0000-4000-8000-000000000001";

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let pool: Pool | null = null;
let database: ReturnType<typeof drizzle> | null = null;

async function createIsolatedDatabase(baseDsn: string): Promise<string> {
  databaseName = `eliza_capacity_recount_${randomUUID().replaceAll("-", "")}`;
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

async function dropIsolatedDatabase(baseDsn: string, name: string): Promise<void> {
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
        "WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
}

async function createTables(client: Client | Pool): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS docker_nodes (
      id uuid PRIMARY KEY,
      node_id text NOT NULL UNIQUE,
      allocated_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS containers (
      id uuid PRIMARY KEY,
      node_id text,
      status text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_sandboxes (
      id uuid PRIMARY KEY,
      node_id text,
      status text NOT NULL,
      deletion_allocation_counted boolean,
      replacement_cleanup_node_id text,
      replacement_cleanup_allocation_counted boolean
    );
    CREATE TABLE IF NOT EXISTS agent_sandbox_replacement_attempts (
      id uuid PRIMARY KEY,
      locator_node_id text,
      locator_allocation_counted boolean,
      restore_attempt_id uuid,
      state text NOT NULL
    );
  `);
}

async function resetFixture(): Promise<void> {
  if (!pool) throw new Error("PostgreSQL harness unavailable");
  await createTables(pool);
  await pool.query(`
    TRUNCATE TABLE containers, agent_sandboxes, agent_sandbox_replacement_attempts;
    DELETE FROM docker_nodes;
    INSERT INTO docker_nodes (id, node_id, allocated_count)
    VALUES ('${NODE_RECORD_ID}', '${NODE_ID}', 0);
  `);
}

async function waitUntilBlockedBy(observer: Client, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND state = 'active'
           AND $1 = ANY(pg_blocking_pids(pid))
       ) AS blocked`,
      [blockerPid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for capacity recount to block on the node row");
}

async function readAllocatedCount(client: Client | Pool): Promise<number> {
  const result = await client.query<{ allocated_count: number }>(
    "SELECT allocated_count FROM docker_nodes WHERE node_id = $1",
    [NODE_ID],
  );
  const row = result.rows[0];
  if (!row) throw new Error("test Docker node is missing");
  return row.allocated_count;
}

interface PostgresTestClient {
  connect(): Promise<void>;
  query(query: string): Promise<unknown>;
  end(): Promise<void>;
}

/**
 * Acquires both clients, runs a cross-connection proof, and settles every
 * partial acquisition without hiding either the proof or teardown failure.
 */
async function runWithOrderedPostgresTeardown<T>(
  writer: PostgresTestClient,
  observer: PostgresTestClient,
  proof: () => Promise<T>,
): Promise<T> {
  let value: T | undefined;
  let primaryError: unknown;
  let primaryFailed = false;
  const connectedClients = new Set<PostgresTestClient>();
  const connectionResults = await Promise.allSettled([
    Promise.resolve()
      .then(() => writer.connect())
      .then(() => connectedClients.add(writer)),
    Promise.resolve()
      .then(() => observer.connect())
      .then(() => connectedClients.add(observer)),
  ]);
  const connectionErrors = connectionResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (connectionErrors.length > 0) {
    primaryFailed = true;
    primaryError =
      connectionErrors.length === 1
        ? connectionErrors[0]
        : new AggregateError(connectionErrors, "PostgreSQL test client connections failed", {
            cause: connectionErrors[0],
          });
  } else {
    try {
      value = await proof();
    } catch (error) {
      // error-policy:J2 context-adding rethrow — defer the exact primary failure
      // only long enough to settle both PostgreSQL clients, then rethrow it.
      primaryFailed = true;
      primaryError = error;
    }
  }

  const teardownErrors: Error[] = [];
  if (connectedClients.has(writer)) {
    try {
      await writer.query("ROLLBACK");
    } catch (error) {
      // error-policy:J6 best-effort teardown — retain rollback failure alongside
      // the primary proof failure, then continue closing both clients.
      teardownErrors.push(new Error("PostgreSQL test rollback failed", { cause: error }));
    }
  }

  const closeResults = await Promise.allSettled([
    Promise.resolve().then(() => writer.end()),
    Promise.resolve().then(() => observer.end()),
  ]);
  for (const [index, result] of closeResults.entries()) {
    if (result.status === "rejected") {
      // error-policy:J6 best-effort teardown — both clients are independently
      // closed and every rejection is retained in deterministic client order.
      teardownErrors.push(
        new Error(`PostgreSQL test ${index === 0 ? "writer" : "observer"} close failed`, {
          cause: result.reason,
        }),
      );
    }
  }

  if (primaryFailed) {
    if (teardownErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...teardownErrors],
        "PostgreSQL capacity proof and teardown both failed",
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (teardownErrors.length > 0) {
    throw new AggregateError(teardownErrors, "PostgreSQL capacity proof teardown failed");
  }
  return value as T;
}

function teardownClient(
  name: string,
  events: string[],
  failures: {
    connectGate?: Promise<void>;
    connect?: Error;
    rollback?: Error;
    close?: Error;
  } = {},
): PostgresTestClient {
  return {
    async connect(): Promise<void> {
      events.push(`${name}:connect`);
      await failures.connectGate;
      if (failures.connect) throw failures.connect;
    },
    async query(query: string): Promise<void> {
      events.push(`${name}:${query}`);
      if (query === "ROLLBACK" && failures.rollback) throw failures.rollback;
    },
    async end(): Promise<void> {
      events.push(`${name}:close`);
      if (failures.close) throw failures.close;
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    // error-policy:J1 boundary translation — tests inspect the rejection as a
    // value so they can verify exact identity and aggregate ordering.
    return error;
  }
  throw new Error("Expected promise to reject");
}

describe("PostgreSQL capacity proof teardown", () => {
  test("preserves the proof failure and closes the observer when writer close throws synchronously", async () => {
    const events: string[] = [];
    const primary = new Error("primary proof failed");
    const closeFailure = new Error("synchronous writer close failure");
    const writer = teardownClient("writer", events);
    writer.end = () => {
      events.push("writer:close");
      throw closeFailure;
    };
    const rejection = await rejectionOf(
      runWithOrderedPostgresTeardown(writer, teardownClient("observer", events), async () => {
        throw primary;
      }),
    );

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors[0]).toBe(primary);
    expect((rejection as AggregateError).errors[1].cause).toBe(closeFailure);
    expect((rejection as AggregateError).cause).toBe(primary);
    expect(events).toEqual([
      "writer:connect",
      "observer:connect",
      "writer:ROLLBACK",
      "writer:close",
      "observer:close",
    ]);
  });

  test("closes both clients without rolling back a writer that failed to connect", async () => {
    const events: string[] = [];
    const connectionFailure = new Error("writer connection failed");
    const rejection = await rejectionOf(
      runWithOrderedPostgresTeardown(
        teardownClient("writer", events, { connect: connectionFailure }),
        teardownClient("observer", events),
        async () => {
          throw new Error("proof must not run after failed connection");
        },
      ),
    );
    expect(rejection).toBe(connectionFailure);
    expect(events).toEqual([
      "writer:connect",
      "observer:connect",
      "writer:close",
      "observer:close",
    ]);
  });

  test("preserves a primary proof failure after ordered successful teardown", async () => {
    const events: string[] = [];
    const primary = new Error("primary proof failed");
    const rejection = await rejectionOf(
      runWithOrderedPostgresTeardown(
        teardownClient("writer", events),
        teardownClient("observer", events),
        async () => {
          throw primary;
        },
      ),
    );

    expect(rejection).toBe(primary);
    expect(events).toEqual([
      "writer:connect",
      "observer:connect",
      "writer:ROLLBACK",
      "writer:close",
      "observer:close",
    ]);
  });

  test("awaits a late writer connection and closes both clients when the observer fails", async () => {
    const events: string[] = [];
    const connectionFailure = new Error("observer connection failed");
    let releaseWriter!: () => void;
    const writerConnectGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let proofRan = false;
    const outcome = rejectionOf(
      runWithOrderedPostgresTeardown(
        teardownClient("writer", events, { connectGate: writerConnectGate }),
        teardownClient("observer", events, { connect: connectionFailure }),
        async () => {
          proofRan = true;
        },
      ),
    );
    await Promise.resolve();

    expect(events).toEqual(["writer:connect", "observer:connect"]);
    expect(proofRan).toBe(false);
    releaseWriter();
    const rejection = await outcome;

    expect(rejection).toBe(connectionFailure);
    expect(proofRan).toBe(false);
    expect(events).toEqual([
      "writer:connect",
      "observer:connect",
      "writer:ROLLBACK",
      "writer:close",
      "observer:close",
    ]);
  });

  test("retains rollback and both close failures in deterministic order", async () => {
    const events: string[] = [];
    const rejection = await rejectionOf(
      runWithOrderedPostgresTeardown(
        teardownClient("writer", events, {
          rollback: new Error("rollback failed"),
          close: new Error("writer close failed"),
        }),
        teardownClient("observer", events, { close: new Error("observer close failed") }),
        async () => "proved",
      ),
    );

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      "PostgreSQL test rollback failed",
      "PostgreSQL test writer close failed",
      "PostgreSQL test observer close failed",
    ]);
    expect(events).toEqual([
      "writer:connect",
      "observer:connect",
      "writer:ROLLBACK",
      "writer:close",
      "observer:close",
    ]);
  });

  test("aggregates teardown failures after the preserved primary failure", async () => {
    const events: string[] = [];
    const primary = new Error("primary proof failed");
    const rejection = await rejectionOf(
      runWithOrderedPostgresTeardown(
        teardownClient("writer", events, { rollback: new Error("rollback failed") }),
        teardownClient("observer", events),
        async () => {
          throw primary;
        },
      ),
    );

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors[0]).toBe(primary);
    expect((rejection as AggregateError).errors[1]).toBeInstanceOf(Error);
    expect((rejection as AggregateError).cause).toBe(primary);
    expect(events).toEqual([
      "writer:connect",
      "observer:connect",
      "writer:ROLLBACK",
      "writer:close",
      "observer:close",
    ]);
  });
});

beforeAll(async () => {
  if (!postgres) {
    console.warn(SKIP_REASON);
    return;
  }
  isolatedDsn = await createIsolatedDatabase(postgres.dsn);
  pool = new Pool({ connectionString: isolatedDsn, max: 6 });
  database = drizzle(pool);
  await createTables(pool);
}, 30_000);

beforeEach(async () => {
  if (postgres) await resetFixture();
});

afterAll(async () => {
  await pool?.end();
  pool = null;
  database = null;
  if (postgres && databaseName) await dropIsolatedDatabase(postgres.dsn, databaseName);
  await postgres?.stop();
  postgres = null;
}, 30_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("Docker capacity recount PostgreSQL serialization", () => {
  test("standalone aggregate count keeps one statement snapshot across lifecycle transfer", async () => {
    if (!isolatedDsn || !pool || !database) throw new Error("PostgreSQL harness unavailable");
    await pool.query(
      `INSERT INTO agent_sandbox_replacement_attempts
         (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
       VALUES ($1, $2, true, $3, 'provider_succeeded')`,
      [ATTEMPT_ID, NODE_ID, RESTORE_ID],
    );
    const writer = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await runWithOrderedPostgresTeardown(writer, observer, async () => {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM docker_nodes WHERE node_id = $1 FOR UPDATE", [NODE_ID]);
      await writer.query("LOCK TABLE agent_sandbox_replacement_attempts IN ACCESS EXCLUSIVE MODE");
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      const count = countAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID);
      await waitUntilBlockedBy(observer, pid);
      // The old serial implementation had already observed no canonical
      // sandbox when it blocked on its final replacement-attempt SELECT. This
      // atomic handoff then made that last SELECT observe no reservation too,
      // returning zero. The aggregate implementation can observe only the
      // complete pre-commit or post-commit state of its one statement.
      await writer.query(
        "UPDATE agent_sandbox_replacement_attempts SET state = 'lifecycle_committed' WHERE id = $1",
        [ATTEMPT_ID],
      );
      await writer.query(
        "INSERT INTO agent_sandboxes (id, node_id, status) VALUES ($1, $2, 'running')",
        [SANDBOX_ID, NODE_ID],
      );
      await writer.query("COMMIT");

      expect(await count).toBe(1);
      expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(1);
    });
  }, 10_000);

  test("reserve followed by recount preserves the newly owned slot", async () => {
    if (!isolatedDsn || !pool || !database) throw new Error("PostgreSQL harness unavailable");
    const writer = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await runWithOrderedPostgresTeardown(writer, observer, async () => {
      await writer.query("BEGIN");
      await writer.query(
        "UPDATE docker_nodes SET allocated_count = allocated_count + 1 WHERE node_id = $1",
        [NODE_ID],
      );
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      const recount = reconcileAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID);
      await waitUntilBlockedBy(observer, pid);
      await writer.query(
        `INSERT INTO agent_sandbox_replacement_attempts
           (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
         VALUES ($1, $2, true, $3, 'in_flight_unresolved')`,
        [ATTEMPT_ID, NODE_ID, RESTORE_ID],
      );
      await writer.query("COMMIT");

      expect(await recount).toEqual({ before: 1, after: 1 });
      expect(await readAllocatedCount(pool)).toBe(1);
      expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(1);
    });
  }, 10_000);

  test("cleanup followed by recount cannot resurrect or double-release the slot", async () => {
    if (!isolatedDsn || !pool || !database) throw new Error("PostgreSQL harness unavailable");
    await pool.query("UPDATE docker_nodes SET allocated_count = 1 WHERE node_id = $1", [NODE_ID]);
    await pool.query(
      `INSERT INTO agent_sandbox_replacement_attempts
         (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
       VALUES ($1, $2, true, $3, 'cleanup_in_progress')`,
      [ATTEMPT_ID, NODE_ID, RESTORE_ID],
    );
    const writer = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await runWithOrderedPostgresTeardown(writer, observer, async () => {
      await writer.query("BEGIN");
      await writer.query(
        "UPDATE docker_nodes SET allocated_count = allocated_count - 1 WHERE node_id = $1",
        [NODE_ID],
      );
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      const recount = reconcileAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID);
      await waitUntilBlockedBy(observer, pid);
      await writer.query(
        "UPDATE agent_sandbox_replacement_attempts SET state = 'cleanup_proven' WHERE id = $1",
        [ATTEMPT_ID],
      );
      await writer.query("COMMIT");

      expect(await recount).toEqual({ before: 0, after: 0 });
      expect(await readAllocatedCount(pool)).toBe(0);
      expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(0);
    });
  }, 10_000);

  test("lifecycle transfer followed by recount counts exactly the canonical sandbox slot", async () => {
    if (!isolatedDsn || !pool || !database) throw new Error("PostgreSQL harness unavailable");
    await pool.query("UPDATE docker_nodes SET allocated_count = 1 WHERE node_id = $1", [NODE_ID]);
    await pool.query(
      `INSERT INTO agent_sandbox_replacement_attempts
         (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
       VALUES ($1, $2, true, $3, 'provider_succeeded')`,
      [ATTEMPT_ID, NODE_ID, RESTORE_ID],
    );
    const writer = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await runWithOrderedPostgresTeardown(writer, observer, async () => {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM docker_nodes WHERE node_id = $1 FOR UPDATE", [NODE_ID]);
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      const recount = reconcileAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID);
      await waitUntilBlockedBy(observer, pid);
      await writer.query(
        "UPDATE agent_sandbox_replacement_attempts SET state = 'lifecycle_committed' WHERE id = $1",
        [ATTEMPT_ID],
      );
      await writer.query(
        "INSERT INTO agent_sandboxes (id, node_id, status) VALUES ($1, $2, 'running')",
        [SANDBOX_ID, NODE_ID],
      );
      await writer.query("COMMIT");

      expect(await recount).toEqual({ before: 1, after: 1 });
      expect(await readAllocatedCount(pool)).toBe(1);
      expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(1);
    });
  }, 10_000);

  test("an absent replacement table does not abort repair of a divergent counter", async () => {
    if (!pool || !database) throw new Error("PostgreSQL harness unavailable");
    await pool.query("DROP TABLE agent_sandbox_replacement_attempts");
    await pool.query("UPDATE docker_nodes SET allocated_count = 9 WHERE node_id = $1", [NODE_ID]);
    await pool.query("INSERT INTO containers (id, node_id, status) VALUES ($1, $2, 'running')", [
      randomUUID(),
      NODE_ID,
    ]);

    const result = await reconcileAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID);

    expect(result).toEqual({ before: 9, after: 1 });
    expect(await readAllocatedCount(pool)).toBe(1);
  });
});

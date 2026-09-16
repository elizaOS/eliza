/**
 * Real-PostgreSQL proof for the exact-restore orphan ownership handoff.
 *
 * Adoption atomically terminalizes the replacement attempt and publishes the
 * canonical sandbox row. READ COMMITTED gives each statement its own snapshot,
 * so the destructive reaper must read attempts first and sandboxes second. The
 * controlled pool below commits adoption between those snapshots. It also runs
 * the former sandbox-first Promise.all shape as a non-vacuous witness: that
 * ordering observes neither authority, while the production ordering retains
 * both sides of the handoff.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import type { Database } from "../../../db/helpers";
import {
  AGENT_SANDBOX_REPLACEMENT_GLOBAL_FENCE_STATES,
  agentSandboxReplacementAttempts,
} from "../../../db/schemas/agent-sandbox-replacement-attempts";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { loadSandboxStatusesByIdsWithDatabase } from "../docker-node-workloads";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../tenant-db/__tests__/ephemeral-postgres";

const SKIP_REASON =
  "[exact restore orphan adoption] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RESTORE_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const REPLACEMENT_ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const EXACT_KEY = `restore-${AGENT_ID}-${RESTORE_ATTEMPT_ID}`;
const CONTAINER_NAME = `agent-${EXACT_KEY}`;
const NODE_ID = "node-exact-adoption";

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
if (!postgres) console.warn(SKIP_REASON);

let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let pool: Pool | null = null;
let writer: Client | null = null;

async function createIsolatedDatabase(baseDsn: string): Promise<string> {
  databaseName = `eliza_orphan_adoption_${randomUUID().replaceAll("-", "")}`;
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

async function resetFixture(client: Client): Promise<void> {
  await client.query(`
    TRUNCATE TABLE agent_sandboxes, agent_sandbox_replacement_attempts;
    INSERT INTO agent_sandbox_replacement_attempts (
      id,
      agent_id,
      restore_attempt_id,
      state,
      locator_container_name,
      locator_node_id
    ) VALUES (
      '${REPLACEMENT_ATTEMPT_ID}',
      '${AGENT_ID}',
      '${RESTORE_ATTEMPT_ID}',
      'in_flight_unresolved',
      '${CONTAINER_NAME}',
      '${NODE_ID}'
    );
  `);
}

type Observation =
  | "attempt:before_adoption"
  | "attempt:after_adoption"
  | "sandbox:before_adoption"
  | "sandbox:after_adoption";

function statementText(args: readonly unknown[]): string {
  const statement = args[0];
  if (typeof statement === "string") return statement;
  if (typeof statement === "object" && statement !== null && "text" in statement) {
    const text = (statement as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function createAdoptionInterleavingDatabase(args: { queryPool: Pool; adoptionWriter: Client }): {
  database: Database;
  observations: Observation[];
  reset: () => void;
} {
  const observations: Observation[] = [];
  let adopted = false;

  const adopt = async (): Promise<void> => {
    if (adopted) throw new Error("adoption interleaving ran more than once");
    await args.adoptionWriter.query("BEGIN");
    try {
      await args.adoptionWriter.query(
        "UPDATE agent_sandbox_replacement_attempts " +
          "SET state = 'lifecycle_committed' WHERE id = $1",
        [REPLACEMENT_ATTEMPT_ID],
      );
      await args.adoptionWriter.query(
        `INSERT INTO agent_sandboxes (
           id, container_name, status, node_id,
           replacement_cleanup_node_id, replacement_cleanup_container_name
         ) VALUES ($1, $2, 'running', $3, NULL, NULL)`,
        [AGENT_ID, CONTAINER_NAME, NODE_ID],
      );
      await args.adoptionWriter.query("COMMIT");
      adopted = true;
    } catch (error) {
      await args.adoptionWriter.query("ROLLBACK").catch(() => {});
      throw error;
    }
  };

  const interleavedQuery = async (...queryArgs: unknown[]): Promise<unknown> => {
    const text = statementText(queryArgs);
    const readsAttempts = text.includes('from "agent_sandbox_replacement_attempts"');
    const readsSandboxes = text.includes('from "agent_sandboxes"');
    if (!readsAttempts && !readsSandboxes) {
      const execute = args.queryPool.query.bind(args.queryPool) as unknown as (
        ...values: unknown[]
      ) => Promise<unknown>;
      return execute(...queryArgs);
    }

    // Holding the only pool checkout until the adoption commit makes the two
    // Promise.all reads execute in their submitted order, instead of relying on
    // scheduler timing. The writer is a distinct PostgreSQL connection.
    const client = await args.queryPool.connect();
    const execute = client.query.bind(client) as unknown as (
      ...values: unknown[]
    ) => Promise<unknown>;
    try {
      if (readsAttempts) {
        const result = await execute(...queryArgs);
        observations.push(adopted ? "attempt:after_adoption" : "attempt:before_adoption");
        return result;
      }

      if (observations.length === 0) {
        // Former Promise.all shape: sandbox snapshot first, commit, then the
        // queued attempt snapshot. Both snapshots omit the transferred owner.
        const result = await execute(...queryArgs);
        observations.push("sandbox:before_adoption");
        await adopt();
        return result;
      }

      // Production shape: the active-attempt result is already retained. Move
      // authority atomically, then let the later sandbox snapshot see adoption.
      await adopt();
      const result = await execute(...queryArgs);
      observations.push("sandbox:after_adoption");
      return result;
    } finally {
      client.release();
    }
  };

  const controlledPool = new Proxy(args.queryPool, {
    get(target, property, receiver) {
      if (property === "query") return interleavedQuery;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const database = drizzle(controlledPool, {
    schema: { agentSandboxes, agentSandboxReplacementAttempts },
  }) as unknown as Database;

  return {
    database,
    observations,
    reset: () => {
      observations.length = 0;
      adopted = false;
    },
  };
}

beforeAll(async () => {
  if (!postgres) return;
  isolatedDsn = await createIsolatedDatabase(postgres.dsn);
  pool = new Pool({ connectionString: isolatedDsn, max: 1 });
  writer = new Client({ connectionString: isolatedDsn });
  await writer.connect();
  await writer.query(`
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      container_name text,
      status text NOT NULL,
      node_id text,
      replacement_cleanup_node_id text,
      replacement_cleanup_container_name text
    );
    CREATE TABLE agent_sandbox_replacement_attempts (
      id uuid PRIMARY KEY,
      agent_id uuid NOT NULL,
      restore_attempt_id uuid,
      state text NOT NULL,
      locator_container_name text,
      locator_node_id text
    );
  `);
}, 30_000);

afterAll(async () => {
  await writer?.query("ROLLBACK").catch(() => {});
  await writer?.end();
  writer = null;
  await pool?.end();
  pool = null;
  if (postgres && databaseName) await dropIsolatedDatabase(postgres.dsn, databaseName);
  await postgres?.stop();
  postgres = null;
}, 30_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("exact restore orphan adoption PostgreSQL snapshots", () => {
  test("attempt-first ownership survives an adoption committed between both snapshots", async () => {
    if (!pool || !writer || !isolatedDsn) throw new Error("PostgreSQL harness unavailable");
    await resetFixture(writer);
    const interleaving = createAdoptionInterleavingDatabase({
      queryPool: pool,
      adoptionWriter: writer,
    });

    // Non-vacuous witness for the former implementation. The sandbox read is
    // submitted first, adoption commits, and the attempt read runs second.
    const [unsafeSandboxRows, unsafeAttemptRows] = await Promise.all([
      interleaving.database
        .select({ containerName: agentSandboxes.container_name })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.container_name, CONTAINER_NAME)),
      interleaving.database
        .select({ state: agentSandboxReplacementAttempts.state })
        .from(agentSandboxReplacementAttempts)
        .where(
          and(
            eq(agentSandboxReplacementAttempts.locator_container_name, CONTAINER_NAME),
            inArray(
              agentSandboxReplacementAttempts.state,
              AGENT_SANDBOX_REPLACEMENT_GLOBAL_FENCE_STATES,
            ),
            sql`${agentSandboxReplacementAttempts.restore_attempt_id} IS NOT NULL`,
          ),
        ),
    ]);
    expect(interleaving.observations).toEqual([
      "sandbox:before_adoption",
      "attempt:after_adoption",
    ]);
    expect(unsafeSandboxRows).toEqual([]);
    expect(unsafeAttemptRows).toEqual([]);

    await resetFixture(writer);
    interleaving.reset();
    const protectedRows = await loadSandboxStatusesByIdsWithDatabase(interleaving.database, [
      EXACT_KEY,
    ]);

    expect(interleaving.observations).toEqual([
      "attempt:before_adoption",
      "sandbox:after_adoption",
    ]);
    expect(protectedRows).toEqual(
      expect.arrayContaining([
        { key: EXACT_KEY, status: "replacement_attempt_owned", nodeId: NODE_ID },
        { key: EXACT_KEY, status: "running", nodeId: NODE_ID },
      ]),
    );
    const finalAuthority = await writer.query<{ attempt_state: string; sandbox_count: number }>(
      `SELECT a.state AS attempt_state,
              (SELECT count(*)::int FROM agent_sandboxes) AS sandbox_count
       FROM agent_sandbox_replacement_attempts a
       WHERE a.id = $1`,
      [REPLACEMENT_ATTEMPT_ID],
    );
    expect(finalAuthority.rows[0]).toEqual({
      attempt_state: "lifecycle_committed",
      sandbox_count: 1,
    });
  }, 15_000);
});

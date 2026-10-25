/**
 * Exact-restore capacity recount authority against real Drizzle/PGlite SQL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  countAllocatedWorkloadsOnNodeWithDatabase,
  reconcileAllocatedWorkloadsOnNodeWithDatabase,
} from "./docker-node-workload-queries";

const NODE_ID = "exact-restore-capacity-node";
const NODE_RECORD_ID = "10000000-0000-4000-8000-000000000001";

let client: PGlite;
let database: ReturnType<typeof drizzle>;

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

async function allocatedCount(): Promise<number> {
  const [row] = (
    await client.query<{ allocated_count: number }>(
      `SELECT allocated_count FROM docker_nodes WHERE node_id = '${NODE_ID}'`,
    )
  ).rows;
  if (!row) throw new Error("test Docker node is missing");
  return row.allocated_count;
}

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client);
  await client.exec(`
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY,
      node_id text NOT NULL UNIQUE,
      allocated_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE containers (
      id uuid PRIMARY KEY,
      node_id text,
      status text NOT NULL
    );
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      node_id text,
      status text NOT NULL,
      deletion_allocation_counted boolean,
      replacement_cleanup_node_id text,
      replacement_cleanup_allocation_counted boolean
    );
    CREATE TABLE agent_sandbox_replacement_attempts (
      id uuid PRIMARY KEY,
      locator_node_id text,
      locator_allocation_counted boolean,
      restore_attempt_id uuid,
      state text NOT NULL
    );
  `);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE containers, agent_sandboxes, agent_sandbox_replacement_attempts;
    DELETE FROM docker_nodes;
    INSERT INTO docker_nodes (id, node_id, allocated_count)
    VALUES ('${NODE_RECORD_ID}', '${NODE_ID}', 0);
  `);
});

describe("exact-restore Docker capacity recount", () => {
  test("includes only counted active exact-restore attempt states", async () => {
    const states = [
      "in_flight_unresolved",
      "cleanup_in_progress",
      "provider_succeeded",
      "lifecycle_committed",
      "cleanup_proven",
    ] as const;
    const values = states
      .map(
        (state, index) =>
          `('20000000-0000-4000-8000-00000000000${index + 1}', '${NODE_ID}', true,
            '30000000-0000-4000-8000-00000000000${index + 1}', '${state}')`,
      )
      .join(",");
    await client.exec(`
      INSERT INTO agent_sandbox_replacement_attempts
        (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
      VALUES ${values},
        ('20000000-0000-4000-8000-000000000006', '${NODE_ID}', true, NULL,
          'in_flight_unresolved'),
        ('20000000-0000-4000-8000-000000000007', '${NODE_ID}', false,
          '30000000-0000-4000-8000-000000000007', 'provider_succeeded');
    `);

    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(3);
  });

  test("lifecycle commitment transfers one slot to the active sandbox without double counting", async () => {
    await client.exec(`
      INSERT INTO agent_sandboxes (id, node_id, status)
      VALUES ('40000000-0000-4000-8000-000000000001', '${NODE_ID}', 'running');
      INSERT INTO agent_sandbox_replacement_attempts
        (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
      VALUES ('20000000-0000-4000-8000-000000000001', '${NODE_ID}', true,
        '30000000-0000-4000-8000-000000000001', 'lifecycle_committed');
    `);

    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(1);
  });

  test("recount repairs an active reservation and later removes only cleanup-proven ownership", async () => {
    await client.exec(`
      INSERT INTO agent_sandbox_replacement_attempts
        (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
      VALUES ('20000000-0000-4000-8000-000000000001', '${NODE_ID}', true,
        '30000000-0000-4000-8000-000000000001', 'provider_succeeded');
    `);

    expect(await reconcileAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toEqual({
      before: 0,
      after: 1,
    });
    expect(await allocatedCount()).toBe(1);

    await client.exec(`
      UPDATE agent_sandbox_replacement_attempts
      SET state = 'cleanup_proven'
      WHERE id = '20000000-0000-4000-8000-000000000001';
    `);
    expect(await reconcileAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toEqual({
      before: 1,
      after: 0,
    });
    expect(await allocatedCount()).toBe(0);
  });

  test("concurrent reserve then recount preserves the newly owned slot", async () => {
    const writerHasNode = deferred();
    const releaseWriter = deferred();
    const reserve = database.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE docker_nodes
            SET allocated_count = allocated_count + 1
            WHERE node_id = ${NODE_ID}`,
      );
      writerHasNode.resolve();
      await releaseWriter.promise;
      await tx.execute(sql`
        INSERT INTO agent_sandbox_replacement_attempts
          (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
        VALUES ('20000000-0000-4000-8000-000000000001', ${NODE_ID}, true,
          '30000000-0000-4000-8000-000000000001', 'in_flight_unresolved')
      `);
    });
    await writerHasNode.promise;

    const recount = reconcileAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID);
    releaseWriter.resolve();
    await Promise.all([reserve, recount]);

    expect(await allocatedCount()).toBe(1);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(1);
  });

  test("concurrent cleanup then recount cannot resurrect or double-release the slot", async () => {
    await client.exec(`
      UPDATE docker_nodes SET allocated_count = 1 WHERE node_id = '${NODE_ID}';
      INSERT INTO agent_sandbox_replacement_attempts
        (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
      VALUES ('20000000-0000-4000-8000-000000000001', '${NODE_ID}', true,
        '30000000-0000-4000-8000-000000000001', 'cleanup_in_progress');
    `);
    const writerHasNode = deferred();
    const releaseWriter = deferred();
    const cleanup = database.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE docker_nodes
            SET allocated_count = allocated_count - 1
            WHERE node_id = ${NODE_ID} AND allocated_count > 0`,
      );
      writerHasNode.resolve();
      await releaseWriter.promise;
      await tx.execute(sql`
        UPDATE agent_sandbox_replacement_attempts
        SET state = 'cleanup_proven'
        WHERE id = '20000000-0000-4000-8000-000000000001'
      `);
    });
    await writerHasNode.promise;

    const recount = reconcileAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID);
    releaseWriter.resolve();
    await Promise.all([cleanup, recount]);

    expect(await allocatedCount()).toBe(0);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(0);
  });

  test("repairs a divergent counter while the rolling-deploy replacement table is absent", async () => {
    await client.exec(`
      DROP TABLE agent_sandbox_replacement_attempts;
      UPDATE docker_nodes SET allocated_count = 9 WHERE node_id = '${NODE_ID}';
      INSERT INTO containers (id, node_id, status)
      VALUES ('50000000-0000-4000-8000-000000000001', '${NODE_ID}', 'running');
    `);

    try {
      expect(await reconcileAllocatedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toEqual({
        before: 9,
        after: 1,
      });
      expect(await allocatedCount()).toBe(1);
    } finally {
      await client.exec(`
        CREATE TABLE agent_sandbox_replacement_attempts (
          id uuid PRIMARY KEY,
          locator_node_id text,
          locator_allocation_counted boolean,
          restore_attempt_id uuid,
          state text NOT NULL
        );
      `);
    }
  });
});

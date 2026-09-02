/**
 * Real-SQL drain safety for retained exact-restore reservations and candidates.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../../db/helpers";
import { countRetainedWorkloadsOnNodeWithDatabase } from "./docker-node-workloads";

const NODE_ID = "exact-restore-retained-node";
let client: PGlite;
let database: Database;

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client) as unknown as Database;
  await client.exec(`
    CREATE TABLE containers (
      id uuid PRIMARY KEY,
      node_id text,
      status text NOT NULL
    );
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      node_id text,
      status text NOT NULL,
      pool_status text,
      replacement_cleanup_node_id text
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
  `);
});

describe("countRetainedWorkloadsOnNodeWithDatabase", () => {
  test("keeps rolling deploys functional before the replacement table exists", async () => {
    const legacyClient = new PGlite();
    try {
      await legacyClient.exec(`
        CREATE TABLE containers (
          id uuid PRIMARY KEY,
          node_id text,
          status text NOT NULL
        );
        CREATE TABLE agent_sandboxes (
          id uuid PRIMARY KEY,
          node_id text,
          status text NOT NULL,
          pool_status text,
          replacement_cleanup_node_id text
        );
        INSERT INTO containers (id, node_id, status)
        VALUES ('40000000-0000-4000-8000-000000000001', '${NODE_ID}', 'stopped');
      `);
      const legacyDatabase = drizzle(legacyClient) as unknown as Database;

      expect(await countRetainedWorkloadsOnNodeWithDatabase(legacyDatabase, NODE_ID)).toBe(1);
    } finally {
      await legacyClient.close();
    }
  });

  test("retains only active counted exact-restore authority on its locator node", async () => {
    const states = [
      "in_flight_unresolved",
      "provider_succeeded",
      "cleanup_in_progress",
      "lifecycle_committed",
      "cleanup_proven",
    ] as const;
    const values = states
      .map(
        (state, index) =>
          `('10000000-0000-4000-8000-00000000000${index + 1}', '${NODE_ID}', true,
            '20000000-0000-4000-8000-00000000000${index + 1}', '${state}')`,
      )
      .join(",");
    await client.exec(`
      INSERT INTO agent_sandbox_replacement_attempts
        (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
      VALUES ${values},
        ('10000000-0000-4000-8000-000000000006', '${NODE_ID}', false,
          '20000000-0000-4000-8000-000000000006', 'provider_succeeded'),
        ('10000000-0000-4000-8000-000000000007', '${NODE_ID}', true,
          NULL, 'in_flight_unresolved'),
        ('10000000-0000-4000-8000-000000000008', 'other-node', true,
          '20000000-0000-4000-8000-000000000008', 'provider_succeeded');
    `);

    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(3);
  });

  test("lifecycle adoption transfers retention to the canonical sandbox without double count", async () => {
    await client.exec(`
      INSERT INTO agent_sandboxes (id, node_id, status, pool_status)
      VALUES ('30000000-0000-4000-8000-000000000001', '${NODE_ID}', 'running', NULL);
      INSERT INTO agent_sandbox_replacement_attempts
        (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
      VALUES ('10000000-0000-4000-8000-000000000001', '${NODE_ID}', true,
        '20000000-0000-4000-8000-000000000001', 'lifecycle_committed');
    `);

    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(1);
  });

  test("composes ordinary, cleanup, and exact-restore retained ledgers", async () => {
    await client.exec(`
      INSERT INTO containers (id, node_id, status)
      VALUES ('40000000-0000-4000-8000-000000000001', '${NODE_ID}', 'stopped');
      INSERT INTO agent_sandboxes
        (id, node_id, status, pool_status, replacement_cleanup_node_id)
      VALUES
        ('30000000-0000-4000-8000-000000000001', '${NODE_ID}', 'running', NULL, NULL),
        ('30000000-0000-4000-8000-000000000002', 'other-node', 'running', NULL, '${NODE_ID}');
      INSERT INTO agent_sandbox_replacement_attempts
        (id, locator_node_id, locator_allocation_counted, restore_attempt_id, state)
      VALUES ('10000000-0000-4000-8000-000000000001', '${NODE_ID}', true,
        '20000000-0000-4000-8000-000000000001', 'in_flight_unresolved');
    `);

    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, NODE_ID)).toBe(4);
  });
});

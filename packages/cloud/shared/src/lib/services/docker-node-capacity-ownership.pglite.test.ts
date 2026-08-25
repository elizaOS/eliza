/** Real-SQL coverage for restore -> replacement -> sandbox slot reconciliation. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  countAllocatedWorkloadsOnNodeWithDatabase,
  countRetainedWorkloadsOnNodeWithDatabase,
} from "./docker-node-workload-queries";

const NODE_RECORD_ID = "00000000-0000-0000-0000-0000000000d1";
const OTHER_NODE_RECORD_ID = "00000000-0000-0000-0000-0000000000d2";
const NODE_INCARNATION = "00000000-0000-0000-0000-0000000000d3";
const NODE_HISTORY_ID = "00000000-0000-0000-0000-0000000000d4";
const OTHER_NODE_INCARNATION = "00000000-0000-0000-0000-0000000000d5";
const OTHER_NODE_HISTORY_ID = "00000000-0000-0000-0000-0000000000d6";
const ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000e1";
const AGENT_ID = "00000000-0000-0000-0000-0000000000e2";
const REPLACEMENT_ATTEMPT_ID = "00000000-0000-0000-0000-0000000000e3";
const OTHER_ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000e4";
const OTHER_AGENT_ID = "00000000-0000-0000-0000-0000000000e5";
const OTHER_REPLACEMENT_ATTEMPT_ID = "00000000-0000-0000-0000-0000000000e6";

let client: PGlite;
let database: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client);
  await client.exec(`
    CREATE TABLE containers (
      node_id text,
      status text NOT NULL,
      volume_path text,
      hcloud_volume_id integer,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE agent_sandboxes (
      id uuid,
      organization_id uuid,
      node_id text,
      status text NOT NULL,
      pool_status text,
      deletion_allocation_counted boolean,
      replacement_cleanup_sandbox_id text,
      replacement_cleanup_node_id text,
      replacement_cleanup_node_record_id uuid,
      replacement_cleanup_node_incarnation uuid,
      replacement_cleanup_node_history_id uuid,
      replacement_cleanup_container_name text,
      replacement_cleanup_attempt_id uuid,
      replacement_cleanup_container_id text,
      replacement_cleanup_allocation_counted boolean
    );
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY,
      node_id text UNIQUE NOT NULL,
      node_incarnation uuid,
      current_node_history_id uuid
    );
    CREATE TABLE agent_backup_restore_operations (
      id uuid PRIMARY KEY,
      expected_node_record_id uuid,
      expected_node_id text,
      expected_node_incarnation uuid,
      expected_node_history_id uuid,
      capacity_state text
    );
    CREATE TABLE agent_sandbox_replacement_attempts (
      id uuid PRIMARY KEY,
      organization_id uuid,
      agent_id uuid,
      locator_sandbox_id text,
      locator_node_record_id uuid,
      locator_node_id text,
      locator_node_incarnation uuid,
      locator_node_history_id uuid,
      locator_container_name text,
      locator_container_id text,
      capacity_state text
    );
    INSERT INTO docker_nodes (
      id, node_id, node_incarnation, current_node_history_id
    ) VALUES
      ('${NODE_RECORD_ID}', 'node-a', '${NODE_INCARNATION}', '${NODE_HISTORY_ID}'),
      ('${OTHER_NODE_RECORD_ID}', 'node-b',
        '${OTHER_NODE_INCARNATION}', '${OTHER_NODE_HISTORY_ID}');
  `);
});

afterAll(async () => {
  await client.close();
});

async function resetCapacityFixtures(): Promise<void> {
  await client.exec(`
    DELETE FROM containers;
    DELETE FROM agent_sandboxes;
    DELETE FROM agent_backup_restore_operations;
    DELETE FROM agent_sandbox_replacement_attempts;
    UPDATE docker_nodes
    SET node_id = CASE
      WHEN id = '${NODE_RECORD_ID}' THEN 'reset-node-a'
      ELSE 'reset-node-b'
    END;
    UPDATE docker_nodes SET node_id = 'node-a' WHERE id = '${NODE_RECORD_ID}';
    UPDATE docker_nodes SET node_id = 'node-b' WHERE id = '${OTHER_NODE_RECORD_ID}';
    UPDATE docker_nodes SET
      node_incarnation = CASE
        WHEN id = '${NODE_RECORD_ID}' THEN '${NODE_INCARNATION}'::uuid
        ELSE '${OTHER_NODE_INCARNATION}'::uuid
      END,
      current_node_history_id = CASE
        WHEN id = '${NODE_RECORD_ID}' THEN '${NODE_HISTORY_ID}'::uuid
        ELSE '${OTHER_NODE_HISTORY_ID}'::uuid
      END;
  `);
}

beforeEach(async () => {
  await resetCapacityFixtures();
});

describe("durable capacity-owner workload reconciliation", () => {
  test("uses app slot markers as authority with a legacy status fallback", async () => {
    await client.exec(`
      INSERT INTO containers (node_id, status, metadata) VALUES
        ('node-a', 'running', '{}'::jsonb),
        ('node-a', 'failed', '{"slotClaimedAt":"2026-08-24T00:00:00Z"}'::jsonb),
        ('node-a', 'running', '{"slotReleasedAt":"2026-08-24T00:01:00Z"}'::jsonb),
        ('node-a', 'stopped', '{}'::jsonb);
    `);

    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(2);
  });

  test("retains a failed app while its durable slot claim remains unreleased", async () => {
    await client.exec(`
      INSERT INTO containers (node_id, status, volume_path, metadata)
      VALUES (
        'node-a', 'failed', NULL,
        '{"slotClaimedAt":"2026-08-24T00:00:00Z"}'::jsonb
      );
    `);

    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);

    await client.exec(`
      UPDATE containers
      SET metadata = jsonb_set(
        metadata, '{slotReleasedAt}', '"2026-08-24T00:01:00Z"'::jsonb
      );
    `);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(0);
  });

  test("retains terminal agents while durable deletion ownership remains true", async () => {
    await client.exec(`
      INSERT INTO agent_sandboxes (
        node_id, status, pool_status, deletion_allocation_counted
      ) VALUES
        ('node-a', 'stopped', NULL, TRUE),
        ('node-a', 'error', NULL, TRUE),
        ('node-a', 'stopped', NULL, NULL),
        ('node-a', 'error', NULL, FALSE);
    `);

    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(2);
  });

  test("retains every app volume_path even after a terminal status", async () => {
    await client.exec(`
      INSERT INTO containers (node_id, status, volume_path, hcloud_volume_id) VALUES
        ('node-a', 'failed', '/data/projects/org/failed', NULL),
        ('node-a', 'deleted', '/data/projects/org/deleted', NULL),
        ('node-a', 'failed', '/mnt/hcloud/project', 42),
        ('node-a', 'failed', NULL, NULL);
    `);

    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(3);
  });

  test("counts exactly one owner through restore, replacement, and sandbox handoffs", async () => {
    await client.exec(`
      INSERT INTO agent_backup_restore_operations (
        id, expected_node_record_id, expected_node_id, capacity_state
      ) VALUES (
        '00000000-0000-0000-0000-000000000101', '${NODE_RECORD_ID}', 'node-a', 'reserved'
      );
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);

    await client.transaction(async (tx) => {
      await tx.exec(`
        UPDATE agent_backup_restore_operations SET capacity_state = 'handed_off';
        INSERT INTO agent_sandbox_replacement_attempts (
          id, locator_node_record_id, locator_node_id, capacity_state
        ) VALUES (
          '00000000-0000-0000-0000-000000000102', '${NODE_RECORD_ID}', 'node-a', 'reserved'
        );
      `);
    });
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);

    await client.transaction(async (tx) => {
      await tx.exec(`
        UPDATE agent_sandbox_replacement_attempts SET capacity_state = 'handed_off';
        INSERT INTO agent_sandboxes (
          node_id, status, deletion_allocation_counted,
          replacement_cleanup_node_id, replacement_cleanup_allocation_counted
        ) VALUES ('node-a', 'running', NULL, NULL, NULL);
      `);
    });
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
  });

  test("released and handed-off ledger rows do not duplicate a sandbox", async () => {
    await client.exec(`
      INSERT INTO agent_backup_restore_operations (
        id, expected_node_record_id, expected_node_id, capacity_state
      ) VALUES (
        '00000000-0000-0000-0000-000000000103', '${NODE_RECORD_ID}', 'node-a', 'handed_off'
      );
      INSERT INTO agent_sandbox_replacement_attempts (
        id, locator_node_record_id, locator_node_id, capacity_state
      ) VALUES (
        '00000000-0000-0000-0000-000000000104', '${NODE_RECORD_ID}', 'node-a', 'released'
      );
      INSERT INTO agent_sandboxes (
        node_id, status, deletion_allocation_counted,
        replacement_cleanup_node_id, replacement_cleanup_allocation_counted
      ) VALUES ('node-a', 'running', NULL, NULL, NULL);
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    await client.exec(`DELETE FROM agent_sandboxes;`);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(0);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(0);
  });

  test("keeps a reserved owner across reboot but not logical-id reuse", async () => {
    await client.exec(`
      INSERT INTO agent_backup_restore_operations (
        id, expected_node_record_id, expected_node_id, capacity_state
      ) VALUES (
        '00000000-0000-0000-0000-000000000105', '${NODE_RECORD_ID}', 'node-a', 'reserved'
      );
      UPDATE docker_nodes
      SET node_incarnation = '00000000-0000-0000-0000-000000000201',
          current_node_history_id = '00000000-0000-0000-0000-000000000202'
      WHERE id = '${NODE_RECORD_ID}';
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);

    await client.exec(`
      UPDATE docker_nodes SET node_id = 'retired-node-a' WHERE id = '${NODE_RECORD_ID}';
      UPDATE docker_nodes SET node_id = 'node-a' WHERE id = '${OTHER_NODE_RECORD_ID}';
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(0);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(0);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "retired-node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "retired-node-a")).toBe(1);
  });

  test("retains stale cleanup on the same record without charging a reused logical id", async () => {
    await client.exec(`
      INSERT INTO agent_sandboxes (
        id, organization_id, status,
        replacement_cleanup_sandbox_id, replacement_cleanup_node_id,
        replacement_cleanup_node_record_id, replacement_cleanup_node_incarnation,
        replacement_cleanup_node_history_id, replacement_cleanup_container_name,
        replacement_cleanup_allocation_counted
      ) VALUES (
        '${AGENT_ID}', '${ORGANIZATION_ID}', 'stopped',
        'agent-old', 'node-a', '${NODE_RECORD_ID}', '${NODE_INCARNATION}',
        '${NODE_HISTORY_ID}', 'agent-old', TRUE
      );
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);

    await client.exec(`
      UPDATE docker_nodes
      SET node_incarnation = '00000000-0000-0000-0000-000000000301',
          current_node_history_id = '00000000-0000-0000-0000-000000000302'
      WHERE id = '${NODE_RECORD_ID}';
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);

    await client.exec(`
      UPDATE docker_nodes SET node_id = 'retired-node-a' WHERE id = '${NODE_RECORD_ID}';
      UPDATE docker_nodes SET node_id = 'node-a' WHERE id = '${OTHER_NODE_RECORD_ID}';
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(0);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(0);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "retired-node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "retired-node-a")).toBe(1);
  });

  test("keeps a legacy logical-only cleanup conservatively counted during rollout", async () => {
    await client.exec(`
      INSERT INTO agent_sandboxes (
        id, organization_id, status,
        replacement_cleanup_sandbox_id, replacement_cleanup_node_id,
        replacement_cleanup_container_name, replacement_cleanup_allocation_counted
      ) VALUES (
        '${AGENT_ID}', '${ORGANIZATION_ID}', 'stopped',
        'legacy-old', 'node-a', 'legacy-old', TRUE
      );
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);

    await client.exec(`
      UPDATE docker_nodes SET node_id = 'retired-node-a' WHERE id = '${NODE_RECORD_ID}';
      UPDATE docker_nodes SET node_id = 'node-a' WHERE id = '${OTHER_NODE_RECORD_ID}';
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
  });

  test("deduplicates an exact cleanup locator covered by its reserved attempt", async () => {
    await client.exec(`
      INSERT INTO agent_sandboxes (
        id, organization_id, status,
        replacement_cleanup_sandbox_id, replacement_cleanup_node_id,
        replacement_cleanup_node_record_id, replacement_cleanup_node_incarnation,
        replacement_cleanup_node_history_id,
        replacement_cleanup_container_name, replacement_cleanup_attempt_id,
        replacement_cleanup_container_id, replacement_cleanup_allocation_counted
      ) VALUES (
        '${AGENT_ID}', '${ORGANIZATION_ID}', 'stopped',
        'agent-candidate', 'node-a', '${NODE_RECORD_ID}', '${NODE_INCARNATION}',
        '${NODE_HISTORY_ID}', 'agent-candidate', '${REPLACEMENT_ATTEMPT_ID}',
        NULL, TRUE
      );
      INSERT INTO agent_sandbox_replacement_attempts (
        id, organization_id, agent_id, locator_sandbox_id,
        locator_node_record_id, locator_node_id, locator_node_incarnation,
        locator_node_history_id, locator_container_name,
        locator_container_id, capacity_state
      ) VALUES (
        '${REPLACEMENT_ATTEMPT_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}',
        'agent-candidate', '${NODE_RECORD_ID}', 'node-a', '${NODE_INCARNATION}',
        '${NODE_HISTORY_ID}', 'agent-candidate',
        'abcdef123456', 'reserved'
      );
    `);

    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);

    await client.exec(`
      UPDATE docker_nodes
      SET node_incarnation = '${OTHER_NODE_INCARNATION}',
          current_node_history_id = '${OTHER_NODE_HISTORY_ID}'
      WHERE id = '${NODE_RECORD_ID}';
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
  });

  test("does not deduplicate a different attempt, tenant, or agent owner", async () => {
    await client.exec(`
      INSERT INTO agent_sandboxes (
        id, organization_id, status,
        replacement_cleanup_sandbox_id, replacement_cleanup_node_id,
        replacement_cleanup_node_record_id, replacement_cleanup_node_incarnation,
        replacement_cleanup_node_history_id,
        replacement_cleanup_container_name, replacement_cleanup_attempt_id,
        replacement_cleanup_container_id, replacement_cleanup_allocation_counted
      ) VALUES (
        '${AGENT_ID}', '${ORGANIZATION_ID}', 'stopped',
        'agent-candidate', 'node-a', '${NODE_RECORD_ID}', '${NODE_INCARNATION}',
        '${NODE_HISTORY_ID}', 'agent-candidate', '${REPLACEMENT_ATTEMPT_ID}',
        NULL, TRUE
      );
      INSERT INTO agent_sandbox_replacement_attempts (
        id, organization_id, agent_id, locator_sandbox_id,
        locator_node_record_id, locator_node_id, locator_node_incarnation,
        locator_node_history_id, locator_container_name,
        locator_container_id, capacity_state
      ) VALUES (
        '${REPLACEMENT_ATTEMPT_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}',
        'agent-candidate', '${NODE_RECORD_ID}', 'node-a', '${NODE_INCARNATION}',
        '${NODE_HISTORY_ID}', 'agent-candidate',
        'abcdef123456', 'reserved'
      );
    `);

    await client.exec(`
      UPDATE agent_sandboxes
      SET replacement_cleanup_attempt_id = '${OTHER_REPLACEMENT_ATTEMPT_ID}';
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(2);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(2);

    await client.exec(`
      UPDATE agent_sandboxes
      SET replacement_cleanup_attempt_id = '${REPLACEMENT_ATTEMPT_ID}',
          organization_id = '${OTHER_ORGANIZATION_ID}';
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(2);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(2);

    await client.exec(`
      UPDATE agent_sandboxes
      SET organization_id = '${ORGANIZATION_ID}', id = '${OTHER_AGENT_ID}';
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(2);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(2);
  });

  test("counts distinct cleanup and reserved-attempt placements separately", async () => {
    await client.exec(`
      INSERT INTO agent_sandboxes (
        id, organization_id, status,
        replacement_cleanup_sandbox_id, replacement_cleanup_node_id,
        replacement_cleanup_node_record_id, replacement_cleanup_node_incarnation,
        replacement_cleanup_node_history_id,
        replacement_cleanup_container_name, replacement_cleanup_attempt_id,
        replacement_cleanup_container_id, replacement_cleanup_allocation_counted
      ) VALUES (
        '${AGENT_ID}', '${ORGANIZATION_ID}', 'stopped',
        'agent-old', 'node-a', '${NODE_RECORD_ID}', '${NODE_INCARNATION}',
        '${NODE_HISTORY_ID}', 'agent-old', '${REPLACEMENT_ATTEMPT_ID}',
        '111111111111', TRUE
      );
      INSERT INTO agent_sandbox_replacement_attempts (
        id, organization_id, agent_id, locator_sandbox_id,
        locator_node_record_id, locator_node_id, locator_node_incarnation,
        locator_node_history_id, locator_container_name,
        locator_container_id, capacity_state
      ) VALUES (
        '${REPLACEMENT_ATTEMPT_ID}', '${ORGANIZATION_ID}', '${AGENT_ID}',
        'agent-candidate', '${NODE_RECORD_ID}', 'node-a', '${NODE_INCARNATION}',
        '${NODE_HISTORY_ID}', 'agent-candidate',
        '222222222222', 'reserved'
      );
    `);

    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(2);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(2);

    await client.exec(`
      UPDATE agent_sandboxes
      SET replacement_cleanup_sandbox_id = 'agent-candidate',
          replacement_cleanup_container_name = 'agent-candidate',
          replacement_cleanup_container_id = '222222222222';
      UPDATE agent_sandbox_replacement_attempts
      SET locator_node_record_id = '${OTHER_NODE_RECORD_ID}', locator_node_id = 'node-b',
          locator_node_incarnation = '${OTHER_NODE_INCARNATION}',
          locator_node_history_id = '${OTHER_NODE_HISTORY_ID}';
    `);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-a")).toBe(1);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-b")).toBe(1);
    expect(await countRetainedWorkloadsOnNodeWithDatabase(database, "node-b")).toBe(1);
  });
});

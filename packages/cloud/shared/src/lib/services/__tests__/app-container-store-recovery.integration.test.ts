/**
 * Exercises app-container recovery reads and slot transactions against real
 * Postgres semantics using an isolated PGlite database.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  type AppContainerStoreRepository,
  ContainerRepoAppContainerStore,
} from "../app-container-store";
import { countAllocatedWorkloadsOnNodeWithDatabase } from "../docker-node-workload-queries";

const ORG_ONE = "00000000-0000-0000-0000-0000000000a1";
const ORG_TWO = "00000000-0000-0000-0000-0000000000a2";
const USER_ID = "00000000-0000-0000-0000-0000000000b1";
const DELETING_ID = "00000000-0000-0000-0000-0000000000c1";
const SLOT_ID = "00000000-0000-0000-0000-0000000000c4";
const CAPACITY_ID = "00000000-0000-0000-0000-0000000000c5";

let client: PGlite;
let database: ReturnType<typeof drizzle>;
let store: ContainerRepoAppContainerStore;
const statusUpdates: Array<{ id: string; status: string; error?: string }> = [];
const containerUpdates: Array<{
  id: string;
  organizationId: string;
  data: Parameters<AppContainerStoreRepository["update"]>[2];
}> = [];
const releasedSlots: Array<{ id: string; organizationId: string; nodeId: string }> = [];

beforeAll(async () => {
  client = new PGlite();
  database = drizzle(client);
  const repository: AppContainerStoreRepository = {
    updateStatus: async (id, status, error) => {
      statusUpdates.push({ id, status, ...(error ? { error } : {}) });
      return null;
    },
    update: async (id, organizationId, data) => {
      containerUpdates.push({ id, organizationId, data });
      return null;
    },
    tryReleaseNodeSlot: async (id, organizationId, nodeId) => {
      releasedSlots.push({ id, organizationId, nodeId });
      return true;
    },
  };
  store = new ContainerRepoAppContainerStore({
    readDatabase: database,
    writeDatabase: database,
    repository,
    errorFactory: (message, options) => {
      const error = new Error(message);
      error.name = options.code;
      return error;
    },
  });

  await client.exec(`
    CREATE TABLE containers (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      project_name text NOT NULL,
      image_tag text,
      port integer NOT NULL,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      environment_vars jsonb NOT NULL DEFAULT '{}',
      metadata jsonb NOT NULL DEFAULT '{}',
      node_id text,
      status text NOT NULL,
      error_message text,
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE docker_nodes (
      node_id text PRIMARY KEY,
      allocated_count integer NOT NULL DEFAULT 0,
      capacity integer NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      node_id text,
      status text NOT NULL
    );
    INSERT INTO docker_nodes (node_id, allocated_count, capacity, enabled)
    VALUES ('node-1', 0, 2, true), ('node-full', 1, 1, true);
    INSERT INTO containers
      (id, name, project_name, image_tag, port, organization_id, user_id, status)
    VALUES
      ('${DELETING_ID}', 'delete-me', 'app-1', 'image:1', 3000, '${ORG_ONE}', '${USER_ID}', 'deleting'),
      ('00000000-0000-0000-0000-0000000000c2', 'keep-running', 'app-2', 'image:2', 3000, '${ORG_ONE}', '${USER_ID}', 'running'),
      ('00000000-0000-0000-0000-0000000000c3', 'other-org', 'app-3', 'image:3', 3000, '${ORG_TWO}', '${USER_ID}', 'deleting'),
      ('${SLOT_ID}', 'slot-lifecycle', 'app-4', 'image:4', 3000, '${ORG_ONE}', '${USER_ID}', 'pending'),
      ('${CAPACITY_ID}', 'capacity-refusal', 'app-5', 'image:5', 3000, '${ORG_ONE}', '${USER_ID}', 'pending');
  `);
});

afterAll(async () => {
  await client.close();
});

describe("app-container persistence transactions", () => {
  test("recovery filters by both organization ownership and deleting status", async () => {
    const rows = await store.findDeletingByOrganization(ORG_ONE);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: DELETING_ID,
      organizationId: ORG_ONE,
      containerName: "delete-me",
    });
  });

  test("claims and rolls back exactly one authoritative node slot", async () => {
    expect(await store.claimNodeSlot(SLOT_ID, ORG_ONE, "node-1")).toBe(true);
    expect(await store.claimNodeSlot(SLOT_ID, ORG_ONE, "node-1")).toBe(false);
    expect(await store.getById(SLOT_ID)).toMatchObject({ id: SLOT_ID, nodeId: "node-1" });

    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-1")).toBe(1);

    expect(await store.rollbackNodeSlotClaim(SLOT_ID, ORG_ONE, "node-1")).toBe(true);
    expect(await store.rollbackNodeSlotClaim(SLOT_ID, ORG_ONE, "node-1")).toBe(false);
    expect(await countAllocatedWorkloadsOnNodeWithDatabase(database, "node-1")).toBe(0);

    const [rolledBack] = (
      await client.query<{ allocated_count: number; node_id: string | null; claimed: boolean }>(`
        SELECT docker_nodes.allocated_count, containers.node_id,
               jsonb_exists(containers.metadata, 'slotClaimedAt') AS claimed
        FROM containers CROSS JOIN docker_nodes
        WHERE containers.id = '${SLOT_ID}' AND docker_nodes.node_id = 'node-1'
      `)
    ).rows;
    expect(rolledBack).toEqual({ allocated_count: 0, node_id: null, claimed: false });
  });

  test("capacity refusal atomically rolls back attribution and claim metadata", async () => {
    await expect(store.claimNodeSlot(CAPACITY_ID, ORG_ONE, "node-full")).rejects.toMatchObject({
      name: "APP_CONTAINER_NODE_CAPACITY_UNAVAILABLE",
    });

    const [state] = (
      await client.query<{ allocated_count: number; node_id: string | null; claimed: boolean }>(`
        SELECT docker_nodes.allocated_count, containers.node_id,
               jsonb_exists(containers.metadata, 'slotClaimedAt') AS claimed
        FROM containers CROSS JOIN docker_nodes
        WHERE containers.id = '${CAPACITY_ID}' AND docker_nodes.node_id = 'node-full'
      `)
    ).rows;
    expect(state).toEqual({ allocated_count: 1, node_id: null, claimed: false });
  });

  test("running, failure, and deletion transitions preserve ownership and placement", async () => {
    await store.markRunning(SLOT_ID, {
      hostContainerId: "docker-1",
      hostPort: 31000,
      network: "app-network",
      nodeHost: "10.0.0.1",
    });
    await store.markError(SLOT_ID, "health check failed");
    await store.markDeleted(SLOT_ID, ORG_ONE, "node-1");

    expect(statusUpdates).toContainEqual({ id: SLOT_ID, status: "running" });
    expect(statusUpdates).toContainEqual({
      id: SLOT_ID,
      status: "failed",
      error: "health check failed",
    });
    expect(containerUpdates).toHaveLength(1);
    expect(containerUpdates[0]).toMatchObject({
      id: SLOT_ID,
      organizationId: ORG_ONE,
      data: {
        metadata: {
          hostContainerId: "docker-1",
          hostPort: 31000,
          network: "app-network",
          hostname: "10.0.0.1",
        },
      },
    });
    expect(releasedSlots).toEqual([{ id: SLOT_ID, organizationId: ORG_ONE, nodeId: "node-1" }]);
    expect(
      (
        await client.query<{ status: string }>(
          `SELECT status FROM containers WHERE id='${SLOT_ID}'`,
        )
      ).rows,
    ).toEqual([{ status: "deleted" }]);

    await expect(
      store.markRunning("00000000-0000-0000-0000-000000000099", {
        hostContainerId: "missing",
        hostPort: 31001,
        network: "app-network",
      }),
    ).rejects.toMatchObject({ name: "APP_CONTAINER_ROW_MISSING" });
  });
});

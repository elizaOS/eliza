/**
 * Proves the shared Docker host-port authority against real PGlite
 * transactions, including cross-workload races, exact-owner release, and
 * structural range rejection.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../../db/client";
import { dockerHostPortReservations } from "../../db/schemas/docker-host-port-reservations";
import {
  releaseDockerHostPortReservations,
  reserveAppContainerHostPort,
  reserveDockerAgentPorts,
} from "./docker-port-allocation";

const DDL = `
  CREATE TABLE docker_host_port_reservations (
    node_id text NOT NULL,
    host_port integer NOT NULL,
    owner_kind text NOT NULL,
    owner_id text NOT NULL,
    port_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT docker_host_port_reservations_pkey PRIMARY KEY (node_id, host_port),
    CONSTRAINT docker_host_port_reservations_contract_check CHECK (
      length(node_id) > 0
      AND length(owner_id) > 0
      AND (
        (
          owner_kind = 'agent'
          AND (
            (port_kind = 'agent_bridge' AND host_port >= 18790 AND host_port < 19790)
            OR (port_kind = 'agent_web' AND host_port >= 20000 AND host_port < 25000)
          )
        )
        OR (
          owner_kind = 'restore_validation'
          AND (
            (port_kind = 'restore_bridge' AND host_port >= 18790 AND host_port < 19790)
            OR (port_kind = 'restore_web' AND host_port >= 20000 AND host_port < 25000)
          )
        )
        OR (
          owner_kind = 'app'
          AND port_kind = 'app'
          AND host_port >= 20000
          AND host_port < 40000
        )
      )
    )
  );
  CREATE UNIQUE INDEX docker_host_port_reservations_owner_kind_unique
    ON docker_host_port_reservations (node_id, owner_kind, owner_id, port_kind);
`;
const MIGRATION = readFileSync(
  fileURLToPath(
    new URL("../../db/migrations/0186_docker_host_port_reservations.sql", import.meta.url),
  ),
  "utf8",
);
const MIGRATION_PREREQUISITES = `
  CREATE TABLE agent_sandboxes (
    node_id text,
    container_name text,
    bridge_port integer,
    web_ui_port integer,
    status text NOT NULL,
    rollback_standby_state text,
    rollback_standby_node_id text,
    rollback_standby_container_name text,
    rollback_standby_bridge_port integer,
    rollback_standby_web_ui_port integer
  );
  CREATE TABLE agent_snapshot_restore_validations (
    target_provider_allocation_counted boolean NOT NULL,
    target_provider_node_id text,
    target_provider_container_name text,
    target_provider_bridge_port integer,
    target_provider_web_ui_port integer
  );
  CREATE TABLE containers (
    node_id text,
    name text NOT NULL,
    status text NOT NULL,
    metadata jsonb NOT NULL
  );
`;

let client: PGlite;
let database: Database;

async function rows(): Promise<
  Array<{ node_id: string; host_port: number; owner_kind: string; owner_id: string }>
> {
  const result = await database.execute<{
    node_id: string;
    host_port: number;
    owner_kind: string;
    owner_id: string;
  }>(sql`
    SELECT node_id, host_port, owner_kind, owner_id
    FROM docker_host_port_reservations
    ORDER BY node_id, host_port
  `);
  return result.rows;
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(DDL);
  database = drizzle(client, {
    schema: { dockerHostPortReservations },
  }) as unknown as Database;
});

beforeEach(async () => {
  await database.delete(dockerHostPortReservations);
});

afterAll(async () => {
  await client.close();
});

describe("atomic Docker host-port reservations", () => {
  test("ordinary and restore candidates cannot commit the same node ports", async () => {
    const [ordinary, restore] = await Promise.all([
      reserveDockerAgentPorts(
        { nodeId: "node-a", ownerKind: "agent", ownerId: "agent-one" },
        database,
      ),
      reserveDockerAgentPorts(
        {
          nodeId: "node-a",
          ownerKind: "restore_validation",
          ownerId: "restore-one",
        },
        database,
      ),
    ]);

    expect(ordinary.bridgePort).not.toBe(restore.bridgePort);
    expect(ordinary.webUiPort).not.toBe(restore.webUiPort);
    expect(await rows()).toHaveLength(4);
  });

  test("app and restore web ownership cannot commit the same node port", async () => {
    const [appPort, restore] = await Promise.all([
      reserveAppContainerHostPort(
        { nodeId: "node-a", ownerKind: "app", ownerId: "app-one" },
        database,
      ),
      reserveDockerAgentPorts(
        {
          nodeId: "node-a",
          ownerKind: "restore_validation",
          ownerId: "restore-one",
        },
        database,
      ),
    ]);

    expect(appPort).not.toBe(restore.webUiPort);
    expect(await rows()).toHaveLength(3);
  });

  test("app and ordinary agent web ownership cannot commit the same node port", async () => {
    const [appPort, ordinary] = await Promise.all([
      reserveAppContainerHostPort(
        { nodeId: "node-a", ownerKind: "app", ownerId: "app-one" },
        database,
      ),
      reserveDockerAgentPorts(
        { nodeId: "node-a", ownerKind: "agent", ownerId: "agent-one" },
        database,
      ),
    ]);

    expect(appPort).not.toBe(ordinary.webUiPort);
    expect(await rows()).toHaveLength(3);
  });

  test("two restore candidates atomically receive disjoint pairs", async () => {
    const [first, second] = await Promise.all([
      reserveDockerAgentPorts(
        {
          nodeId: "node-a",
          ownerKind: "restore_validation",
          ownerId: "restore-one",
        },
        database,
      ),
      reserveDockerAgentPorts(
        {
          nodeId: "node-a",
          ownerKind: "restore_validation",
          ownerId: "restore-two",
        },
        database,
      ),
    ]);

    expect(first.bridgePort).not.toBe(second.bridgePort);
    expect(first.webUiPort).not.toBe(second.webUiPort);
  });

  test("same-owner retry is idempotent and exact release makes ports reusable", async () => {
    const owner = {
      nodeId: "node-a",
      ownerKind: "restore_validation" as const,
      ownerId: "restore-one",
    };
    const first = await reserveDockerAgentPorts(owner, database);
    expect(await reserveDockerAgentPorts(owner, database)).toEqual(first);
    expect(await releaseDockerHostPortReservations(owner, database)).toBe(2);
    expect(await releaseDockerHostPortReservations(owner, database)).toBe(0);

    const next = await reserveDockerAgentPorts({ ...owner, ownerId: "restore-two" }, database);
    expect(next).toEqual(first);
  });

  test("exact-owner release cannot remove another workload's rows", async () => {
    const ordinaryOwner = {
      nodeId: "node-a",
      ownerKind: "agent" as const,
      ownerId: "agent-one",
    };
    const restoreOwner = {
      nodeId: "node-a",
      ownerKind: "restore_validation" as const,
      ownerId: "restore-one",
    };
    await reserveDockerAgentPorts(ordinaryOwner, database);
    const restore = await reserveDockerAgentPorts(restoreOwner, database);

    expect(await releaseDockerHostPortReservations(ordinaryOwner, database)).toBe(2);
    expect(await rows()).toEqual([
      {
        node_id: "node-a",
        host_port: restore.bridgePort,
        owner_kind: "restore_validation",
        owner_id: "restore-one",
      },
      {
        node_id: "node-a",
        host_port: restore.webUiPort,
        owner_kind: "restore_validation",
        owner_id: "restore-one",
      },
    ]);
  });

  test("database constraints reject kind/range spoofing", async () => {
    await expect(
      database
        .insert(dockerHostPortReservations)
        .values({
          node_id: "node-a",
          host_port: 18790,
          owner_kind: "app",
          owner_id: "app-one",
          port_kind: "app",
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      database
        .insert(dockerHostPortReservations)
        .values({
          node_id: "node-a",
          host_port: 20000,
          owner_kind: "agent",
          owner_id: "agent-one",
          port_kind: "restore_web",
        })
        .execute(),
    ).rejects.toThrow();
  });

  test("migration backfills every live owner and fails closed on a legacy collision", async () => {
    const clean = new PGlite();
    await clean.exec(MIGRATION_PREREQUISITES);
    await clean.exec(`
      INSERT INTO agent_sandboxes
        (node_id, container_name, bridge_port, web_ui_port, status)
        VALUES ('node-a', 'agent-one', 18790, 20000, 'running');
      INSERT INTO agent_sandboxes
        (node_id, container_name, bridge_port, web_ui_port, status)
        VALUES ('node-a', 'agent-delete-failed', 18792, 20002, 'deletion_failed');
      INSERT INTO agent_sandboxes (
        node_id,
        container_name,
        bridge_port,
        web_ui_port,
        status,
        rollback_standby_node_id,
        rollback_standby_container_name,
        rollback_standby_bridge_port,
        rollback_standby_web_ui_port
      ) VALUES (
        'node-blue',
        'agent-blue',
        18793,
        20003,
        'running',
        'node-standby',
        'agent-standby',
        18794,
        20004
      );
      INSERT INTO agent_snapshot_restore_validations
        VALUES (TRUE, 'node-a', 'restore-one', 18791, 20001);
      INSERT INTO containers
        VALUES ('node-a', 'app-one', 'running', '{"hostPort": 25000}');
      INSERT INTO containers
        VALUES ('node-a', 'app-delete-failed', 'failed', '{"hostPort": 25001}');
    `);
    await clean.exec(MIGRATION);
    const cleanRows = await clean.query<{
      owner_kind: string;
      owner_id: string;
      port_kind: string;
    }>(`SELECT owner_kind, owner_id, port_kind FROM docker_host_port_reservations`);
    expect(cleanRows.rows).toHaveLength(12);
    expect(new Set(cleanRows.rows.map((row) => `${row.owner_kind}/${row.port_kind}`))).toEqual(
      new Set([
        "agent/agent_bridge",
        "agent/agent_web",
        "restore_validation/restore_bridge",
        "restore_validation/restore_web",
        "app/app",
      ]),
    );
    expect(new Set(cleanRows.rows.map((row) => row.owner_id))).toEqual(
      new Set([
        "agent-one",
        "agent-delete-failed",
        "agent-blue",
        "agent-standby",
        "restore-one",
        "app-one",
        "app-delete-failed",
      ]),
    );
    await clean.close();

    const collided = new PGlite();
    await collided.exec(MIGRATION_PREREQUISITES);
    await collided.exec(`
      INSERT INTO agent_sandboxes
        (node_id, container_name, bridge_port, web_ui_port, status)
        VALUES ('node-a', 'agent-one', 18790, 20000, 'running');
      INSERT INTO containers
        VALUES ('node-a', 'app-one', 'running', '{"hostPort": 20000}');
    `);
    await expect(collided.exec(MIGRATION)).rejects.toThrow(
      "Docker host-port reservation backfill detected an existing collision",
    );
    await collided.close();

    const unresolvedRollback = new PGlite();
    await unresolvedRollback.exec(MIGRATION_PREREQUISITES);
    await unresolvedRollback.exec(`
      INSERT INTO agent_sandboxes
        (node_id, container_name, bridge_port, web_ui_port, status, rollback_standby_state)
        VALUES (
          'node-standby',
          'agent-standby',
          18790,
          20000,
          'running',
          'rollback_cleanup_pending'
        );
    `);
    await expect(unresolvedRollback.exec(MIGRATION)).rejects.toThrow(
      "cannot classify rollback_cleanup_pending blue ports",
    );
    await unresolvedRollback.close();
  });
});

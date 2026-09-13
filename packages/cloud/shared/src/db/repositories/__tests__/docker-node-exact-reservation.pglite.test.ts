/**
 * Real-PGlite proofs for the exact-occurrence capacity reservation.
 *
 * Ordinary placement selects a node, then performs its remote effect. The
 * accounting step in between used to be a blind increment by the reusable node
 * handle, so a node that was cordoned, replaced, or filled after selection still
 * took the container. This suite drives the compare-and-set that replaced it and
 * asserts each way the node can move out from under a selection.
 *
 * The harness creates only `docker_nodes`; the reservation reads nothing else.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../client";
import { agentNodeIncarnationHistories } from "../../schemas/agent-node-incarnation-histories";
import { dockerNodes } from "../../schemas/docker-nodes";
import { dockerNodesRepository } from "../docker-nodes";

const TIMEOUT = 120_000;

const NODE_RECORD_ID = "20000000-0000-4000-8000-000000000001";
const NODE_HANDLE = "node-alpha";
const INCARNATION = "30000000-0000-4000-8000-000000000001";
const HISTORY_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_INCARNATION = "30000000-0000-4000-8000-000000000002";
const OTHER_HISTORY_ID = "40000000-0000-4000-8000-000000000002";

interface SqlRunner {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string): Promise<{ rows: T[] }>;
}

function database(): SqlRunner {
  return getPgliteClientForTests() as unknown as SqlRunner;
}

async function scalar<T>(source: string): Promise<T | undefined> {
  const result = await database().query<T>(source);
  return result.rows[0];
}

function selection() {
  return {
    nodeRecordId: NODE_RECORD_ID,
    nodeId: NODE_HANDLE,
    nodeIncarnation: INCARNATION as string | null,
    nodeHistoryId: HISTORY_ID as string | null,
  };
}

async function resetNode(): Promise<void> {
  await database().exec("DELETE FROM docker_nodes");
  await database().exec("DELETE FROM agent_node_incarnation_histories");
  // An attested occurrence needs its history row; the node's foreign key binds
  // the pair, which is what makes the occurrence identity exact.
  await database().exec(`
    INSERT INTO agent_node_incarnation_histories (id, docker_node_record_id, node_id,
      node_incarnation, fleet_kind, infrastructure_provider, provider_server_id,
      host_key_fingerprint)
    VALUES ('${HISTORY_ID}', '${NODE_RECORD_ID}', '${NODE_HANDLE}', '${INCARNATION}',
      'cloud', 'hetzner', '1234', 'SHA256:alpha')
  `);
  await database().exec(`
    INSERT INTO docker_nodes (id, node_id, hostname, capacity, allocated_count,
      enabled, placement_state, status, node_incarnation, current_node_history_id,
      fleet_kind, infrastructure_provider, provider_server_id, host_key_fingerprint, metadata)
    VALUES ('${NODE_RECORD_ID}', '${NODE_HANDLE}', 'alpha.example', 4, 0,
      true, 'open', 'healthy', '${INCARNATION}', '${HISTORY_ID}',
      'cloud', 'hetzner', '1234', 'SHA256:alpha', '{}'::jsonb)
  `);
}

let schemaFailure: string | null = null;

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    schemaFailure = "isolated PGlite is required; refusing to mutate an ambient Postgres database";
    return;
  }
  try {
    const { apply } = await pushSchema(
      // docker_nodes carries a foreign key to the occurrence history, so the
      // history table has to exist for the node table to be created.
      { agentNodeIncarnationHistories, dockerNodes },
      drizzlePglite({ client: getPgliteClientForTests() }) as never,
    );
    await apply();
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

beforeEach(async () => {
  if (schemaFailure) return;
  await resetNode();
});

function requireSchema(): void {
  if (schemaFailure) throw new Error(`docker_nodes schema unavailable: ${schemaFailure}`);
}

describe("ordinary placement reserves on the exact occurrence it selected", () => {
  test(
    "a placeable node takes the slot and reports the receipt",
    async () => {
      requireSchema();
      const reservation = await dockerNodesRepository.reserveExactNodeAllocation(selection());
      expect(reservation).toEqual({
        node_record_id: NODE_RECORD_ID,
        node_id: NODE_HANDLE,
        allocated_count: 1,
        capacity: 4,
      });
      const node = await scalar<{ allocated_count: number }>(
        `SELECT allocated_count FROM docker_nodes WHERE id = '${NODE_RECORD_ID}'`,
      );
      expect(node?.allocated_count).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "a node cordoned after selection is refused",
    async () => {
      requireSchema();
      // The failover freeze cordons the node between selection and placement.
      await database().exec(
        `UPDATE docker_nodes SET placement_state = 'cordoned' WHERE id = '${NODE_RECORD_ID}'`,
      );
      expect(await dockerNodesRepository.reserveExactNodeAllocation(selection())).toBeNull();
      const node = await scalar<{ allocated_count: number }>(
        `SELECT allocated_count FROM docker_nodes WHERE id = '${NODE_RECORD_ID}'`,
      );
      expect(node?.allocated_count).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "a rebooted host is refused because the occurrence moved",
    async () => {
      requireSchema();
      await database().exec(`
      INSERT INTO agent_node_incarnation_histories (id, docker_node_record_id, node_id,
        node_incarnation, fleet_kind, infrastructure_provider, provider_server_id,
        host_key_fingerprint)
      VALUES ('${OTHER_HISTORY_ID}', '${NODE_RECORD_ID}', '${NODE_HANDLE}',
        '${OTHER_INCARNATION}', 'cloud', 'hetzner', '1234', 'SHA256:alpha')
    `);
      await database().exec(`
      UPDATE docker_nodes SET node_incarnation = '${OTHER_INCARNATION}',
        current_node_history_id = '${OTHER_HISTORY_ID}'
      WHERE id = '${NODE_RECORD_ID}'
    `);
      expect(await dockerNodesRepository.reserveExactNodeAllocation(selection())).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "an occurrence attested after selection is refused",
    async () => {
      requireSchema();
      // Selection saw an unattested row; an attestation landed before placement.
      await database().exec(
        `UPDATE docker_nodes SET node_incarnation = NULL, current_node_history_id = NULL,
        fleet_kind = NULL, infrastructure_provider = NULL, provider_server_id = NULL,
        host_key_fingerprint = NULL WHERE id = '${NODE_RECORD_ID}'`,
      );
      const unattested = await dockerNodesRepository.reserveExactNodeAllocation({
        ...selection(),
        nodeIncarnation: null,
        nodeHistoryId: null,
      });
      expect(unattested).not.toBeNull();
      await database().exec(`
      UPDATE docker_nodes SET node_incarnation = '${INCARNATION}',
        current_node_history_id = '${HISTORY_ID}', fleet_kind = 'cloud',
        infrastructure_provider = 'hetzner', provider_server_id = '1234',
        host_key_fingerprint = 'SHA256:alpha'
      WHERE id = '${NODE_RECORD_ID}'
    `);
      expect(
        await dockerNodesRepository.reserveExactNodeAllocation({
          ...selection(),
          nodeIncarnation: null,
          nodeHistoryId: null,
        }),
      ).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a full node is refused and the ceiling is never crossed",
    async () => {
      requireSchema();
      await database().exec(
        `UPDATE docker_nodes SET capacity = 1, allocated_count = 1 WHERE id = '${NODE_RECORD_ID}'`,
      );
      expect(await dockerNodesRepository.reserveExactNodeAllocation(selection())).toBeNull();
      const node = await scalar<{ allocated_count: number }>(
        `SELECT allocated_count FROM docker_nodes WHERE id = '${NODE_RECORD_ID}'`,
      );
      expect(node?.allocated_count).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "provisional autoscaler capacity is not schedulable authority",
    async () => {
      requireSchema();
      await database().exec(`
      UPDATE docker_nodes SET metadata = '{"capacityProvisional": true}'::jsonb
      WHERE id = '${NODE_RECORD_ID}'
    `);
      expect(await dockerNodesRepository.reserveExactNodeAllocation(selection())).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "an unhealthy or disabled node is refused",
    async () => {
      requireSchema();
      await database().exec(
        `UPDATE docker_nodes SET status = 'degraded' WHERE id = '${NODE_RECORD_ID}'`,
      );
      expect(await dockerNodesRepository.reserveExactNodeAllocation(selection())).toBeNull();
      await database().exec(
        `UPDATE docker_nodes SET status = 'healthy', enabled = false WHERE id = '${NODE_RECORD_ID}'`,
      );
      expect(await dockerNodesRepository.reserveExactNodeAllocation(selection())).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a replaced node record under the same handle is refused",
    async () => {
      requireSchema();
      // The record was deleted and the logical handle was reused by a new row.
      const replacementRecordId = "20000000-0000-4000-8000-0000000000ff";
      await database().exec(`DELETE FROM docker_nodes WHERE id = '${NODE_RECORD_ID}'`);
      await database().exec(`
      INSERT INTO agent_node_incarnation_histories (id, docker_node_record_id, node_id,
        node_incarnation, fleet_kind, infrastructure_provider, provider_server_id,
        host_key_fingerprint)
      VALUES ('${OTHER_HISTORY_ID}', '${replacementRecordId}', '${NODE_HANDLE}',
        '${OTHER_INCARNATION}', 'cloud', 'hetzner', '1234', 'SHA256:alpha')
    `);
      await database().exec(`
      INSERT INTO docker_nodes (id, node_id, hostname, capacity, allocated_count,
        enabled, placement_state, status, node_incarnation, current_node_history_id,
        fleet_kind, infrastructure_provider, provider_server_id, host_key_fingerprint, metadata)
      VALUES ('${replacementRecordId}', '${NODE_HANDLE}', 'alpha.example', 4, 0,
        true, 'open', 'healthy', '${OTHER_INCARNATION}', '${OTHER_HISTORY_ID}',
        'cloud', 'hetzner', '1234', 'SHA256:alpha', '{}'::jsonb)
    `);
      expect(await dockerNodesRepository.reserveExactNodeAllocation(selection())).toBeNull();
    },
    TIMEOUT,
  );
});

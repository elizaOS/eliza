/** Exercises committed retirement intent and rollback using a real isolated PGlite database. */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.CONTAINERS_HCLOUD_FIREWALL_IDS = "8101";

const EXPECTED_HOST = {
  hostname: "192.0.2.1",
  ssh_port: 22,
  ssh_user: "root",
  host_key_fingerprint: "SHA256:test-host-pin",
  node_incarnation: "00000000-0000-4000-8000-000000000099",
};
const { dbWrite } = await import("../../../db/helpers");
const { closeDatabaseConnectionsForTests } = await import("../../../db/client");
const { requestNodeRetirement, findRequestedNodeRetirements, withNodeRetirementAuthority } =
  await import("./node-retirement-authority");

beforeAll(async () => {
  // This fixture owns only the node persistence boundary; source-history and
  // workload constraints are exercised by their existing schema integration lanes.
  await dbWrite.execute(sql`CREATE TABLE docker_nodes (
    id uuid PRIMARY KEY, node_id text UNIQUE NOT NULL, hostname text NOT NULL,
    ssh_port integer NOT NULL DEFAULT 22, capacity integer NOT NULL DEFAULT 8,
    enabled boolean NOT NULL DEFAULT true, placement_state text NOT NULL DEFAULT 'open',
    status text NOT NULL DEFAULT 'healthy', allocated_count integer NOT NULL DEFAULT 0,
    last_health_check timestamptz, ssh_user text NOT NULL DEFAULT 'root',
    host_key_fingerprint text, fleet_kind text, infrastructure_provider text,
    provider_server_id text, node_incarnation uuid, current_node_history_id uuid,
    backup_admission_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
    metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await dbWrite.execute(sql`CREATE TABLE containers (
    id uuid PRIMARY KEY, organization_id uuid NOT NULL, status text NOT NULL,
    node_id text, metadata jsonb NOT NULL DEFAULT '{}', updated_at timestamptz,
    error_message text
  )`);
});

beforeEach(async () => {
  await dbWrite.execute(sql`DELETE FROM containers`);
  await dbWrite.execute(sql`DELETE FROM docker_nodes`);
  await dbWrite.execute(sql`INSERT INTO docker_nodes
    (id, node_id, hostname, fleet_kind, infrastructure_provider, provider_server_id, metadata, node_incarnation, host_key_fingerprint)
    VALUES ('00000000-0000-4000-8000-000000000001', 'node-1', '192.0.2.1',
      'cloud', 'hetzner', '42', '{"environment":"local","unrelated":"preserved"}',
      '00000000-0000-4000-8000-000000000099', 'SHA256:test-host-pin')`);
});

test("app placement commits its owner with capacity and cannot reserve twice", async () => {
  const { containersRepository } = await import("../../../db/repositories/containers");
  const id = "00000000-0000-4000-8000-000000000010";
  const org = "00000000-0000-4000-8000-000000000020";
  const nodeRecordId = "00000000-0000-4000-8000-000000000001";
  await dbWrite.execute(sql`INSERT INTO containers (id, organization_id, status)
    VALUES (${id}::uuid, ${org}::uuid, 'pending')`);
  await expect(
    containersRepository.reserveCreatePlacement(id, id, "node-1", nodeRecordId, EXPECTED_HOST),
  ).rejects.toThrow("no longer admits placement");
  await requestNodeRetirement("node-1");
  await expect(
    containersRepository.reserveCreatePlacement(id, org, "node-1", nodeRecordId, EXPECTED_HOST),
  ).rejects.toThrow("no longer admits container placement");
  const unchanged = await dbWrite.execute(sql`SELECT status, node_id FROM containers`);
  expect(unchanged.rows).toEqual([{ status: "pending", node_id: null }]);
  await dbWrite.execute(sql`UPDATE docker_nodes SET enabled=true, placement_state='open'`);
  await containersRepository.reserveCreatePlacement(id, org, "node-1", nodeRecordId, EXPECTED_HOST);
  await expect(
    containersRepository.reserveCreatePlacement(id, org, "node-1", nodeRecordId, EXPECTED_HOST),
  ).rejects.toThrow("no longer admits placement");
  const placed = await dbWrite.execute(sql`SELECT c.status, c.node_id, n.allocated_count
    FROM containers c JOIN docker_nodes n ON n.node_id=c.node_id`);
  expect(placed.rows).toEqual([{ status: "building", node_id: "node-1", allocated_count: 1 }]);
});

test("placement rejects a changed host and retains its original pin after admission", async () => {
  const { containersRepository } = await import("../../../db/repositories/containers");
  const id = "00000000-0000-4000-8000-000000000010";
  const org = "00000000-0000-4000-8000-000000000020";
  const nodeRecordId = "00000000-0000-4000-8000-000000000001";
  await dbWrite.execute(sql`INSERT INTO containers (id, organization_id, status)
    VALUES (${id}::uuid, ${org}::uuid, 'pending')`);
  await dbWrite.execute(sql`UPDATE docker_nodes SET hostname='192.0.2.2'`);
  await expect(
    containersRepository.reserveCreatePlacement(id, org, "node-1", nodeRecordId, EXPECTED_HOST),
  ).rejects.toThrow("no longer admits container placement");
  const rejected = await dbWrite.execute(sql`SELECT allocated_count FROM docker_nodes`);
  expect(rejected.rows).toEqual([{ allocated_count: 0 }]);
  await dbWrite.execute(sql`UPDATE docker_nodes SET hostname='192.0.2.1'`);
  await containersRepository.reserveCreatePlacement(id, org, "node-1", nodeRecordId, EXPECTED_HOST);
  await dbWrite.execute(
    sql`UPDATE docker_nodes SET host_key_fingerprint='SHA256:replacement-host'`,
  );
  const original = await dbWrite.execute(sql`SELECT metadata->>'createHostKeyFingerprint' AS pin,
    metadata->>'createNodeIncarnation' AS incarnation FROM containers`);
  expect(original.rows).toEqual([
    { pin: EXPECTED_HOST.host_key_fingerprint, incarnation: EXPECTED_HOST.node_incarnation },
  ]);
});

test("existing app claim retries and rollback keep one capacity owner", async () => {
  const { claimAppContainerNodeSlot, rollbackAppContainerNodeSlotClaim } = await import(
    "../app-container-store-queries"
  );
  const id = "00000000-0000-4000-8000-000000000010";
  const org = "00000000-0000-4000-8000-000000000020";
  await dbWrite.execute(sql`INSERT INTO containers (id, organization_id, status)
    VALUES (${id}::uuid, ${org}::uuid, 'pending')`);
  const claim = () =>
    claimAppContainerNodeSlot(
      dbWrite,
      id,
      org,
      "node-1",
      () => new Error("capacity unavailable"),
      () => new Error("claim conflict"),
    );
  expect(await claim()).toBe("claimed");
  expect(await claim()).toBe("already-claimed");
  const reserved = await dbWrite.execute(sql`SELECT allocated_count FROM docker_nodes`);
  expect(reserved.rows).toEqual([{ allocated_count: 1 }]);
  expect(await rollbackAppContainerNodeSlotClaim(dbWrite, id, org, "node-1")).toBe(true);
  expect(await rollbackAppContainerNodeSlotClaim(dbWrite, id, org, "node-1")).toBe(false);
  const released = await dbWrite.execute(sql`SELECT allocated_count FROM docker_nodes`);
  expect(released.rows).toEqual([{ allocated_count: 0 }]);
});

test("uncertain create cleanup retains capacity; proven removal releases it once", async () => {
  const { containersRepository } = await import("../../../db/repositories/containers");
  const id = "00000000-0000-4000-8000-000000000010";
  const org = "00000000-0000-4000-8000-000000000020";
  const nodeRecordId = "00000000-0000-4000-8000-000000000001";
  await dbWrite.execute(sql`INSERT INTO containers (id, organization_id, status)
    VALUES (${id}::uuid, ${org}::uuid, 'pending')`);
  await containersRepository.reserveCreatePlacement(id, org, "node-1", nodeRecordId, EXPECTED_HOST);
  await containersRepository.settleCreateFailure(id, org, nodeRecordId, "connection lost", false);
  const pending = await dbWrite.execute(sql`SELECT c.status, n.allocated_count
    FROM containers c JOIN docker_nodes n ON n.node_id=c.node_id`);
  expect(pending.rows).toEqual([{ status: "cleanup_required", allocated_count: 1 }]);
  await containersRepository.settleCreateFailure(id, org, nodeRecordId, "create failed", true);
  await containersRepository.settleCreateFailure(id, org, nodeRecordId, "create failed", true);
  const released = await dbWrite.execute(sql`SELECT c.status, n.allocated_count
    FROM containers c JOIN docker_nodes n ON n.node_id=c.node_id`);
  expect(released.rows).toEqual([{ status: "failed", allocated_count: 0 }]);
});

test("cleanup cannot decrement a slot already released by another lifecycle owner", async () => {
  const { containersRepository } = await import("../../../db/repositories/containers");
  const id = "00000000-0000-4000-8000-000000000010";
  const org = "00000000-0000-4000-8000-000000000020";
  const nodeRecordId = "00000000-0000-4000-8000-000000000001";
  await dbWrite.execute(sql`INSERT INTO containers (id, organization_id, status)
    VALUES (${id}::uuid, ${org}::uuid, 'pending')`);
  await containersRepository.reserveCreatePlacement(id, org, "node-1", nodeRecordId, EXPECTED_HOST);
  await dbWrite.execute(
    sql`UPDATE containers SET metadata=metadata || '{"slotReleasedAt":"2026-09-05T00:00:00Z"}'::jsonb`,
  );
  await expect(
    containersRepository.settleCreateFailure(id, org, nodeRecordId, "late cleanup", true),
  ).rejects.toThrow("placement changed");
  const remaining = await dbWrite.execute(sql`SELECT allocated_count FROM docker_nodes`);
  expect(remaining.rows).toEqual([{ allocated_count: 1 }]);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("provider failure rolls back deletion but preserves the separately committed request", async () => {
  await requestNodeRetirement("node-1");
  await expect(
    withNodeRetirementAuthority("node-1", async () => {
      throw new Error("provider unavailable");
    }),
  ).rejects.toThrow("provider unavailable");
  const pending = await findRequestedNodeRetirements();
  expect(pending.map((node) => node.node_id)).toEqual(["node-1"]);
  expect(pending[0].metadata.unrelated).toBe("preserved");
  expect(pending[0].placement_state).toBe("cordoned");
  expect(await withNodeRetirementAuthority("node-1", async () => false)).toBe(false);
  expect(await findRequestedNodeRetirements()).toHaveLength(1);
  expect(await withNodeRetirementAuthority("node-1", async () => true)).toBe(true);
  expect(await findRequestedNodeRetirements()).toHaveLength(0);
  expect(
    await withNodeRetirementAuthority("node-1", async () => {
      throw new Error("already deleted node must not call provider");
    }),
  ).toBe(true);
});

test("manual disablement and foreign environment never grant retirement authority", async () => {
  await dbWrite.execute(sql`UPDATE docker_nodes SET enabled=false`);
  expect(await findRequestedNodeRetirements()).toHaveLength(0);
  await expect(withNodeRetirementAuthority("node-1", async () => true)).rejects.toThrow(
    "no matching retirement request",
  );
  await dbWrite.execute(sql`UPDATE docker_nodes SET metadata='{"environment":"production"}'`);
  await expect(requestNodeRetirement("node-1")).rejects.toThrow("active environment");
  expect(await findRequestedNodeRetirements()).toHaveLength(0);
});

test("metadata refresh preserves intent; re-enabling cancels it permanently", async () => {
  const { dockerNodesRepository } = await import("../../../db/repositories/docker-nodes");
  const id = "00000000-0000-4000-8000-000000000001";
  await requestNodeRetirement("node-1");
  await dockerNodesRepository.update(id, { metadata: { environment: "local", refreshed: true } });
  const [pending] = await findRequestedNodeRetirements();
  expect(pending.metadata.refreshed).toBe(true);
  expect(pending.metadata.requestedProviderRetirement).toBe("42");
  await dockerNodesRepository.update(id, { enabled: true, metadata: pending.metadata });
  await dockerNodesRepository.update(id, { enabled: false });
  expect(await findRequestedNodeRetirements()).toHaveLength(0);
  await expect(withNodeRetirementAuthority("node-1", async () => true)).rejects.toThrow(
    "no matching retirement request",
  );
});

test("a selection made before retirement cannot reserve capacity after the cordon", async () => {
  const { dockerNodesRepository } = await import("../../../db/repositories/docker-nodes");
  const id = "00000000-0000-4000-8000-000000000001";
  await requestNodeRetirement("node-1");
  await expect(dockerNodesRepository.incrementAllocated("node-1", id)).rejects.toThrow(
    "no longer admits placement",
  );
  await dockerNodesRepository.update(id, { enabled: true });
  await expect(dockerNodesRepository.incrementAllocated("node-1", id)).rejects.toThrow(
    "no longer admits placement",
  );
  await dockerNodesRepository.update(id, { placement_state: "open", capacity: 1 });
  await dockerNodesRepository.incrementAllocated("node-1", id);
  await expect(dockerNodesRepository.incrementAllocated("node-1", id)).rejects.toThrow(
    "no longer admits placement",
  );
  expect((await dockerNodesRepository.findByIdOnPrimary(id))?.allocated_count).toBe(1);
});

test("reusing a logical node name cannot admit a stale selection onto its replacement", async () => {
  const { dockerNodesRepository } = await import("../../../db/repositories/docker-nodes");
  const previousId = "00000000-0000-4000-8000-000000000001";
  const replacementId = "00000000-0000-4000-8000-000000000002";
  await dbWrite.execute(sql`UPDATE docker_nodes SET id=${replacementId}::uuid`);
  await expect(dockerNodesRepository.incrementAllocated("node-1", previousId)).rejects.toThrow(
    "no longer admits placement",
  );
  expect((await dockerNodesRepository.findByIdOnPrimary(replacementId))?.allocated_count).toBe(0);
  await dockerNodesRepository.incrementAllocated("node-1", replacementId);
  expect((await dockerNodesRepository.findByIdOnPrimary(replacementId))?.allocated_count).toBe(1);
});

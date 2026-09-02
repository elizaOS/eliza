/** Pins the primary recount call even when the operational replica looks equal. */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const countAllocated = mock();
const setAllocatedCount = mock();

const node = {
  id: "10000000-0000-4000-8000-000000000001",
  node_id: "replica-equality-node",
  hostname: "replica-equality-node.test.invalid",
  ssh_port: 22,
  capacity: 4,
  enabled: true,
  status: "healthy",
  allocated_count: 1,
  last_health_check: null,
  ssh_user: "root",
  host_key_fingerprint: "SHA256:test",
  fleet_kind: "robot",
  infrastructure_provider: "hetzner",
  provider_server_id: null,
  node_incarnation: "20000000-0000-4000-8000-000000000001",
  current_node_history_id: "30000000-0000-4000-8000-000000000001",
  placement_state: "open",
  metadata: {},
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
} satisfies DockerNode;

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findEnabled: () => Promise.resolve([node]),
    setAllocatedCount,
  },
}));

mock.module("./docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: countAllocated,
}));

afterAll(() => {
  mock.module("../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("./docker-node-workloads", () => realDockerNodeWorkloads);
});

import { DockerNodeManager } from "./docker-node-manager";

describe("DockerNodeManager primary capacity recount", () => {
  beforeEach(() => {
    countAllocated.mockReset();
    setAllocatedCount.mockReset();
    setAllocatedCount.mockResolvedValue({ before: 1, after: 1 });
  });

  test("performs exactly one transaction-locked primary recount", async () => {
    const changes = await DockerNodeManager.getInstance().syncAllocatedCounts();

    expect(countAllocated).not.toHaveBeenCalled();
    expect(setAllocatedCount).toHaveBeenCalledTimes(1);
    expect(setAllocatedCount).toHaveBeenCalledWith(node.node_id);
    expect(changes.size).toBe(0);
  });

  test("reports only the transaction-locked primary recount result", async () => {
    // The replica-derived node says 1, but the primary recount authoritatively
    // repairs 7 -> 2. The result must not be reconstructed from the replica.
    setAllocatedCount.mockResolvedValue({ before: 7, after: 2 });

    const changes = await DockerNodeManager.getInstance().syncAllocatedCounts();

    expect(changes.get(node.node_id)).toEqual({ before: 7, after: 2 });
  });

  test("does not report stale replica drift when the primary recount is unchanged", async () => {
    setAllocatedCount.mockResolvedValue({ before: 4, after: 4 });

    const changes = await DockerNodeManager.getInstance().syncAllocatedCounts();

    expect(setAllocatedCount).toHaveBeenCalledWith(node.node_id);
    expect(changes.size).toBe(0);
  });
});

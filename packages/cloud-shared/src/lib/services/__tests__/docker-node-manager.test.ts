import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DockerNode } from "../../../db/repositories/docker-nodes";

import * as realDockerNodesNs from "../../../db/repositories/docker-nodes";
import * as realDockerNodeWorkloadsNs from "../docker-node-workloads";
import * as realDockerSshNs from "../docker-ssh";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };

const mocks = {
  findEnabled: mock(),
  updateStatus: mock(),
  countAllocated: mock(),
  getClient: mock(),
  connect: mock(),
  exec: mock(),
};

mock.module("../../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findEnabled: mocks.findEnabled,
    updateStatus: mocks.updateStatus,
  },
}));

mock.module("../docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: mocks.countAllocated,
}));

mock.module("../docker-ssh", () => ({
  DockerSSHClient: {
    getClient: mocks.getClient,
  },
}));

afterAll(() => {
  mock.module("../../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("../docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("../docker-ssh", () => realDockerSsh);
});

const { dockerNodeManager, isDeprecatedDockerNode } = await import("../docker-node-manager");

function node(overrides: Partial<DockerNode>): DockerNode {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    node_id: "eliza-core-1",
    hostname: "203.0.113.10",
    ssh_port: 22,
    capacity: 8,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    last_health_check: null,
    ssh_user: "root",
    host_key_fingerprint: null,
    metadata: {},
    created_at: new Date("2026-06-06T00:00:00Z"),
    updated_at: new Date("2026-06-06T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.findEnabled.mockReset();
  mocks.updateStatus.mockReset();
  mocks.countAllocated.mockReset();
  mocks.getClient.mockReset();
  mocks.connect.mockReset();
  mocks.exec.mockReset();

  mocks.getClient.mockReturnValue({
    connect: mocks.connect,
    exec: mocks.exec,
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.exec.mockResolvedValue("docker-id|x86_64");
  mocks.updateStatus.mockResolvedValue(undefined);
});

describe("dockerNodeManager.getAvailableNode", () => {
  test("skips deprecated and non-healthy nodes before probing capacity", async () => {
    mocks.findEnabled.mockResolvedValue([
      node({
        node_id: "milady-core-1",
        hostname: "88.99.66.168",
        capacity: 24,
        status: "healthy",
      }),
      node({
        node_id: "eliza-core-stale",
        hostname: "203.0.113.11",
        capacity: 100,
        status: "unknown",
      }),
      node({
        node_id: "eliza-core-1",
        hostname: "49.12.2.171",
        capacity: 8,
        status: "healthy",
      }),
    ]);
    mocks.countAllocated.mockResolvedValue(2);

    const selected = await dockerNodeManager.getAvailableNode();

    expect(selected?.node_id).toBe("eliza-core-1");
    expect(mocks.countAllocated).toHaveBeenCalledTimes(1);
    expect(mocks.countAllocated.mock.calls[0]?.[0]).toBe("eliza-core-1");
    expect(mocks.getClient).toHaveBeenCalledTimes(1);
  });
});

describe("isDeprecatedDockerNode", () => {
  test("classifies legacy milady cores as deprecated", () => {
    expect(isDeprecatedDockerNode({ node_id: "milady-core-1" })).toBe(true);
    expect(isDeprecatedDockerNode({ node_id: "eliza-core-1" })).toBe(false);
  });
});

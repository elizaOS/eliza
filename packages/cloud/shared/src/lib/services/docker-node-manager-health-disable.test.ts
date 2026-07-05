/**
 * Health-check auto-disable tests.
 *
 * A node that keeps failing its reachability probe must NOT keep reporting
 * healthy (the outage this fixes: the old "suppress offline for canonical node"
 * mask left dead nodes in rotation). These tests drive the REAL
 * `healthCheckNode` with a stubbed SSH client + repository and assert:
 *   1. below the threshold, the node is marked `offline` but stays enabled;
 *   2. at the threshold, the node is auto-disabled (enabled=false) via
 *      `markOfflineAndDisable`, and never returns `healthy`;
 *   3. a successful check clears the accumulated failure count.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";
import * as realDockerSshNs from "./docker-ssh";
import * as realNodeDiskNs from "./node-disk-manager";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };
const realNodeDisk = { ...realNodeDiskNs };

const repoCalls = {
  updateStatus: [] as Array<{ nodeId: string; status: string }>,
  markOfflineAndDisable: [] as string[],
  setHostKeyFingerprint: [] as Array<{ nodeId: string; fingerprint: string }>,
};

const sshMock = {
  connect: mock(),
  exec: mock(),
};

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    updateStatus: (nodeId: string, status: string) => {
      repoCalls.updateStatus.push({ nodeId, status });
      return Promise.resolve();
    },
    markOfflineAndDisable: (nodeId: string) => {
      repoCalls.markOfflineAndDisable.push(nodeId);
      return Promise.resolve();
    },
    setHostKeyFingerprint: (nodeId: string, fingerprint: string) => {
      repoCalls.setHostKeyFingerprint.push({ nodeId, fingerprint });
      return Promise.resolve();
    },
  },
}));

mock.module("./docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: () => Promise.resolve(0),
}));

mock.module("./docker-ssh", () => ({
  DockerSSHClient: {
    getClient: () => sshMock,
  },
}));

mock.module("./node-disk-manager", () => ({
  ...realNodeDisk,
  probeNodeDiskUsage: () => Promise.resolve(null),
}));

afterAll(() => {
  mock.module("../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("./docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./docker-ssh", () => realDockerSsh);
  mock.module("./node-disk-manager", () => realNodeDisk);
});

import { __resetNodeHealthFailureStateForTests, DockerNodeManager } from "./docker-node-manager";

function node(nodeId: string): DockerNode {
  return {
    id: `${nodeId}-uuid`,
    node_id: nodeId,
    hostname: `${nodeId}.example.test`,
    ssh_port: 22,
    capacity: 4,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    last_health_check: null,
    ssh_user: "root",
    // Canonical (operator-managed) node: no autoscaler metadata. This is exactly
    // the class the old code refused to ever mark offline.
    host_key_fingerprint: "SHA256:test",
    metadata: {},
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

// The threshold is read once at module load from the env; the default is 3.
const THRESHOLD = 3;

// `healthCheckNode` sleeps RETRY_DELAY_MS between its internal retries via
// setTimeout. Collapse those sleeps so a multi-cycle failure test runs fast
// (the delays are real production behavior, not under test here).
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});
afterAll(() => {
  globalThis.setTimeout = realSetTimeout;
});

beforeEach(() => {
  __resetNodeHealthFailureStateForTests();
  repoCalls.updateStatus = [];
  repoCalls.markOfflineAndDisable = [];
  repoCalls.setHostKeyFingerprint = [];
  sshMock.connect.mockReset();
  sshMock.exec.mockReset();
});

describe("healthCheckNode auto-disable on repeated failure", () => {
  test("marks offline but stays enabled below the threshold, then auto-disables at it", async () => {
    const manager = DockerNodeManager.getInstance();
    const target = node("dead-canonical-node");
    // Every SSH attempt fails to connect → unreachable → offline verdict.
    sshMock.connect.mockRejectedValue(new Error("connect ECONNREFUSED"));

    // Below threshold: offline, but NOT disabled, and never healthy.
    for (let i = 1; i < THRESHOLD; i++) {
      const status = await manager.healthCheckNode(target);
      expect(status).toBe("offline");
      expect(repoCalls.markOfflineAndDisable).toHaveLength(0);
    }
    // The below-threshold cycles persisted plain offline updates.
    expect(repoCalls.updateStatus.every((c) => c.status === "offline")).toBe(true);
    expect(repoCalls.updateStatus.some((c) => c.status === "healthy")).toBe(false);

    // At the threshold: auto-disabled.
    const finalStatus = await manager.healthCheckNode(target);
    expect(finalStatus).toBe("offline");
    expect(repoCalls.markOfflineAndDisable).toEqual(["dead-canonical-node"]);
    // A dead node is NEVER reported healthy.
    expect(repoCalls.updateStatus.some((c) => c.status === "healthy")).toBe(false);
  });

  test("a successful check clears the accumulated failure count", async () => {
    const manager = DockerNodeManager.getInstance();
    const target = node("flapping-node");

    // Two failures (below threshold of 3).
    sshMock.connect.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await manager.healthCheckNode(target);
    await manager.healthCheckNode(target);
    expect(repoCalls.markOfflineAndDisable).toHaveLength(0);

    // Then it recovers: connect ok + docker info returns an ID.
    sshMock.connect.mockReset();
    sshMock.connect.mockResolvedValue(undefined);
    sshMock.exec.mockResolvedValue("DOCKER-ID-123");
    const ok = await manager.healthCheckNode(target);
    expect(ok).toBe("healthy");

    // The counter reset, so it takes a fresh full run of failures to disable.
    sshMock.connect.mockReset();
    sshMock.exec.mockReset();
    sshMock.connect.mockRejectedValue(new Error("connect ECONNREFUSED"));
    for (let i = 1; i < THRESHOLD; i++) {
      await manager.healthCheckNode(target);
      expect(repoCalls.markOfflineAndDisable).toHaveLength(0);
    }
    await manager.healthCheckNode(target);
    expect(repoCalls.markOfflineAndDisable).toEqual(["flapping-node"]);
  });
});

/**
 * Embedding-sidecar health surfacing + self-heal tests.
 *
 * A node without its local-embedding sidecar must never be silent about it —
 * that silence is how the fleet's hand-installed sidecars vanished while
 * agents fell back to the cloud embedding path. These tests drive the REAL
 * `healthCheckNode` / `getCapacityReport` with a stubbed SSH client +
 * repository and assert:
 *   1. a missing sidecar is self-healed via the ensure command and the
 *      recovered verdict is persisted;
 *   2. self-heal attempts are cooldown-gated (no image re-pull every cycle)
 *      and a still-broken sidecar persists as missing;
 *   3. the env kill-switch disables self-heal but NOT the surfacing;
 *   4. the sidecar verdict never owns the node's reachability status;
 *   5. the capacity report exposes the persisted verdict per node.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
  setEmbeddingSidecarHealth: [] as Array<{ nodeId: string; status: string }>,
};

let findAllNodes: DockerNode[] = [];

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
    setEmbeddingSidecarHealth: (nodeId: string, status: string) => {
      repoCalls.setEmbeddingSidecarHealth.push({ nodeId, status });
      return Promise.resolve();
    },
    markOfflineAndDisable: () => Promise.resolve(),
    setHostKeyFingerprint: () => Promise.resolve(),
    findAll: () => Promise.resolve(findAllNodes),
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

import {
  __resetEmbeddingSidecarSelfHealStateForTests,
  __resetNodeHealthFailureStateForTests,
  DockerNodeManager,
} from "./docker-node-manager";

function node(nodeId: string, metadata: Record<string, unknown> = {}): DockerNode {
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
    host_key_fingerprint: "SHA256:test",
    metadata,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

/**
 * Dispatching exec stub: docker-info answers healthy, sidecar probes consume
 * `probeResults` in order, and ensure invocations are recorded. Everything the
 * real healthCheckNode execs is distinguishable by command content.
 */
function wireExec(probeResults: string[]): { ensures: string[] } {
  const state = { ensures: [] as string[], probeIndex: 0 };
  sshMock.connect.mockResolvedValue(undefined);
  sshMock.exec.mockImplementation((command: string) => {
    if (command.includes("docker info")) return Promise.resolve("DOCKER-ID-123");
    if (command.includes("echo missing")) {
      const result = probeResults[Math.min(state.probeIndex, probeResults.length - 1)];
      state.probeIndex += 1;
      return Promise.resolve(result ?? "missing");
    }
    if (command.includes("docker run -d")) {
      state.ensures.push(command);
      return Promise.resolve("");
    }
    return Promise.resolve("");
  });
  return state;
}

beforeEach(() => {
  __resetNodeHealthFailureStateForTests();
  __resetEmbeddingSidecarSelfHealStateForTests();
  repoCalls.updateStatus = [];
  repoCalls.setEmbeddingSidecarHealth = [];
  findAllNodes = [];
  sshMock.connect.mockReset();
  sshMock.exec.mockReset();
});

afterEach(() => {
  delete process.env.CONTAINERS_EMBEDDING_SIDECAR_SELF_HEAL;
});

describe("healthCheckNode embedding-sidecar surfacing", () => {
  test("missing sidecar is self-healed and the recovered verdict is persisted", async () => {
    const manager = DockerNodeManager.getInstance();
    const state = wireExec(["missing", "running"]);

    const status = await manager.healthCheckNode(node("node-a"));

    expect(status).toBe("healthy");
    expect(state.ensures).toHaveLength(1);
    expect(state.ensures[0]).toContain("eliza-embedding-sidecar");
    expect(repoCalls.setEmbeddingSidecarHealth).toEqual([{ nodeId: "node-a", status: "running" }]);
  });

  test("self-heal is cooldown-gated and a still-broken sidecar persists as missing", async () => {
    const manager = DockerNodeManager.getInstance();
    const state = wireExec(["missing", "missing", "missing", "missing"]);

    await manager.healthCheckNode(node("node-b"));
    await manager.healthCheckNode(node("node-b"));

    // One ensure attempt across both cycles: the second is inside the cooldown.
    expect(state.ensures).toHaveLength(1);
    expect(repoCalls.setEmbeddingSidecarHealth).toEqual([
      { nodeId: "node-b", status: "missing" },
      { nodeId: "node-b", status: "missing" },
    ]);
  });

  test("kill-switch disables self-heal but absence is still persisted", async () => {
    process.env.CONTAINERS_EMBEDDING_SIDECAR_SELF_HEAL = "false";
    const manager = DockerNodeManager.getInstance();
    const state = wireExec(["missing"]);

    const status = await manager.healthCheckNode(node("node-c"));

    expect(status).toBe("healthy");
    expect(state.ensures).toHaveLength(0);
    expect(repoCalls.setEmbeddingSidecarHealth).toEqual([{ nodeId: "node-c", status: "missing" }]);
  });

  test("running sidecar persists as running without any ensure attempt", async () => {
    const manager = DockerNodeManager.getInstance();
    const state = wireExec(["running"]);

    await manager.healthCheckNode(node("node-d"));

    expect(state.ensures).toHaveLength(0);
    expect(repoCalls.setEmbeddingSidecarHealth).toEqual([{ nodeId: "node-d", status: "running" }]);
  });

  test("an unusable probe never fabricates a verdict and never owns node status", async () => {
    const manager = DockerNodeManager.getInstance();
    wireExec(["total garbage"]);

    const status = await manager.healthCheckNode(node("node-e"));

    expect(status).toBe("healthy");
    expect(repoCalls.setEmbeddingSidecarHealth).toHaveLength(0);
    expect(repoCalls.updateStatus).toContainEqual({ nodeId: "node-e", status: "healthy" });
  });
});

describe("getCapacityReport embedding-sidecar field", () => {
  test("exposes the persisted verdict per node and unknown for unprobed rows", async () => {
    const manager = DockerNodeManager.getInstance();
    findAllNodes = [
      node("probed-missing", {
        embeddingSidecar: { status: "missing", checkedAt: "2026-08-05T00:00:00.000Z" },
      }),
      node("probed-running", {
        embeddingSidecar: { status: "running", checkedAt: "2026-08-05T00:00:00.000Z" },
      }),
      node("never-probed"),
    ];

    const report = await manager.getCapacityReport();
    const byId = new Map(report.nodes.map((entry) => [entry.nodeId, entry.embeddingSidecar]));

    expect(byId.get("probed-missing")).toBe("missing");
    expect(byId.get("probed-running")).toBe("running");
    expect(byId.get("never-probed")).toBe("unknown");
  });
});

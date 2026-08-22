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

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import type { ComputeProvider } from "./containers/compute-provider";
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
  rotateNodeHostKeyFingerprint: [] as Array<Record<string, unknown>>,
  attestNodeIncarnation: [] as Array<Record<string, unknown>>,
  invalidateNodeIncarnation: [] as Array<Record<string, unknown>>,
};
let invalidateNodeIncarnationError: Error | null = null;

const sshMock = {
  connect: mock(),
  exec: mock(),
  getVerifiedHostKeyFingerprint: mock(),
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
    rotateNodeHostKeyFingerprint: (input: Record<string, unknown>) => {
      repoCalls.rotateNodeHostKeyFingerprint.push(input);
      return Promise.resolve({ host_key_fingerprint: input.observedFingerprint });
    },
    setEmbeddingSidecarHealth: () => Promise.resolve(),
    attestNodeIncarnation: (input: Record<string, unknown>) => {
      repoCalls.attestNodeIncarnation.push(input);
      return Promise.resolve({});
    },
    invalidateNodeIncarnation: (input: Record<string, unknown>) => {
      repoCalls.invalidateNodeIncarnation.push(input);
      return invalidateNodeIncarnationError
        ? Promise.reject(invalidateNodeIncarnationError)
        : Promise.resolve({});
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

let originalFirewallIds: string | undefined;
let originalEnvironment: string | undefined;

function managerWithProviderAuthority(target: DockerNode): DockerNodeManager {
  const serverId = Number(target.provider_server_id);
  const provider = {
    getServer: async () => ({
      id: serverId,
      name: target.node_id,
      status: "running" as const,
      labels: {
        "managed-by": "eliza-cloud",
        "node-id": target.node_id,
        environment: "test",
        tier: "data-plane",
      },
      firewallAttachments: [{ id: 8101, status: "applied" as const }],
    }),
  } as unknown as ComputeProvider;
  return new DockerNodeManager(provider);
}

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
    fleet_kind: null,
    infrastructure_provider: null,
    provider_server_id: null,
    node_incarnation: null,
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
  originalFirewallIds = process.env.CONTAINERS_HCLOUD_FIREWALL_IDS;
  originalEnvironment = process.env.ENVIRONMENT;
  process.env.CONTAINERS_HCLOUD_FIREWALL_IDS = "8101";
  process.env.ENVIRONMENT = "test";
  __resetNodeHealthFailureStateForTests();
  repoCalls.updateStatus = [];
  repoCalls.markOfflineAndDisable = [];
  repoCalls.rotateNodeHostKeyFingerprint = [];
  repoCalls.attestNodeIncarnation = [];
  repoCalls.invalidateNodeIncarnation = [];
  invalidateNodeIncarnationError = null;
  sshMock.connect.mockReset();
  sshMock.exec.mockReset();
  sshMock.getVerifiedHostKeyFingerprint.mockReset();
});

afterEach(() => {
  if (originalFirewallIds === undefined) delete process.env.CONTAINERS_HCLOUD_FIREWALL_IDS;
  else process.env.CONTAINERS_HCLOUD_FIREWALL_IDS = originalFirewallIds;
  if (originalEnvironment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = originalEnvironment;
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

  test("attests a typed node boot and invalidates malformed observations without hiding health", async () => {
    const target = {
      ...node("typed-cloud-node"),
      id: "00000000-0000-4000-8000-000000000201",
      fleet_kind: "cloud" as const,
      infrastructure_provider: "hetzner" as const,
      provider_server_id: "4242",
      node_incarnation: "00000000-0000-4000-8000-000000000211",
      metadata: { environment: "test" },
    };
    const manager = managerWithProviderAuthority(target);
    const observed = "00000000-0000-4000-8000-000000000212";
    sshMock.connect.mockResolvedValue(undefined);
    sshMock.exec.mockImplementation((command: string) => {
      if (command === "cat /proc/sys/kernel/random/boot_id") return Promise.resolve(observed);
      if (command.includes("embedding")) return Promise.resolve("running");
      return Promise.resolve("DOCKER-ID-123");
    });

    await expect(manager.healthCheckNode(target)).resolves.toBe("healthy");
    expect(repoCalls.attestNodeIncarnation).toEqual([
      {
        id: target.id,
        nodeId: target.node_id,
        expectedIncarnation: target.node_incarnation,
        expectedHostKeyFingerprint: target.host_key_fingerprint,
        observedIncarnation: observed,
      },
    ]);
    expect(repoCalls.invalidateNodeIncarnation).toHaveLength(0);

    repoCalls.attestNodeIncarnation = [];
    sshMock.exec.mockImplementation((command: string) => {
      if (command === "cat /proc/sys/kernel/random/boot_id") {
        return Promise.resolve("not-a-boot-id");
      }
      if (command.includes("embedding")) return Promise.resolve("running");
      return Promise.resolve("DOCKER-ID-123");
    });
    await expect(manager.healthCheckNode(target)).resolves.toBe("healthy");
    expect(repoCalls.attestNodeIncarnation).toHaveLength(0);
    expect(repoCalls.invalidateNodeIncarnation).toEqual([
      {
        id: target.id,
        nodeId: target.node_id,
        expectedIncarnation: target.node_incarnation,
        expectedHostKeyFingerprint: target.host_key_fingerprint,
      },
    ]);
  });

  test("pins a first Cloud host key before publishing its initial boot authority", async () => {
    const target = {
      ...node("new-cloud-node"),
      id: "00000000-0000-4000-8000-000000000221",
      host_key_fingerprint: null,
      fleet_kind: "cloud" as const,
      infrastructure_provider: "hetzner" as const,
      provider_server_id: "4343",
      node_incarnation: null,
      metadata: { environment: "test" },
    };
    const manager = managerWithProviderAuthority(target);
    const observed = "00000000-0000-4000-8000-000000000222";
    sshMock.connect.mockResolvedValue(undefined);
    sshMock.getVerifiedHostKeyFingerprint.mockReturnValue("first-cloud-pin");
    sshMock.exec.mockImplementation((command: string) => {
      if (command === "cat /proc/sys/kernel/random/boot_id") return Promise.resolve(observed);
      if (command.includes("embedding")) return Promise.resolve("running");
      return Promise.resolve("DOCKER-ID-123");
    });

    await expect(manager.healthCheckNode(target)).resolves.toBe("healthy");
    expect(repoCalls.rotateNodeHostKeyFingerprint).toEqual([
      {
        id: target.id,
        nodeId: target.node_id,
        expectedFingerprint: null,
        observedFingerprint: "first-cloud-pin",
      },
    ]);
    expect(repoCalls.attestNodeIncarnation).toEqual([
      {
        id: target.id,
        nodeId: target.node_id,
        expectedIncarnation: null,
        expectedHostKeyFingerprint: "first-cloud-pin",
        observedIncarnation: observed,
      },
    ]);
  });

  test("never reports healthy when stale boot authority cannot be revoked", async () => {
    const target = {
      ...node("revocation-failure-node"),
      id: "00000000-0000-4000-8000-000000000231",
      fleet_kind: "cloud" as const,
      infrastructure_provider: "hetzner" as const,
      provider_server_id: "4444",
      node_incarnation: "00000000-0000-4000-8000-000000000232",
      metadata: { environment: "test" },
    };
    const manager = managerWithProviderAuthority(target);
    invalidateNodeIncarnationError = new Error("primary write unavailable");
    sshMock.connect.mockResolvedValue(undefined);
    sshMock.exec.mockImplementation((command: string) => {
      if (command === "cat /proc/sys/kernel/random/boot_id") {
        return Promise.resolve("malformed-boot-id");
      }
      return Promise.resolve("DOCKER-ID-123");
    });

    await expect(manager.healthCheckNode(target)).resolves.toBe("offline");
    expect(repoCalls.invalidateNodeIncarnation).toHaveLength(3);
    expect(repoCalls.updateStatus).toContainEqual({
      nodeId: target.node_id,
      status: "offline",
    });
    expect(repoCalls.updateStatus).not.toContainEqual({
      nodeId: target.node_id,
      status: "healthy",
    });
  });

  test("revokes a typed boot when SSH fails before Docker or Docker returns no identity", async () => {
    const target = {
      ...node("unverifiable-source-node"),
      id: "00000000-0000-4000-8000-000000000241",
      fleet_kind: "cloud" as const,
      infrastructure_provider: "hetzner" as const,
      provider_server_id: "4545",
      node_incarnation: "00000000-0000-4000-8000-000000000242",
      metadata: { environment: "test" },
    };
    const manager = managerWithProviderAuthority(target);
    const expectedRevocation = {
      id: target.id,
      nodeId: target.node_id,
      expectedIncarnation: target.node_incarnation,
      expectedHostKeyFingerprint: target.host_key_fingerprint,
    };

    sshMock.connect.mockRejectedValue(new Error("host key mismatch"));
    await expect(manager.healthCheckNode(target)).resolves.toBe("offline");
    expect(repoCalls.invalidateNodeIncarnation).toEqual([
      expectedRevocation,
      expectedRevocation,
      expectedRevocation,
    ]);

    repoCalls.invalidateNodeIncarnation = [];
    sshMock.connect.mockResolvedValue(undefined);
    sshMock.exec.mockResolvedValue("");
    await expect(manager.healthCheckNode(target)).resolves.toBe("degraded");
    expect(repoCalls.invalidateNodeIncarnation).toEqual([
      expectedRevocation,
      expectedRevocation,
      expectedRevocation,
    ]);
  });
});

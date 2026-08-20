/** Proves node readiness cannot promote typed Cloud capacity before live Hetzner authority. */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import type { ComputeProvider, ComputeServer } from "./containers/compute-provider";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";
import * as realDockerSshNs from "./docker-ssh";
import * as realNodeDiskNs from "./node-disk-manager";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };
const realNodeDisk = { ...realNodeDiskNs };

const events: string[] = [];
const updateStatus = mock(async (_nodeId: string, status: string) => {
  events.push(`status:${status}`);
});
const invalidateNodeIncarnation = mock(async () => ({}));
const sshConnect = mock(async () => {
  events.push("ssh:connect");
});
const sshExec = mock(async (command: string) => {
  if (command === "cat /proc/sys/kernel/random/boot_id") {
    return "00000000-0000-4000-8000-000000000099";
  }
  return "DOCKER-ID-123|x86_64";
});

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    updateStatus,
    invalidateNodeIncarnation,
    attestNodeIncarnation: async () => ({}),
    setEmbeddingSidecarHealth: async () => undefined,
  },
}));

mock.module("./docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: async () => 0,
}));

mock.module("./docker-ssh", () => ({
  DockerSSHClient: {
    getClient: () => ({
      connect: sshConnect,
      exec: sshExec,
    }),
  },
}));

mock.module("./node-disk-manager", () => ({
  ...realNodeDisk,
  diskHealthVerdict: realNodeDiskNs.diskHealthVerdict,
  probeNodeDiskUsage: async () => null,
}));

afterAll(() => {
  mock.module("../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("./docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./docker-ssh", () => realDockerSsh);
  mock.module("./node-disk-manager", () => realNodeDisk);
});

import { DockerNodeManager } from "./docker-node-manager";

let originalFirewallIds: string | undefined;
let originalEnvironment: string | undefined;

function node(): DockerNode {
  return {
    id: "row-1",
    node_id: "node-health",
    hostname: "203.0.113.10",
    ssh_port: 22,
    ssh_user: "root",
    capacity: 8,
    enabled: true,
    status: "unknown",
    allocated_count: 0,
    host_key_fingerprint: "SHA256:test",
    fleet_kind: "cloud",
    infrastructure_provider: "hetzner",
    provider_server_id: "4242",
    node_incarnation: null,
    metadata: {
      provider: "hetzner-cloud",
      autoscaled: true,
      environment: "staging",
    },
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function server(id = 4242): ComputeServer {
  return {
    id,
    name: "node-health",
    status: "running",
    labels: {
      "managed-by": "eliza-cloud",
      "node-id": "node-health",
      environment: "staging",
      tier: "data-plane",
    },
    firewallAttachments: [
      { id: 8101, status: "applied" },
      { id: 8102, status: "applied" },
    ],
  };
}

function provider(read: ComputeServer): ComputeProvider {
  return {
    getServer: async (id: number) => {
      events.push(`provider:get:${id}`);
      return read;
    },
  } as unknown as ComputeProvider;
}

beforeEach(() => {
  originalFirewallIds = process.env.CONTAINERS_HCLOUD_FIREWALL_IDS;
  originalEnvironment = process.env.ENVIRONMENT;
  process.env.CONTAINERS_HCLOUD_FIREWALL_IDS = "8101,8102";
  process.env.ENVIRONMENT = "staging";
  events.length = 0;
  updateStatus.mockClear();
  invalidateNodeIncarnation.mockClear();
  sshConnect.mockClear();
  sshExec.mockClear();
});

afterEach(() => {
  if (originalFirewallIds === undefined) delete process.env.CONTAINERS_HCLOUD_FIREWALL_IDS;
  else process.env.CONTAINERS_HCLOUD_FIREWALL_IDS = originalFirewallIds;
  if (originalEnvironment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = originalEnvironment;
});

describe("Docker node Hetzner health authority", () => {
  test("attests the provider before SSH and healthy promotion", async () => {
    const manager = new DockerNodeManager(provider(server()));

    await expect(manager.ensureNodeReady(node())).resolves.toBe(true);
    expect(events[0]).toBe("provider:get:4242");
    expect(events).toContain("ssh:connect");
    expect(events.at(-1)).toBe("status:healthy");
  });

  test("rejects mismatched provider identity before SSH or healthy promotion", async () => {
    const manager = new DockerNodeManager(provider(server(9999)));

    await expect(manager.ensureNodeReady(node())).resolves.toBe(false);
    expect(events).toEqual(["provider:get:4242", "status:offline"]);
    expect(sshConnect).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalledWith("node-health", "healthy");
  });
});

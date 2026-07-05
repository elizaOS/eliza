/**
 * Pre-pull recovery tests for Docker node image warming. The harness mocks the
 * repository, workload counter, SSH client, and env boundary so the shared-host
 * recovery commands can be asserted without touching Docker or SSH.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import { containersEnv as realContainersEnv } from "../config/containers-env";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";
import * as realDockerSshNs from "./docker-ssh";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };

const mocks = {
  nodes: [] as DockerNode[],
  countAllocated: mock(),
  connect: mock(),
  exec: mock(),
};

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findEnabled: () => Promise.resolve(mocks.nodes),
  },
}));

mock.module("./docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: mocks.countAllocated,
}));

mock.module("./docker-ssh", () => ({
  DockerSSHClient: {
    getClient: () => ({
      connect: mocks.connect,
      exec: mocks.exec,
    }),
  },
}));

afterAll(() => {
  mock.module("../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("./docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./docker-ssh", () => realDockerSsh);
});

import { DockerNodeManager } from "./docker-node-manager";

const SELF_HEAL_ENV = "CONTAINERS_PREPULL_SELF_HEAL_RESTART";
const SELF_HEAL_FALLBACK_ENV = "ELIZA_CONTAINERS_PREPULL_SELF_HEAL_RESTART";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
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
    host_key_fingerprint: "SHA256:test",
    metadata: { architecture: "amd64" },
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("DockerNodeManager pre-pull recovery", () => {
  let originalSelfHeal: string | undefined;
  let originalSelfHealFallback: string | undefined;

  beforeEach(() => {
    originalSelfHeal = process.env[SELF_HEAL_ENV];
    originalSelfHealFallback = process.env[SELF_HEAL_FALLBACK_ENV];
    delete process.env[SELF_HEAL_ENV];
    delete process.env[SELF_HEAL_FALLBACK_ENV];

    mocks.nodes = [];
    mocks.countAllocated.mockReset();
    mocks.countAllocated.mockResolvedValue(0);
    mocks.connect.mockReset();
    mocks.connect.mockResolvedValue(undefined);
    mocks.exec.mockReset();
  });

  afterEach(() => {
    restoreEnv(SELF_HEAL_ENV, originalSelfHeal);
    restoreEnv(SELF_HEAL_FALLBACK_ENV, originalSelfHealFallback);
  });

  test("reaps orphaned docker pull processes after a failed pre-pull", async () => {
    mocks.nodes = [node("prepull-reap-node")];
    const commands: string[] = [];
    mocks.exec.mockImplementation((command: string) => {
      commands.push(command);
      if (command.includes('wait "$pid"')) {
        return Promise.reject(
          new Error("[docker-ssh] Command timed out after 300000ms on node: sh [redacted]"),
        );
      }
      return Promise.resolve("");
    });

    const manager = DockerNodeManager.getInstance();
    const [result] = await manager.prePullAgentImageOnAvailableNodes(
      "ghcr.io/elizaos/eliza:test",
      "linux/amd64",
    );

    expect(result).toMatchObject({
      nodeId: "prepull-reap-node",
      status: "failed",
      error: "[docker-ssh] Command timed out after 300000ms on node: sh [redacted]",
    });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("docker pull");
    expect(commands[0]).toContain("ghcr.io/elizaos/eliza:test");
    expect(commands[0]).toContain("/tmp/eliza-prepull-");
    expect(commands[0]).toContain("printf");
    expect(commands[1]).toContain("/proc/$pid/cmdline");
    expect(commands[1]).toContain("ghcr.io/elizaos/eliza:test");
    expect(commands[1]).toContain('kill -9 "$pid"');
    expect(commands.join("\n")).not.toContain("pkill");
  });

  test("auto-restarts docker only after repeated failed pre-pulls when enabled", async () => {
    process.env[SELF_HEAL_ENV] = "true";
    expect(realContainersEnv.prePullSelfHealRestartEnabled()).toBe(true);

    mocks.nodes = [node("prepull-self-heal-node")];
    const commands: string[] = [];
    mocks.exec.mockImplementation((command: string) => {
      commands.push(command);
      if (command.includes('wait "$pid"')) {
        return Promise.reject(
          new Error("[docker-ssh] Command timed out after 300000ms on node: sh [redacted]"),
        );
      }
      return Promise.resolve("");
    });

    const manager = DockerNodeManager.getInstance();
    await manager.prePullAgentImageOnAvailableNodes("ghcr.io/elizaos/eliza:test", "linux/amd64");
    await manager.prePullAgentImageOnAvailableNodes("ghcr.io/elizaos/eliza:test", "linux/amd64");

    expect(commands.filter((command) => command.includes('wait "$pid"'))).toHaveLength(2);
    expect(commands.filter((command) => command.includes("/proc/$pid/cmdline"))).toHaveLength(2);
    expect(
      commands.filter((command) => command.includes("systemctl kill -s SIGKILL docker.service")),
    ).toHaveLength(1);
    expect(
      commands.filter((command) => command.includes("systemctl restart containerd")),
    ).toHaveLength(1);
    expect(commands.join("\n")).not.toContain("systemctl restart docker");
    expect(commands.join("\n")).not.toContain("pkill");
  });
});

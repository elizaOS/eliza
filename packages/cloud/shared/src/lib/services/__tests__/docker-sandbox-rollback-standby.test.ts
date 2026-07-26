/**
 * Proves rollback standby pause/resume transitions against exact Docker
 * identities without releasing node capacity or deleting VPN state.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import { DockerSandboxProvider } from "../docker-sandbox-provider";
import { DockerSSHClient } from "../docker-ssh";
import { SandboxRollbackStandbyUnresolvedError } from "../sandbox-provider-types";

const NODE: DockerNode = {
  id: "11111111-1111-4111-8111-111111111111",
  node_id: "node-standby",
  hostname: "192.0.2.51",
  ssh_port: 22,
  capacity: 8,
  enabled: true,
  status: "healthy",
  allocated_count: 2,
  last_health_check: null,
  ssh_user: "root",
  host_key_fingerprint: "SHA256:standby-node",
  metadata: {},
  created_at: new Date("2026-07-25T00:00:00.000Z"),
  updated_at: new Date("2026-07-25T00:00:00.000Z"),
};
const SANDBOX_ID = "agent-11111111-1111-4111-8111-111111111111";
const CONTAINER_NAME = SANDBOX_ID;
const CONTAINER_ID = "a".repeat(64);

type ProviderInternals = {
  containers: Map<
    string,
    {
      nodeId: string;
      hostname: string;
      containerName: string;
      bridgePort: number;
      webUiPort: number;
      agentId: string;
      sshPort: number;
      sshUser: string;
      hostKeyFingerprint?: string;
    }
  >;
};

function providerWithTrackedContainer(): DockerSandboxProvider {
  const provider = new DockerSandboxProvider();
  (provider as unknown as ProviderInternals).containers.set(SANDBOX_ID, {
    nodeId: NODE.node_id,
    hostname: NODE.hostname,
    containerName: CONTAINER_NAME,
    bridgePort: 18_801,
    webUiPort: 28_801,
    agentId: "11111111-1111-4111-8111-111111111111",
    sshPort: NODE.ssh_port ?? 22,
    sshUser: NODE.ssh_user ?? "root",
    hostKeyFingerprint: NODE.host_key_fingerprint ?? undefined,
  });
  return provider;
}

function stubSsh(execute: (command: string, index: number) => Promise<string>) {
  const commands: string[] = [];
  spyOn(DockerSSHClient, "getClient").mockImplementation(((hostname: string) => {
    expect(hostname).toBe(NODE.hostname);
    return {
      exec: mock(async (command: string) => {
        const index = commands.length;
        commands.push(command);
        return await execute(command, index);
      }),
    } as unknown as DockerSSHClient;
  }) as unknown as typeof DockerSSHClient.getClient);
  return commands;
}

afterEach(() => {
  mock.restore();
});

describe("DockerSandboxProvider rollback standby", () => {
  test("pauses and proves the exact running container without releasing capacity", async () => {
    const states = [`${CONTAINER_ID}|true|false\n`, `${CONTAINER_ID}|true|true\n`];
    const commands = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) return states.shift() ?? "";
      return "";
    });
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();

    const locator = await providerWithTrackedContainer().pauseForRollbackStandby(SANDBOX_ID);

    expect(locator).toEqual({
      nodeId: NODE.node_id,
      containerName: CONTAINER_NAME,
      containerId: CONTAINER_ID,
    });
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain(`'${CONTAINER_NAME}'`);
    expect(commands[1]).toBe(`docker pause '${CONTAINER_ID}'`);
    expect(commands[2]).toContain(`'${CONTAINER_NAME}'`);
    expect(decrement).not.toHaveBeenCalled();
  });

  test("treats an already-paused exact container as an idempotent success", async () => {
    const commands = stubSsh(async () => `${CONTAINER_ID}|true|true\n`);

    await expect(
      providerWithTrackedContainer().pauseForRollbackStandby(SANDBOX_ID),
    ).resolves.toMatchObject({ containerId: CONTAINER_ID });
    expect(commands).toHaveLength(1);
  });

  test("retains the exact locator when a pause outcome is ambiguous", async () => {
    const commands = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) return `${CONTAINER_ID}|true|false\n`;
      throw new Error("SSH response lost after docker pause");
    });

    const error = await providerWithTrackedContainer()
      .pauseForRollbackStandby(SANDBOX_ID)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxRollbackStandbyUnresolvedError);
    expect(error).toMatchObject({
      nodeId: NODE.node_id,
      containerName: CONTAINER_NAME,
      containerId: CONTAINER_ID,
    });
    expect(commands).toHaveLength(2);
  });

  test("unpauses and proves the persisted exact container identity", async () => {
    spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(NODE);
    const states = [`${CONTAINER_ID}|true|true\n`, `${CONTAINER_ID}|true|false\n`];
    const commands = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) return states.shift() ?? "";
      return "";
    });

    await providerWithTrackedContainer().resumeRollbackStandby({
      nodeId: NODE.node_id,
      containerName: CONTAINER_NAME,
      containerId: CONTAINER_ID,
    });

    expect(commands).toHaveLength(3);
    expect(commands[1]).toBe(`docker unpause '${CONTAINER_ID}'`);
  });

  test("refuses to unpause a same-name container with a different Docker id", async () => {
    spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(NODE);
    const commands = stubSsh(async () => `${"b".repeat(64)}|true|true\n`);

    await expect(
      providerWithTrackedContainer().resumeRollbackStandby({
        nodeId: NODE.node_id,
        containerName: CONTAINER_NAME,
        containerId: CONTAINER_ID,
      }),
    ).rejects.toThrow("Docker id no longer matches");
    expect(commands).toHaveLength(1);
  });

  test("treats an already-running exact standby as an idempotent success", async () => {
    spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(NODE);
    const commands = stubSsh(async () => `${CONTAINER_ID}|true|false\n`);

    await expect(
      providerWithTrackedContainer().resumeRollbackStandby({
        nodeId: NODE.node_id,
        containerName: CONTAINER_NAME,
        containerId: CONTAINER_ID,
      }),
    ).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
  });
});

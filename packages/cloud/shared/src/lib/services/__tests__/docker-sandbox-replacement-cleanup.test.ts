/**
 * Exercises the durable Docker replacement fence across remote-create crash
 * windows, exact attempt identity, VPN recovery, and capacity-neutral cleanup.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import { dockerNodeManager } from "../docker-node-manager";
import * as dockerPortAllocation from "../docker-port-allocation";
import {
  createDockerContainerAfterReplacementIntent,
  DockerSandboxProvider,
} from "../docker-sandbox-provider";
import { DockerSSHClient } from "../docker-ssh";
import { type HeadscaleNode, headscaleClient } from "../headscale-client";
import { headscaleIntegration } from "../headscale-integration";
import { SandboxReplacementCleanupUnresolvedError } from "../sandbox-provider-types";
import * as stewardTenantConfig from "../steward-tenant-config";

const NODE: DockerNode = {
  id: "11111111-1111-4111-8111-111111111111",
  node_id: "node-replacement-b",
  hostname: "192.0.2.42",
  ssh_port: 22,
  capacity: 8,
  enabled: true,
  status: "healthy",
  allocated_count: 2,
  last_health_check: null,
  ssh_user: "root",
  host_key_fingerprint: "SHA256:replacement-node",
  metadata: {},
  created_at: new Date("2026-07-23T00:00:00.000Z"),
  updated_at: new Date("2026-07-23T00:00:00.000Z"),
};

const CONTAINER_NAME = "agent-11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const CONTAINER_ID = "a".repeat(64);
const REGISTRATION_STARTED_AT = "2026-07-23T00:05:00.000Z";
const CONTAINER_CREATED_AT = "2026-07-23T00:10:00.000000000Z";
const CONTAINER_CREATED_AT_MS = Date.parse("2026-07-23T00:10:00.000Z");

function inspectLine(id: string, attempt: string, name = CONTAINER_NAME): string {
  return `${id}|${attempt}|/${name}|${CONTAINER_CREATED_AT}\n`;
}

function headscaleNode(id: string, name: string, createdAt: string): HeadscaleNode {
  return {
    id,
    name,
    user: { name: "agent" },
    ipAddresses: ["100.64.0.10"],
    online: true,
    lastSeen: createdAt,
    createdAt,
  };
}

function stubNodeLookup() {
  return spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(NODE);
}

function stubSsh(execute: (command: string) => Promise<string> = async () => ""): {
  getClient: ReturnType<typeof spyOn>;
  commands: string[];
} {
  const commands: string[] = [];
  const getClient = spyOn(DockerSSHClient, "getClient").mockImplementation(((hostname: string) => {
    expect(hostname).toBe(NODE.hostname);
    return {
      exec: mock(async (command: string) => {
        commands.push(command);
        return execute(command);
      }),
    } as unknown as DockerSSHClient;
  }) as unknown as typeof DockerSSHClient.getClient);
  return { getClient, commands };
}

function replacementIdentity(overrides?: {
  replacementAttemptId?: string;
  containerId?: string | null;
  vpnNodeName?: string | null;
  previousVpnNodeId?: string | null;
  vpnRegistrationStartedAt?: string | null;
  allocationCounted?: boolean;
}) {
  return {
    replacementAttemptId: overrides?.replacementAttemptId ?? ATTEMPT_ID,
    containerId: overrides?.containerId === undefined ? CONTAINER_ID : overrides.containerId,
    vpnNodeName: overrides?.vpnNodeName === undefined ? "agent-replacement" : overrides.vpnNodeName,
    previousVpnNodeId:
      overrides?.previousVpnNodeId === undefined ? "vpn-green" : overrides.previousVpnNodeId,
    vpnRegistrationStartedAt:
      overrides?.vpnRegistrationStartedAt === undefined
        ? REGISTRATION_STARTED_AT
        : overrides.vpnRegistrationStartedAt,
    allocationCounted: overrides?.allocationCounted ?? true,
  };
}

function replacementProvider(options?: { now?: () => number }): DockerSandboxProvider {
  return new DockerSandboxProvider({
    replacementVpnSettleDelay: async () => {},
    ...(options?.now ? { now: options.now } : {}),
  });
}

afterEach(() => {
  mock.restore();
});

describe("DockerSandboxProvider replacement cleanup", () => {
  test("persists intent before remote create even when Docker commits without an SSH response", async () => {
    const events: string[] = [];

    await expect(
      createDockerContainerAfterReplacementIntent({
        persistIntent: async () => {
          events.push("persist-intent");
        },
        createContainer: async () => {
          events.push("docker-create-committed");
          throw new Error("SSH response lost");
        },
      }),
    ).rejects.toThrow("SSH response lost");
    expect(events).toEqual(["persist-intent", "docker-create-committed"]);
  });

  test("never reaches remote create when the durable intent transaction fails", async () => {
    const events: string[] = [];

    await expect(
      createDockerContainerAfterReplacementIntent({
        persistIntent: async () => {
          events.push("persist-intent");
          throw new Error("database unavailable");
        },
        createContainer: async () => {
          events.push("docker-create");
          return CONTAINER_ID;
        },
      }),
    ).rejects.toThrow("database unavailable");
    expect(events).toEqual(["persist-intent"]);
  });

  test("leaves durable replacement capacity untouched when VPN preparation fails before intent", async () => {
    const savedEnvironment = process.env.ENVIRONMENT;
    const savedHeadscaleApiKey = process.env.HEADSCALE_API_KEY;
    const savedFallback = process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
    process.env.ENVIRONMENT = "production";
    process.env.HEADSCALE_API_KEY = "headscale-test-key";
    delete process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;

    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    spyOn(headscaleIntegration, "prepareContainerVPN").mockRejectedValue(
      new Error("Headscale preauth unavailable"),
    );
    const increment = spyOn(dockerNodesRepository, "incrementAllocated").mockResolvedValue();
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();
    const persistIntent = mock(async () => {});
    const provider = replacementProvider();

    try {
      await expect(
        provider.create({
          agentId: "11111111-1111-4111-8111-111111111111",
          agentName: "Replacement",
          organizationId: "22222222-2222-4222-8222-222222222222",
          executionTier: "dedicated-always",
          environmentVars: {},
          onReplacementCreateIntent: persistIntent,
        }),
      ).rejects.toThrow("Headscale preauth unavailable");
    } finally {
      if (savedEnvironment === undefined) {
        delete process.env.ENVIRONMENT;
      } else {
        process.env.ENVIRONMENT = savedEnvironment;
      }
      if (savedHeadscaleApiKey === undefined) {
        delete process.env.HEADSCALE_API_KEY;
      } else {
        process.env.HEADSCALE_API_KEY = savedHeadscaleApiKey;
      }
      if (savedFallback === undefined) {
        delete process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
      } else {
        process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK = savedFallback;
      }
    }

    expect(persistIntent).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
    expect(decrement).not.toHaveBeenCalled();
  });

  test("verifies attempt label and id before exact-node cleanup without releasing capacity", async () => {
    const findNode = stubNodeLookup();
    const { commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        return inspectLine(CONTAINER_ID, ATTEMPT_ID);
      }
      return "";
    });
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      "vpn-node-42",
      replacementIdentity(),
    );

    expect(findNode).toHaveBeenCalledWith(NODE.node_id);
    expect(commands[0]).toContain("docker inspect --format");
    expect(commands[0]).toContain(CONTAINER_ID);
    expect(commands.slice(1)).toEqual([
      `docker stop -t 10 '${CONTAINER_ID}'`,
      `docker rm -f '${CONTAINER_ID}'`,
    ]);
    expect(deleteVpn).toHaveBeenCalledWith("vpn-node-42");
    expect(decrement).not.toHaveBeenCalled();
  });

  test("refuses a same-name label mismatch inside the converge grace window", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => inspectLine(CONTAINER_ID, "another-attempt"));
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider({
      now: () => CONTAINER_CREATED_AT_MS + 30 * 60 * 1000,
    });

    const error = await provider
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        "vpn-node-mismatch",
        replacementIdentity(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      replacementAttemptId: ATTEMPT_ID,
      containerId: CONTAINER_ID,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("docker inspect");
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("converges a same-name label mismatch past the grace window via id+name identity", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        return inspectLine(CONTAINER_ID, "another-attempt");
      }
      return "";
    });
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();
    const provider = replacementProvider({
      now: () => CONTAINER_CREATED_AT_MS + 2 * 60 * 60 * 1000,
    });

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      "vpn-node-converge",
      replacementIdentity(),
    );

    expect(commands.slice(1)).toEqual([
      `docker stop -t 10 '${CONTAINER_ID}'`,
      `docker rm -f '${CONTAINER_ID}'`,
    ]);
    expect(deleteVpn).toHaveBeenCalledWith("vpn-node-converge");
    expect(decrement).not.toHaveBeenCalled();
  });

  test("keeps failing closed past the grace window when the observed name differs", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () =>
      inspectLine(CONTAINER_ID, "another-attempt", "agent-someone-else"),
    );
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider({
      now: () => CONTAINER_CREATED_AT_MS + 2 * 60 * 60 * 1000,
    });

    const error = await provider
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        "vpn-node-name-drift",
        replacementIdentity(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(commands).toHaveLength(1);
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("bounds an id-less stale fence when the name belongs to a newer attempt", async () => {
    stubNodeLookup();
    const newerContainerId = "b".repeat(64);
    const { commands } = stubSsh(async () => inspectLine(newerContainerId, "newer-attempt"));
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        "vpn-node-stale-fence",
        replacementIdentity({ containerId: null }),
      ),
    ).resolves.toBeUndefined();

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(CONTAINER_NAME);
    expect(commands[0]).not.toContain(`docker stop`);
    expect(commands[0]).not.toContain(`docker rm`);
    expect(deleteVpn).toHaveBeenCalledWith("vpn-node-stale-fence");
  });

  test("refuses cleanup when Docker's inspected id differs from the persisted id", async () => {
    stubNodeLookup();
    const otherId = "b".repeat(64);
    const { commands } = stubSsh(async () => inspectLine(otherId, ATTEMPT_ID));
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ vpnNodeName: null }),
      ),
    ).rejects.toThrow("container id mismatch");
    expect(commands).toHaveLength(1);
  });

  test("accepts explicit Docker inspect absence and still cleans the exact VPN id", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => {
      throw new Error(
        `[docker-ssh] Command exited with code 1 on ${NODE.hostname}: [stderr] Error: No such object: ${CONTAINER_NAME}`,
      );
    });
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        "vpn-node-absent",
        replacementIdentity(),
      ),
    ).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(deleteVpn).toHaveBeenCalledWith("vpn-node-absent");
  });

  test("accepts wrapped Docker rm absence only after the inspected attempt identity matches", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        return inspectLine(CONTAINER_ID, ATTEMPT_ID);
      }
      if (command.startsWith("docker rm")) {
        throw new Error(
          `[docker-ssh] Command exited with code 1 on ${NODE.hostname}: [stderr] Error response from daemon: No such container: ${CONTAINER_ID}`,
        );
      }
      return "";
    });
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ vpnNodeName: null }),
      ),
    ).resolves.toBeUndefined();
    expect(commands).toHaveLength(3);
  });

  test("rejects generic not-found text because it does not prove Docker absence", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => {
      throw new Error(`Container "${CONTAINER_NAME}" not found in memory or DB`);
    });
    const provider = replacementProvider();

    const error = await provider
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ vpnNodeName: null }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(commands).toHaveLength(1);
  });

  test("recovers a post-start VPN registration by name, suffix, time, and excluded live id", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error response from daemon: No such container: ${CONTAINER_NAME}`);
    });
    const matchingNodes = [
      headscaleNode("vpn-green", "agent-replacement", "2026-07-22T23:00:00.000Z"),
      headscaleNode("vpn-blue", "agent-replacement-ab12cd34", "2026-07-23T00:05:02.000Z"),
      headscaleNode("vpn-other", "agent-other", "2026-07-23T00:05:03.000Z"),
    ];
    const listNodes = spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce(matchingNodes)
      .mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      replacementIdentity({ containerId: null }),
    );

    expect(listNodes).toHaveBeenCalledTimes(4);
    expect(deleteVpn).toHaveBeenCalledWith("vpn-blue");
  });

  test("waits through an empty list and deletes a registration that commits late", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const lateNode = headscaleNode(
      "vpn-blue-late",
      "agent-replacement-ab12cd34",
      "2026-07-23T00:05:02.000Z",
    );
    const listNodes = spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lateNode])
      .mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      replacementIdentity({ containerId: null }),
    );

    expect(listNodes).toHaveBeenCalledTimes(4);
    expect(deleteVpn).toHaveBeenCalledTimes(1);
    expect(deleteVpn).toHaveBeenCalledWith("vpn-blue-late");
  });

  test("retains the fence through the registration window and removes a late VPN node afterward", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const startedAt = Date.parse(REGISTRATION_STARTED_AT);
    let now = startedAt + 1_000;
    const lateNode = headscaleNode(
      "vpn-blue-window",
      "agent-replacement-ab12cd34",
      "2026-07-23T00:07:00.000Z",
    );
    const listNodes = spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lateNode])
      .mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider({ now: () => now });

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ containerId: null }),
      ),
    ).rejects.toThrow("VPN registration window remains open");
    expect(listNodes).not.toHaveBeenCalled();
    expect(deleteVpn).not.toHaveBeenCalled();

    now = startedAt + 60 * 60 * 1_000;
    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ containerId: null }),
      ),
    ).resolves.toBeUndefined();

    expect(listNodes).toHaveBeenCalledTimes(4);
    expect(deleteVpn).toHaveBeenCalledTimes(1);
    expect(deleteVpn).toHaveBeenCalledWith("vpn-blue-window");
  });

  test("allows bounded Headscale clock skew while retaining the exact name fence", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const skewedNode = headscaleNode(
      "vpn-blue-skewed",
      "agent-replacement-ab12cd34",
      "2026-07-23T00:04:55.000Z",
    );
    spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([skewedNode])
      .mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await provider.stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      replacementIdentity({ containerId: null }),
    );

    expect(deleteVpn).toHaveBeenCalledWith("vpn-blue-skewed");
  });

  test("fails closed when multiple new VPN registrations match the same intent", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    spyOn(headscaleClient, "listNodesStrict").mockResolvedValue([
      headscaleNode("vpn-blue-1", "agent-replacement", "2026-07-23T00:05:01.000Z"),
      headscaleNode("vpn-blue-2", "agent-replacement-ab12cd34", "2026-07-23T00:05:02.000Z"),
    ]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ containerId: null }),
      ),
    ).rejects.toThrow("2 matching registrations");
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("fails closed when ambiguity appears after an initially empty Headscale list", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    const listNodes = spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        headscaleNode("vpn-blue-1", "agent-replacement", "2026-07-23T00:05:01.000Z"),
        headscaleNode("vpn-blue-2", "agent-replacement-ab12cd34", "2026-07-23T00:05:02.000Z"),
      ]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ containerId: null }),
      ),
    ).rejects.toThrow("2 matching registrations");
    expect(listNodes).toHaveBeenCalledTimes(2);
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("retains the complete locator across VPN API failure and never decrements capacity", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
    });
    spyOn(headscaleClient, "listNodesStrict").mockRejectedValue(new Error("Headscale unavailable"));
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();
    const provider = replacementProvider();

    const error = await provider
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ containerId: null }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      sandboxId: CONTAINER_NAME,
      nodeId: NODE.node_id,
      replacementAttemptId: ATTEMPT_ID,
      vpnNodeName: "agent-replacement",
      previousVpnNodeId: "vpn-green",
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      allocationCounted: true,
    });
    expect(decrement).not.toHaveBeenCalled();
  });

  test("never retries a durable create even when the first error resembles a port collision", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: {
          agentId: string;
          agentName: string;
          organizationId: string;
          environmentVars: Record<string, string>;
          onReplacementCreateIntent: () => Promise<void>;
        }) => Promise<never>;
      },
      "_createOnce",
    ).mockRejectedValue(new Error("port is already allocated"));

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Replacement",
        organizationId: "22222222-2222-4222-8222-222222222222",
        executionTier: "dedicated-always",
        environmentVars: {},
        onReplacementCreateIntent: async () => {},
      }),
    ).rejects.toThrow("port is already allocated");
    expect(createOnce).toHaveBeenCalledTimes(1);
  });

  test("never retries create past an unresolved candidate cleanup", async () => {
    const provider = replacementProvider();
    const unresolved = new SandboxReplacementCleanupUnresolvedError(
      {
        sandboxId: CONTAINER_NAME,
        nodeId: NODE.node_id,
        containerName: CONTAINER_NAME,
        replacementAttemptId: ATTEMPT_ID,
        vpnNodeId: "vpn-node-create",
      },
      new Error("node unreachable"),
    );
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: {
          agentId: string;
          agentName: string;
          organizationId: string;
          environmentVars: Record<string, string>;
        }) => Promise<never>;
      },
      "_createOnce",
    ).mockRejectedValue(unresolved);

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Replacement",
        organizationId: "22222222-2222-4222-8222-222222222222",
        executionTier: "dedicated-always",
        environmentVars: {},
      }),
    ).rejects.toBe(unresolved);
    expect(createOnce).toHaveBeenCalledTimes(1);
  });
});

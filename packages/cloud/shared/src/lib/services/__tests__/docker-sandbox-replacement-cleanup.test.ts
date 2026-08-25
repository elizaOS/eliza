/**
 * Exercises the durable Docker replacement fence across remote-create crash
 * windows, exact attempt identity, VPN recovery, and capacity-neutral cleanup.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import * as nodeAutoscaler from "../containers/node-autoscaler";
import { dockerNodeManager } from "../docker-node-manager";
import * as dockerPortAllocation from "../docker-port-allocation";
import { DockerSandboxProvider } from "../docker-sandbox-provider";
import {
  getReplacementCandidateObservedReceipt,
  getReplacementDockerCreateQuiescentReceipt,
  getReplacementSecretArtifactsCleanupReceipt,
} from "../docker-sandbox-utils";
import { DockerSSHClient } from "../docker-ssh";
import { type HeadscaleNode, headscaleClient } from "../headscale-client";
import { headscaleIntegration } from "../headscale-integration";
import {
  type SandboxCreateConfig,
  type SandboxExactDockerTarget,
  type SandboxHandle,
  SandboxReplacementCleanupUnresolvedError,
  SandboxReplacementCreateSettlementCleanupUnresolvedError,
} from "../sandbox-provider-types";
import * as stewardTenantConfig from "../steward-tenant-config";

const NODE_INCARNATION = "22222222-2222-4222-8222-222222222222";
const NODE_HISTORY_ID = "44444444-4444-4444-8444-444444444444";
const NODE: DockerNode = {
  id: "11111111-1111-4111-8111-111111111111",
  node_id: "node-replacement-b",
  hostname: "192.0.2.42",
  ssh_port: 22,
  capacity: 8,
  enabled: true,
  placement_state: "open",
  status: "healthy",
  allocated_count: 2,
  last_health_check: null,
  ssh_user: "root",
  host_key_fingerprint: "SHA256:replacement-node",
  fleet_kind: "robot",
  infrastructure_provider: "hetzner",
  provider_server_id: null,
  node_incarnation: NODE_INCARNATION,
  current_node_history_id: NODE_HISTORY_ID,
  metadata: { architecture: "amd64", environment: "local" },
  created_at: new Date("2026-07-23T00:00:00.000Z"),
  updated_at: new Date("2026-07-23T00:00:00.000Z"),
};

const CONTAINER_NAME = "agent-11111111-1111-4111-8111-111111111111";
const VOLUME_PATH = "/data/agents/11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const CONTAINER_ID = "a".repeat(64);
const REPLACEMENT_BOOT_ID_READ_COMMAND = "cat '/proc/sys/kernel/random/boot_id'";
const PREVIOUS_VPN_NODE_ID = "1403";
const EXACT_VPN_NODE_ID = "1404";
const REGISTRATION_STARTED_AT = "2026-07-23T00:05:00.000Z";
const CONTAINER_CREATED_AT = "2026-07-23T00:10:00.000000000Z";
const CONTAINER_CREATED_AT_MS = Date.parse("2026-07-23T00:10:00.000Z");
const HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS = [
  "HEADSCALE_API_URL",
  "HEADSCALE_PUBLIC_URL",
  "ELIZA_CLOUD_AGENT_BASE_DOMAIN",
  "CONTAINERS_PUBLIC_BASE_DOMAIN",
] as const;
const HEALTHY_EXACT_TARGET_PSI = [
  "some avg10=1.02 avg60=0.98 avg300=1.11 total=499893023295",
  "full avg10=0.87 avg60=0.79 avg300=0.81 total=457451749125",
].join("\n");
const STARVED_EXACT_TARGET_PSI = [
  "some avg10=75.21 avg60=82.04 avg300=82.69 total=493046940717",
  "full avg10=72.89 avg60=78.50 avg300=78.61 total=450805502651",
].join("\n");

function exactTargetReadinessProbe(options?: {
  architecture?: string;
  psi?: string;
  memoryTotalMb?: number;
  memoryAvailableMb?: number;
  committedMemoryMb?: number[];
}): string {
  const totalMb = options?.memoryTotalMb ?? 65_536;
  const availableMb = options?.memoryAvailableMb ?? 60_000;
  const committedMemoryMb = options?.committedMemoryMb ?? [];
  return [
    `docker-id-exact|${options?.architecture ?? "x86_64"}`,
    "---IO-PRESSURE---",
    options?.psi ?? HEALTHY_EXACT_TARGET_PSI,
    "---MEMINFO---",
    `MemTotal:       ${totalMb * 1024} kB`,
    `MemAvailable:   ${availableMb * 1024} kB`,
    "---MEM-COMMITTED---",
    ...committedMemoryMb.map((memoryMb) => String(memoryMb * 1024 * 1024)),
    "---MEM-COMMITTED-STATUS---",
    "ok",
  ].join("\n");
}

function exactDockerTarget(
  overrides: Partial<SandboxExactDockerTarget> = {},
): SandboxExactDockerTarget {
  return {
    nodeRecordId: NODE.id,
    nodeId: NODE.node_id,
    nodeIncarnation: NODE_INCARNATION,
    nodeHistoryId: NODE_HISTORY_ID,
    ...overrides,
  };
}

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

function stubNodeLookup(node: DockerNode = NODE) {
  const primary = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(node);
  const legacy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(node);
  spyOn(headscaleClient, "listNodesStrict").mockResolvedValue([]);
  return { primary, legacy };
}

function stubSsh(execute: (command: string) => Promise<string> = async () => ""): {
  getClient: ReturnType<typeof spyOn>;
  commands: string[];
  bootCheckCommands: string[];
  candidateObservationCommands: string[];
  secretCleanupCommands: string[];
} {
  const commands: string[] = [];
  const bootCheckCommands: string[] = [];
  const candidateObservationCommands: string[] = [];
  const secretCleanupCommands: string[] = [];
  const getClient = spyOn(DockerSSHClient, "getClient").mockImplementation(((hostname: string) => {
    expect(hostname).toBe(NODE.hostname);
    return {
      exec: mock(async (command: string) => {
        if (command === REPLACEMENT_BOOT_ID_READ_COMMAND) {
          bootCheckCommands.push(command);
          return `${NODE_INCARNATION}\n`;
        }
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          secretCleanupCommands.push(command);
          return `${getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID)}\n`;
        }
        if (command.includes("ELIZA_REPLACEMENT_CANDIDATE_OBSERVED_V1")) {
          candidateObservationCommands.push(command);
          return `${getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID)}\n`;
        }
        commands.push(command);
        return execute(command);
      }),
    } as unknown as DockerSSHClient;
  }) as unknown as typeof DockerSSHClient.getClient);
  return {
    getClient,
    commands,
    bootCheckCommands,
    candidateObservationCommands,
    secretCleanupCommands,
  };
}

function replacementIdentity(overrides?: {
  replacementAttemptId?: string;
  containerId?: string | null;
  vpnNodeName?: string | null;
  previousVpnNodeId?: string | null;
  vpnRegistrationStartedAt?: string | null;
  allocationCounted?: boolean;
}) {
  const vpnNodeName =
    overrides?.vpnNodeName === undefined ? "agent-replacement" : overrides.vpnNodeName;
  return {
    nodeRecordId: NODE.id,
    nodeIncarnation: NODE_INCARNATION,
    nodeHistoryId: NODE_HISTORY_ID,
    nodeHostname: NODE.hostname,
    nodeSshPort: NODE.ssh_port,
    nodeSshUser: NODE.ssh_user,
    nodeHostKeyFingerprint: NODE.host_key_fingerprint,
    replacementSecretCleanupVersion: 1 as const,
    replacementAttemptId: overrides?.replacementAttemptId ?? ATTEMPT_ID,
    containerId: overrides?.containerId === undefined ? CONTAINER_ID : overrides.containerId,
    vpnNodeName,
    previousVpnNodeId:
      overrides?.previousVpnNodeId === undefined
        ? vpnNodeName === null
          ? null
          : PREVIOUS_VPN_NODE_ID
        : overrides.previousVpnNodeId,
    vpnRegistrationStartedAt:
      overrides?.vpnRegistrationStartedAt === undefined
        ? vpnNodeName === null
          ? null
          : REGISTRATION_STARTED_AT
        : overrides.vpnRegistrationStartedAt,
    allocationCounted: overrides?.allocationCounted ?? true,
  };
}

function postCutoverPrimaryIdentity(containerId: string | null = CONTAINER_ID) {
  return {
    nodeRecordId: NODE.id,
    nodeIncarnation: NODE_INCARNATION,
    nodeHistoryId: NODE_HISTORY_ID,
    nodeHostname: NODE.hostname,
    nodeSshPort: NODE.ssh_port,
    nodeSshUser: NODE.ssh_user,
    nodeHostKeyFingerprint: NODE.host_key_fingerprint,
    replacementSecretCleanupVersion: null,
    replacementAttemptId: null,
    containerId,
    vpnNodeName: null,
    previousVpnNodeId: null,
    vpnRegistrationStartedAt: null,
    allocationCounted: true,
  };
}

function legacyReplacementIdentity(
  overrides?: Parameters<typeof replacementIdentity>[0],
): Omit<
  ReturnType<typeof replacementIdentity>,
  | "nodeRecordId"
  | "nodeIncarnation"
  | "nodeHistoryId"
  | "nodeHostname"
  | "nodeSshPort"
  | "nodeSshUser"
  | "nodeHostKeyFingerprint"
  | "replacementSecretCleanupVersion"
> {
  const {
    nodeRecordId: _nodeRecordId,
    nodeIncarnation: _nodeIncarnation,
    nodeHistoryId: _nodeHistoryId,
    nodeHostname: _nodeHostname,
    nodeSshPort: _nodeSshPort,
    nodeSshUser: _nodeSshUser,
    nodeHostKeyFingerprint: _nodeHostKeyFingerprint,
    replacementSecretCleanupVersion: _replacementSecretCleanupVersion,
    ...legacy
  } = replacementIdentity(overrides);
  return legacy;
}

function replacementHandle(replacementAttemptId = ATTEMPT_ID): SandboxHandle {
  return {
    sandboxId: CONTAINER_NAME,
    bridgeUrl: `http://${NODE.hostname}:18790`,
    healthUrl: `http://${NODE.hostname}:20000/api`,
    metadata: {
      provider: "docker",
      nodeId: NODE.node_id,
      hostname: NODE.hostname,
      nodeRecordId: NODE.id,
      nodeIncarnation: NODE_INCARNATION,
      nodeHistoryId: NODE_HISTORY_ID,
      nodeSshPort: NODE.ssh_port,
      nodeSshUser: NODE.ssh_user,
      nodeHostKeyFingerprint: NODE.host_key_fingerprint ?? undefined,
      replacementSecretCleanupVersion: 1,
      containerName: CONTAINER_NAME,
      bridgePort: 18790,
      webUiPort: 20000,
      agentId: "11111111-1111-4111-8111-111111111111",
      volumePath: VOLUME_PATH,
      dockerImage: "eliza-agent:test",
      imageDigest: null,
      replacementAttemptId,
      containerId: CONTAINER_ID,
      allocationCounted: true,
    },
  };
}

function replacementIntentHandle(replacementAttemptId = ATTEMPT_ID): SandboxHandle {
  const handle = replacementHandle(replacementAttemptId);
  const { containerId: _containerId, vpnNodeId: _vpnNodeId, ...metadata } = handle.metadata ?? {};
  return { ...handle, metadata };
}

function legacyReplacementHandle(handle: SandboxHandle): SandboxHandle {
  const {
    nodeRecordId: _nodeRecordId,
    nodeIncarnation: _nodeIncarnation,
    nodeHistoryId: _nodeHistoryId,
    nodeSshPort: _nodeSshPort,
    nodeSshUser: _nodeSshUser,
    nodeHostKeyFingerprint: _nodeHostKeyFingerprint,
    replacementSecretCleanupVersion: _replacementSecretCleanupVersion,
    ...metadata
  } = handle.metadata ?? {};
  return { ...handle, metadata };
}

async function completeRequiredReplacementStages(
  config: SandboxCreateConfig,
  handle: SandboxHandle = replacementHandle(config.replacementAttemptId),
): Promise<void> {
  await config.onReplacementCreateIntent?.(replacementIntentHandle(config.replacementAttemptId));
  await config.onReplacementCreated?.(handle);
}

function replacementCreateConfig(
  overrides: Partial<SandboxCreateConfig> = {},
): SandboxCreateConfig {
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    agentName: "Replacement",
    organizationId: "22222222-2222-4222-8222-222222222222",
    executionTier: "dedicated-always",
    environmentVars: {},
    ...overrides,
  };
}

function replacementProvider(options?: { now?: () => number }): DockerSandboxProvider {
  spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
  return new DockerSandboxProvider({
    replacementVpnSettleDelay: async () => {},
    ...(options?.now ? { now: options.now } : {}),
  });
}

afterEach(() => {
  mock.restore();
});

describe("DockerSandboxProvider replacement cleanup", () => {
  test("advertises exact-success replacement settlement support", () => {
    const provider = replacementProvider();
    expect(provider.replacementCreateSettlementCapability).toBe("exact-success");
    expect(provider.exactDockerTargetCapability).toBe("immutable-node-occurrence");
  });

  test("rejects an exact Docker target without exact-success ownership before provider work", async () => {
    const provider = replacementProvider();
    const primary = spyOn(dockerNodesRepository, "findByIdOnPrimary");
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const autoscale = spyOn(
      provider as unknown as {
        provisionAutoscaledNodeForAgent: () => Promise<DockerNode | null>;
      },
      "provisionAutoscaledNodeForAgent",
    );
    const ssh = spyOn(DockerSSHClient, "getClient");

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          exactDockerTarget: exactDockerTarget(),
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_DOCKER_TARGET_REQUIRES_EXACT_SUCCESS",
      context: { nodeRecordId: NODE.id, nodeId: NODE.node_id },
    });
    expect(primary).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect(autoscale).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("uses the exact primary target without discovery, autoscale, fallback, or capacity mutation", async () => {
    const provider = replacementProvider();
    const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
    const readiness = spyOn(dockerNodeManager, "ensureExactNodeReady").mockResolvedValue(true);
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const autoscale = spyOn(
      provider as unknown as {
        provisionAutoscaledNodeForAgent: () => Promise<DockerNode | null>;
      },
      "provisionAutoscaledNodeForAgent",
    );
    const findAll = spyOn(dockerNodesRepository, "findAll");
    const increment = spyOn(dockerNodesRepository, "incrementAllocated");
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated");
    const portsFailure = new Error("stop after exact target selection");
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockRejectedValue(
      portsFailure,
    );
    const ssh = spyOn(DockerSSHClient, "getClient");

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          exactDockerTarget: exactDockerTarget(),
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBe(portsFailure);
    expect(targetRead).toHaveBeenCalledTimes(2);
    expect(targetRead).toHaveBeenCalledWith(NODE.id);
    expect(readiness).toHaveBeenCalledWith(
      NODE,
      expect.objectContaining({
        expectedNodeIncarnation: NODE_INCARNATION,
        requiredPlatform: "linux/amd64",
        requiredMemoryMb: expect.any(Number),
      }),
    );
    expect(ports).toHaveBeenCalledWith(NODE.node_id);
    expect(discovery).not.toHaveBeenCalled();
    expect(autoscale).not.toHaveBeenCalled();
    expect(findAll).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
    expect(decrement).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("rejects an exact target whose disabled memory ceiling would skip live admission", async () => {
    const provider = replacementProvider();
    const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary");
    const readiness = spyOn(dockerNodeManager, "ensureExactNodeReady");
    const persistIntent = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          exactDockerTarget: exactDockerTarget(),
          container: { memoryMb: 0 },
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_DOCKER_TARGET_MEMORY_CEILING_REQUIRED",
      context: { containerMemoryMb: 0 },
    });
    expect(targetRead).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
    expect(persistIntent).not.toHaveBeenCalled();
  });

  test("attests an exact Robot boot occurrence before intent or candidate creation", async () => {
    const savedEnvironment = process.env.ENVIRONMENT;
    delete process.env.ENVIRONMENT;
    const typedRobotNode: DockerNode = {
      ...NODE,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
    };
    const provider = replacementProvider();
    const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(
      typedRobotNode,
    );
    const attest = spyOn(dockerNodesRepository, "attestNodeIncarnation").mockResolvedValue(
      typedRobotNode,
    );
    const updateStatus = spyOn(dockerNodesRepository, "updateStatus").mockResolvedValue();
    const portsFailure = new Error("stop after exact Robot boot attestation");
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockRejectedValue(portsFailure);
    const ssh = {
      connect: mock(async () => {}),
      exec: mock(async (command: string) => {
        if (command.startsWith("docker info --format")) return exactTargetReadinessProbe();
        if (command === "cat /proc/sys/kernel/random/boot_id") {
          return `${NODE_INCARNATION}\n`;
        }
        throw new Error(`unexpected candidate effect: ${command}`);
      }),
      execStdin: mock(async () => {
        throw new Error("unexpected candidate stdin effect");
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const persistIntent = mock(async () => {});

    let error: unknown;
    try {
      error = await provider
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            exactDockerTarget: exactDockerTarget(),
            container: { memoryMb: 3_072 },
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: persistIntent,
            onReplacementCreated: async () => {},
            onReplacementCreateSettled: async () => {},
          }),
        )
        .catch((caught: unknown) => caught);
    } finally {
      if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = savedEnvironment;
    }

    expect(error).toBe(portsFailure);
    expect(targetRead).toHaveBeenCalledTimes(2);
    expect(attest).toHaveBeenCalledTimes(1);
    expect(attest).toHaveBeenCalledWith({
      id: typedRobotNode.id,
      nodeId: typedRobotNode.node_id,
      expectedIncarnation: typedRobotNode.node_incarnation,
      expectedHostKeyFingerprint: typedRobotNode.host_key_fingerprint,
      observedIncarnation: NODE_INCARNATION,
    });
    expect(updateStatus).not.toHaveBeenCalled();
    expect(persistIntent).not.toHaveBeenCalled();
    expect(ssh.execStdin).not.toHaveBeenCalled();
    expect(
      ssh.exec.mock.calls.find(([command]) => command.startsWith("docker info --format"))?.[0],
    ).toContain("docker ps -aq");
  });

  test("rejects exact target occurrence drift before ports, preparation, or SSH effects", async () => {
    const driftedNode = {
      ...NODE,
      node_incarnation: "55555555-5555-4555-8555-555555555555",
    };
    const provider = replacementProvider();
    const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(
      driftedNode,
    );
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const autoscale = spyOn(
      provider as unknown as {
        provisionAutoscaledNodeForAgent: () => Promise<DockerNode | null>;
      },
      "provisionAutoscaledNodeForAgent",
    );
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const steward = spyOn(stewardTenantConfig, "ensureStewardTenant");
    const headscale = spyOn(headscaleIntegration, "prepareContainerVPN");
    const ssh = spyOn(DockerSSHClient, "getClient");
    const persistIntent = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          exactDockerTarget: exactDockerTarget(),
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_DOCKER_TARGET_DRIFT",
      context: {
        nodeRecordId: NODE.id,
        nodeId: NODE.node_id,
        driftedKey: "nodeIncarnation",
      },
    });
    expect(targetRead).toHaveBeenCalledWith(NODE.id);
    expect(discovery).not.toHaveBeenCalled();
    expect(autoscale).not.toHaveBeenCalled();
    expect(ports).not.toHaveBeenCalled();
    expect(steward).not.toHaveBeenCalled();
    expect(headscale).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
    expect(persistIntent).not.toHaveBeenCalled();
  });

  test("re-reads primary after live attestation and rejects resulting occurrence drift", async () => {
    const savedEnvironment = process.env.ENVIRONMENT;
    delete process.env.ENVIRONMENT;
    const provider = replacementProvider();
    const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary")
      .mockResolvedValueOnce(NODE)
      .mockResolvedValueOnce({
        ...NODE,
        node_incarnation: "55555555-5555-4555-8555-555555555555",
      });
    const readiness = spyOn(dockerNodeManager, "ensureExactNodeReady").mockResolvedValue(true);
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const steward = spyOn(stewardTenantConfig, "ensureStewardTenant");
    const headscale = spyOn(headscaleIntegration, "prepareContainerVPN");
    const ssh = spyOn(DockerSSHClient, "getClient");
    const persistIntent = mock(async () => {});

    let error: unknown;
    try {
      error = await provider
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            exactDockerTarget: exactDockerTarget(),
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: persistIntent,
            onReplacementCreated: async () => {},
            onReplacementCreateSettled: async () => {},
          }),
        )
        .catch((caught: unknown) => caught);
    } finally {
      if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = savedEnvironment;
    }

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_DOCKER_TARGET_DRIFT",
      context: { driftedKey: "nodeIncarnation" },
    });
    expect(targetRead).toHaveBeenCalledTimes(2);
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(ports).not.toHaveBeenCalled();
    expect(steward).not.toHaveBeenCalled();
    expect(headscale).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
    expect(persistIntent).not.toHaveBeenCalled();
  });

  test("rejects host-route drift between live attestation and the primary re-read", async () => {
    const savedEnvironment = process.env.ENVIRONMENT;
    delete process.env.ENVIRONMENT;
    const provider = replacementProvider();
    const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary")
      .mockResolvedValueOnce(NODE)
      .mockResolvedValueOnce({ ...NODE, hostname: "192.0.2.99" });
    const readiness = spyOn(dockerNodeManager, "ensureExactNodeReady").mockResolvedValue(true);
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const steward = spyOn(stewardTenantConfig, "ensureStewardTenant");
    const headscale = spyOn(headscaleIntegration, "prepareContainerVPN");
    const persistIntent = mock(async () => {});

    let error: unknown;
    try {
      error = await provider
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            exactDockerTarget: exactDockerTarget(),
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: persistIntent,
            onReplacementCreated: async () => {},
            onReplacementCreateSettled: async () => {},
          }),
        )
        .catch((caught: unknown) => caught);
    } finally {
      if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = savedEnvironment;
    }

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_DOCKER_TARGET_HOST_AUTHORITY_DRIFT",
      context: { driftedKey: "hostname" },
    });
    expect(targetRead).toHaveBeenCalledTimes(2);
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(ports).not.toHaveBeenCalled();
    expect(steward).not.toHaveBeenCalled();
    expect(headscale).not.toHaveBeenCalled();
    expect(persistIntent).not.toHaveBeenCalled();
  });

  test("rejects an unpinned exact target before candidate-specific effects", async () => {
    const provider = replacementProvider();
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue({
      ...NODE,
      host_key_fingerprint: null,
    });
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const steward = spyOn(stewardTenantConfig, "ensureStewardTenant");
    const ssh = spyOn(DockerSSHClient, "getClient");

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          exactDockerTarget: exactDockerTarget(),
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_DOCKER_TARGET_SSH_AUTHORITY_INVALID",
    });
    expect(discovery).not.toHaveBeenCalled();
    expect(ports).not.toHaveBeenCalled();
    expect(steward).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("rejects an ineligible exact target instead of reselecting another node", async () => {
    const provider = replacementProvider();
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue({
      ...NODE,
      placement_state: "cordoned",
    });
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const autoscale = spyOn(
      provider as unknown as {
        provisionAutoscaledNodeForAgent: () => Promise<DockerNode | null>;
      },
      "provisionAutoscaledNodeForAgent",
    );
    const findAll = spyOn(dockerNodesRepository, "findAll");
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const ssh = spyOn(DockerSSHClient, "getClient");

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          exactDockerTarget: exactDockerTarget(),
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_DOCKER_TARGET_INELIGIBLE",
      context: { placementState: "cordoned" },
    });
    expect(discovery).not.toHaveBeenCalled();
    expect(autoscale).not.toHaveBeenCalled();
    expect(findAll).not.toHaveBeenCalled();
    expect(ports).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("fails closed on both unlabeled and mismatched exact-target environments", async () => {
    const savedEnvironment = process.env.ENVIRONMENT;
    process.env.ENVIRONMENT = "staging";
    const provider = replacementProvider();
    const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary")
      .mockResolvedValueOnce({ ...NODE, metadata: { architecture: "amd64" } })
      .mockResolvedValueOnce({
        ...NODE,
        metadata: { architecture: "amd64", environment: "production" },
      });
    const readiness = spyOn(dockerNodeManager, "ensureExactNodeReady");
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const ssh = spyOn(DockerSSHClient, "getClient");

    try {
      for (const targetEnvironment of [null, "production"] as const) {
        const error = await provider
          .create(
            replacementCreateConfig({
              replacementAttemptId: ATTEMPT_ID,
              exactDockerTarget: exactDockerTarget(),
              onReplacementCreateAttemptStarted: async () => {},
              onReplacementCreateIntent: async () => {},
              onReplacementCreated: async () => {},
              onReplacementCreateSettled: async () => {},
            }),
          )
          .catch((caught: unknown) => caught);

        expect(error).toMatchObject({
          code: "SANDBOX_EXACT_DOCKER_TARGET_ENVIRONMENT_MISMATCH",
          context: {
            configuredEnvironment: "staging",
            targetEnvironment,
          },
        });
      }
    } finally {
      if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = savedEnvironment;
    }

    expect(targetRead).toHaveBeenCalledTimes(2);
    expect(readiness).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    expect(ports).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  for (const scenario of [
    {
      name: "a rebooted target occurrence",
      bootId: "55555555-5555-4555-8555-555555555555",
      probe: exactTargetReadinessProbe(),
    },
    {
      name: "an actually incompatible architecture",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe({ architecture: "aarch64" }),
    },
    {
      name: "a missing live architecture",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe().replace("|x86_64", "|"),
    },
    {
      name: "a malformed live architecture",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe({ architecture: "mips64" }),
    },
    {
      name: "live IO pressure",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe({ psi: STARVED_EXACT_TARGET_PSI }),
    },
    {
      name: "a missing live IO pressure signal",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe().replace(HEALTHY_EXACT_TARGET_PSI, ""),
    },
    {
      name: "a malformed live IO pressure signal",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe().replace(
        HEALTHY_EXACT_TARGET_PSI,
        "full avg10=unknown avg60=unknown",
      ),
    },
    {
      name: "insufficient live memory",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe({
        memoryTotalMb: 7_745,
        memoryAvailableMb: 2_058,
        committedMemoryMb: [3_072, 3_072],
      }),
    },
    {
      name: "missing live meminfo",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe().replace(/MemTotal:[^\n]*\nMemAvailable:[^\n]*/, ""),
    },
    {
      name: "malformed live meminfo",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe().replace(
        /MemTotal:[^\n]*\nMemAvailable:[^\n]*/,
        "MemTotal: unknown\nMemAvailable: unknown",
      ),
    },
    {
      name: "a missing Docker committed-memory status",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe().replace("---MEM-COMMITTED-STATUS---\nok", ""),
    },
    {
      name: "a malformed Docker committed-memory status",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe().replace(
        "---MEM-COMMITTED-STATUS---\nok",
        "---MEM-COMMITTED-STATUS---\nunknown",
      ),
    },
    {
      name: "a failed Docker committed-memory enumeration",
      bootId: NODE_INCARNATION,
      probe: exactTargetReadinessProbe().replace(
        "---MEM-COMMITTED-STATUS---\nok",
        "---MEM-COMMITTED-STATUS---\nfailed",
      ),
    },
  ]) {
    test(`rejects ${scenario.name} without selection or candidate effects`, async () => {
      const savedEnvironment = process.env.ENVIRONMENT;
      delete process.env.ENVIRONMENT;
      const provider = replacementProvider();
      const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(NODE);
      const discovery = spyOn(dockerNodeManager, "getAvailableNode");
      const autoscale = spyOn(
        provider as unknown as {
          provisionAutoscaledNodeForAgent: () => Promise<DockerNode | null>;
        },
        "provisionAutoscaledNodeForAgent",
      );
      const findAll = spyOn(dockerNodesRepository, "findAll");
      spyOn(dockerNodesRepository, "attestNodeIncarnation").mockResolvedValue(NODE);
      const updateStatus = spyOn(dockerNodesRepository, "updateStatus").mockResolvedValue();
      const increment = spyOn(dockerNodesRepository, "incrementAllocated");
      const decrement = spyOn(dockerNodesRepository, "decrementAllocated");
      const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
      const steward = spyOn(stewardTenantConfig, "ensureStewardTenant");
      const headscale = spyOn(headscaleIntegration, "prepareContainerVPN");
      const readinessCommands: string[] = [];
      const ssh = {
        connect: mock(async () => {}),
        exec: mock(async (command: string) => {
          readinessCommands.push(command);
          if (command.startsWith("docker info --format")) return scenario.probe;
          if (command === "cat /proc/sys/kernel/random/boot_id") {
            return `${scenario.bootId}\n`;
          }
          throw new Error(`unexpected candidate effect: ${command}`);
        }),
        execStdin: mock(async () => {
          throw new Error("unexpected candidate stdin effect");
        }),
      };
      const getSsh = spyOn(DockerSSHClient, "getClient").mockReturnValue(
        ssh as unknown as DockerSSHClient,
      );
      const persistIntent = mock(async () => {});

      let error: unknown;
      try {
        error = await provider
          .create(
            replacementCreateConfig({
              replacementAttemptId: ATTEMPT_ID,
              exactDockerTarget: exactDockerTarget(),
              container: { memoryMb: 3_072 },
              onReplacementCreateAttemptStarted: async () => {},
              onReplacementCreateIntent: persistIntent,
              onReplacementCreated: async () => {},
              onReplacementCreateSettled: async () => {},
            }),
          )
          .catch((caught: unknown) => caught);
      } finally {
        if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
        else process.env.ENVIRONMENT = savedEnvironment;
      }

      expect(error).toMatchObject({ code: "SANDBOX_EXACT_DOCKER_TARGET_NOT_READY" });
      expect(targetRead).toHaveBeenCalledTimes(2);
      expect(discovery).not.toHaveBeenCalled();
      expect(autoscale).not.toHaveBeenCalled();
      expect(findAll).not.toHaveBeenCalled();
      expect(ports).not.toHaveBeenCalled();
      expect(steward).not.toHaveBeenCalled();
      expect(headscale).not.toHaveBeenCalled();
      expect(persistIntent).not.toHaveBeenCalled();
      expect(increment).not.toHaveBeenCalled();
      expect(decrement).not.toHaveBeenCalled();
      expect(updateStatus).not.toHaveBeenCalled();
      expect(getSsh).toHaveBeenCalledTimes(1);
      expect(ssh.connect).toHaveBeenCalledTimes(1);
      expect(ssh.execStdin).not.toHaveBeenCalled();
      expect(readinessCommands[0]).toContain("docker info --format");
      expect(readinessCommands).toContain("cat /proc/sys/kernel/random/boot_id");
    });
  }

  test("rejects a non-canonical caller attempt ID before provider work", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF",
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SANDBOX_REPLACEMENT_ATTEMPT_ID_INVALID" });
    expect(createOnce).not.toHaveBeenCalled();
  });

  test("generates one canonical attempt ID for existing callers", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => replacementHandle(config.replacementAttemptId));

    const handle = await provider.create(replacementCreateConfig());
    const forwardedAttemptId = createOnce.mock.calls[0]?.[0].replacementAttemptId;

    expect(forwardedAttemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(handle.metadata?.replacementAttemptId).toBe(forwardedAttemptId);
    expect(createOnce).toHaveBeenCalledTimes(1);
  });

  test("requires a caller-owned attempt ID in exact-success mode", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());
    const started = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          onReplacementCreateAttemptStarted: started,
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SANDBOX_REPLACEMENT_CALLER_ATTEMPT_ID_REQUIRED" });
    expect(started).not.toHaveBeenCalled();
    expect(createOnce).not.toHaveBeenCalled();
  });

  test("keeps existing replacement callbacks compatible without exact settlement metadata", async () => {
    const provider = replacementProvider();
    const legacyIntent = legacyReplacementHandle(replacementIntentHandle());
    const legacyCreated = legacyReplacementHandle(replacementHandle());
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(legacyIntent);
      await config.onReplacementCreated?.(legacyCreated);
      return legacyCreated;
    });
    const persistIntent = mock(async () => {});
    const persistCreated = mock(async () => {});

    await expect(
      provider.create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: persistCreated,
        }),
      ),
    ).resolves.toMatchObject({ sandboxId: CONTAINER_NAME });

    expect(persistIntent).toHaveBeenCalledWith(legacyIntent);
    expect(persistCreated).toHaveBeenCalledWith(legacyCreated);
  });

  test("rejects unpaired exact-success callbacks before effects", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());
    const started = mock(async () => {});

    const startedOnly = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: started,
        }),
      )
      .catch((caught: unknown) => caught);
    const settledOnly = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(startedOnly).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CREATE_SETTLEMENT_PAIR_REQUIRED",
    });
    expect(settledOnly).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CREATE_SETTLEMENT_PAIR_REQUIRED",
    });
    expect(started).not.toHaveBeenCalled();
    expect(createOnce).not.toHaveBeenCalled();
  });

  test("rejects exact settlement without pre-start Docker create enrichment", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CREATED_ENRICHMENT_REQUIRED",
    });
    expect(createOnce).not.toHaveBeenCalled();
  });

  test("settles only after the real provider promise, not an external timeout race", async () => {
    const provider = replacementProvider();
    let finishProvider!: (handle: SandboxHandle) => void;
    const pendingProvider = new Promise<SandboxHandle>((resolve) => {
      finishProvider = resolve;
    });
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await completeRequiredReplacementStages(config);
      return pendingProvider;
    });
    const starts: string[] = [];
    const settlements: Array<{ replacementAttemptId: string; outcome: string }> = [];
    const createPromise = provider.create(
      replacementCreateConfig({
        replacementAttemptId: ATTEMPT_ID,
        onReplacementCreateAttemptStarted: async (started) => {
          expect(Object.isFrozen(started)).toBe(true);
          starts.push(started.replacementAttemptId);
        },
        onReplacementCreateIntent: async () => {},
        onReplacementCreated: async () => {},
        onReplacementCreateSettled: async (settlement) => {
          settlements.push(settlement);
        },
      }),
    );

    const callerOutcome = await Promise.race([
      createPromise.then(() => "provider-finished"),
      Promise.resolve("caller-timeout"),
    ]);
    expect(callerOutcome).toBe("caller-timeout");
    expect(starts).toEqual([ATTEMPT_ID]);
    expect(settlements).toEqual([]);

    finishProvider(replacementHandle());
    await expect(createPromise).resolves.toMatchObject({ sandboxId: CONTAINER_NAME });
    expect(settlements).toEqual([{ replacementAttemptId: ATTEMPT_ID, outcome: "succeeded" }]);
    expect(createOnce.mock.calls[0]?.[0].replacementAttemptId).toBe(ATTEMPT_ID);
  });

  test("does not emit success for a malformed final durable locator", async () => {
    const provider = replacementProvider();
    const validHandle = replacementHandle();
    const { containerId: _containerId, ...malformedMetadata } = validHandle.metadata ?? {};
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await completeRequiredReplacementStages(config, validHandle);
      return { ...validHandle, metadata: malformedMetadata };
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_INVALID",
      context: { stage: "final", callbackHasContainerId: false },
    });
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("rejects a self-consistent but non-canonical container name for the requested agent", async () => {
    const provider = replacementProvider();
    const wrongContainerName = "agent-22222222-2222-4222-8222-222222222222";
    const wrongHandle = replacementIntentHandle();
    wrongHandle.sandboxId = wrongContainerName;
    wrongHandle.metadata = {
      ...wrongHandle.metadata,
      containerName: wrongContainerName,
      volumePath: "/data/agents/22222222-2222-4222-8222-222222222222",
    };
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(wrongHandle);
      return replacementHandle();
    });
    const persistIntent = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_INVALID" });
    expect(persistIntent).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("does not emit success when a provider omits both durable callback stages", async () => {
    const provider = replacementProvider();
    spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());
    const persistIntent = mock(async () => {});
    const persistCreated = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SANDBOX_REPLACEMENT_INTENT_NOT_COMPLETED" });
    expect(persistIntent).not.toHaveBeenCalled();
    expect(persistCreated).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("does not emit success when Docker create enrichment was omitted", async () => {
    const provider = replacementProvider();
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      return replacementHandle();
    });
    const persistIntent = mock(async () => {});
    const persistCreated = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      nodeId: NODE.node_id,
      containerId: null,
    });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CREATED_NOT_COMPLETED",
    });
    expect(persistIntent).toHaveBeenCalledTimes(1);
    expect(persistCreated).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("fails closed when immutable replacement identity drifts across callbacks", async () => {
    const provider = replacementProvider();
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      const created = replacementHandle();
      await config.onReplacementCreated?.({
        ...created,
        metadata: { ...created.metadata, nodeId: "node-drifted" },
      });
      return created;
    });
    const persistCreated = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      nodeId: NODE.node_id,
      containerId: null,
    });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_DRIFT",
      context: { stage: "created", driftedKey: "nodeId" },
    });
    expect(persistCreated).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("rewraps a created-callback typed error with the provider-validated locator", async () => {
    const provider = replacementProvider();
    const forged = new SandboxReplacementCleanupUnresolvedError(
      {
        sandboxId: "agent-forged",
        nodeId: "node-forged",
        containerName: "agent-forged",
        replacementAttemptId: "44444444-4444-4444-8444-444444444444",
        containerId: "b".repeat(64),
      },
      new Error("forged callback locator"),
    );
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      await config.onReplacementCreated?.(replacementHandle());
      return replacementHandle();
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {
            throw forged;
          },
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      nodeId: NODE.node_id,
      nodeRecordId: NODE.id,
      containerName: CONTAINER_NAME,
      containerId: CONTAINER_ID,
      replacementAttemptId: ATTEMPT_ID,
    });
    expect((error as Error).cause).toBe(forged);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("fails closed before a duplicate durable stage can replace its baseline", async () => {
    const provider = replacementProvider();
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      const created = replacementHandle();
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      await config.onReplacementCreated?.(created);
      await config.onReplacementCreated?.({
        ...created,
        metadata: { ...created.metadata, containerId: "b".repeat(64) },
      });
      return created;
    });
    const persistCreated = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({ containerId: CONTAINER_ID });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_STAGE_DUPLICATED",
      context: { stage: "created" },
    });
    expect(persistCreated).toHaveBeenCalledTimes(1);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("claims the intent stage before await so concurrent duplicates cannot replace it", async () => {
    const provider = replacementProvider();
    let releaseIntent!: () => void;
    const intentGate = new Promise<void>((resolve) => {
      releaseIntent = resolve;
    });
    const persistIntent = mock(async () => intentGate);
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      const canonical = replacementIntentHandle();
      const drifted = {
        ...canonical,
        metadata: { ...canonical.metadata, nodeId: "node-drifted" },
      };
      const first = config.onReplacementCreateIntent?.(canonical);
      const duplicate = config.onReplacementCreateIntent?.(drifted);
      releaseIntent();
      await Promise.all([first, duplicate]);
      return replacementHandle();
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({ nodeId: NODE.node_id, containerId: null });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_STAGE_DUPLICATED",
      context: { stage: "intent" },
    });
    expect(persistIntent).toHaveBeenCalledTimes(1);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("claims the created stage before await so concurrent duplicates cannot replace it", async () => {
    const provider = replacementProvider();
    let releaseCreated!: () => void;
    const createdGate = new Promise<void>((resolve) => {
      releaseCreated = resolve;
    });
    const persistCreated = mock(async () => createdGate);
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      const canonical = replacementHandle();
      const drifted = {
        ...canonical,
        metadata: { ...canonical.metadata, containerId: "b".repeat(64) },
      };
      const first = config.onReplacementCreated?.(canonical);
      const duplicate = config.onReplacementCreated?.(drifted);
      releaseCreated();
      await Promise.all([first, duplicate]);
      return canonical;
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({ containerId: CONTAINER_ID });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_STAGE_DUPLICATED",
      context: { stage: "created" },
    });
    expect(persistCreated).toHaveBeenCalledTimes(1);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("fails closed when the final Docker container ID drifts after enrichment", async () => {
    const provider = replacementProvider();
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      const created = replacementHandle();
      await completeRequiredReplacementStages(config, created);
      return {
        ...created,
        metadata: { ...created.metadata, containerId: "b".repeat(64) },
      };
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({ containerId: CONTAINER_ID });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CONTAINER_ID_DRIFT",
    });
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("rejects a non-canonical Docker ID before durable created enrichment", async () => {
    const provider = replacementProvider();
    const malformed = replacementHandle();
    malformed.metadata = { ...malformed.metadata, containerId: "not-a-docker-id" };
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(replacementIntentHandle());
      await config.onReplacementCreated?.(malformed);
      return malformed;
    });
    const persistCreated = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: persistCreated,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_INVALID",
      context: { stage: "created", callbackHasContainerId: true },
    });
    expect(persistCreated).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("rejects a replacement VPN identity that aliases the preserved live node", async () => {
    const provider = replacementProvider();
    const vpnTuple = {
      vpnNodeName: "replacement-11111111-111",
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      previousVpnNodeId: "1404",
    };
    const intent = replacementIntentHandle();
    intent.metadata = { ...intent.metadata, ...vpnTuple };
    const created = replacementHandle();
    created.metadata = { ...created.metadata, ...vpnTuple };
    const aliasedVpn = {
      ...created,
      metadata: { ...created.metadata, vpnNodeId: "1404" },
    };
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await config.onReplacementCreateIntent?.(intent);
      await config.onReplacementCreated?.(created);
      await config.onReplacementVpnRegistered?.(aliasedVpn);
      return aliasedVpn;
    });
    const persistVpn = mock(async () => {});
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementVpnRegistered: persistVpn,
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_CALLBACK_IDENTITY_INVALID",
      context: { stage: "vpn", callbackHasVpnNodeId: true },
    });
    expect(persistVpn).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("requires durable VPN enrichment and a stable VPN node ID before success", async () => {
    const vpnTuple = {
      vpnNodeName: "replacement-11111111-111",
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      previousVpnNodeId: PREVIOUS_VPN_NODE_ID,
    };
    const created = replacementHandle();
    const createdWithVpnTuple = {
      ...created,
      metadata: { ...created.metadata, ...vpnTuple },
    };
    const intentWithVpnTuple = replacementIntentHandle();
    intentWithVpnTuple.metadata = { ...intentWithVpnTuple.metadata, ...vpnTuple };

    for (const scenario of ["missing", "drifted"] as const) {
      const provider = replacementProvider();
      spyOn(
        provider as unknown as {
          _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
        },
        "_createOnce",
      ).mockImplementation(async (config) => {
        await config.onReplacementCreateIntent?.(intentWithVpnTuple);
        await config.onReplacementCreated?.(createdWithVpnTuple);
        if (scenario === "drifted") {
          await config.onReplacementVpnRegistered?.({
            ...createdWithVpnTuple,
            metadata: { ...createdWithVpnTuple.metadata, vpnNodeId: "1404" },
          });
        }
        return {
          ...createdWithVpnTuple,
          metadata: { ...createdWithVpnTuple.metadata, vpnNodeId: "1405" },
        };
      });
      const persistSuccess = mock(async () => {});

      const error = await provider
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: async () => {},
            onReplacementCreated: async () => {},
            ...(scenario === "drifted" ? { onReplacementVpnRegistered: async () => {} } : {}),
            onReplacementCreateSettled: persistSuccess,
          }),
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
      expect(error).toMatchObject({
        vpnNodeId: scenario === "missing" ? null : "1404",
      });
      expect((error as Error).cause).toMatchObject({
        code:
          scenario === "missing"
            ? "SANDBOX_REPLACEMENT_VPN_NOT_COMPLETED"
            : "SANDBOX_REPLACEMENT_VPN_NODE_ID_DRIFT",
      });
      expect(persistSuccess).not.toHaveBeenCalled();
    }
  });

  test("keeps the exact locator when successful create settlement persistence fails", async () => {
    const provider = replacementProvider();
    const providerHandle = replacementHandle();
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      await completeRequiredReplacementStages(config, providerHandle);
      return providerHandle;
    });
    const persistenceFailure = new Error("settlement database unavailable");

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {
            throw persistenceFailure;
          },
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCreateSettlementCleanupUnresolvedError);
    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      replacementAttemptId: ATTEMPT_ID,
      containerId: CONTAINER_ID,
      providerHandle,
      persistenceError: persistenceFailure,
      settlement: { replacementAttemptId: ATTEMPT_ID, outcome: "succeeded" },
    });
    expect((error as Error).cause).toBe(persistenceFailure);
  });

  test("starts before Steward and Headscale but emits no success for preparation failure", async () => {
    const events: string[] = [];
    const savedEnvironment = process.env.ENVIRONMENT;
    const savedHeadscaleApiKey = process.env.HEADSCALE_API_KEY;
    const savedFallback = process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
    const savedHeadscaleEndpoints = new Map(
      HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "production";
    process.env.HEADSCALE_API_KEY = "headscale-test-key";
    delete process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
    for (const key of HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS) delete process.env[key];

    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockImplementation(async () => {
      events.push("steward");
      return { tenantId: "tenant-test", isNew: false };
    });
    spyOn(headscaleIntegration, "prepareContainerVPN").mockImplementation(async () => {
      events.push("headscale-prepare");
      throw new Error("Headscale preauth unavailable");
    });
    const increment = spyOn(dockerNodesRepository, "incrementAllocated").mockResolvedValue();
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();
    const persistIntent = mock(async (handle: SandboxHandle) => {
      events.push("persist-intent");
      expect(handle.metadata).toMatchObject({
        replacementAttemptId: ATTEMPT_ID,
        nodeId: NODE.node_id,
        containerName: CONTAINER_NAME,
      });
      expect(handle.metadata).not.toHaveProperty("vpnNodeName");
      expect(handle.metadata).not.toHaveProperty("vpnRegistrationStartedAt");
    });
    const persistSettlement = mock(async (settlement: { outcome: string }) => {
      events.push(`settlement-${settlement.outcome}`);
    });
    const provider = replacementProvider();
    let failure: unknown;

    try {
      failure = await provider
        .create({
          agentId: "11111111-1111-4111-8111-111111111111",
          agentName: "Replacement",
          organizationId: "22222222-2222-4222-8222-222222222222",
          executionTier: "dedicated-always",
          environmentVars: {},
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async (started) => {
            events.push("attempt-started");
            expect(started).toEqual({ replacementAttemptId: ATTEMPT_ID });
            expect(Object.isFrozen(started)).toBe(true);
          },
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSettlement,
        })
        .catch((error: unknown) => error);
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
      for (const [key, value] of savedHeadscaleEndpoints) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((failure as Error).message).toContain("Headscale preauth unavailable");
    expect(events).toEqual(["attempt-started", "steward", "headscale-prepare"]);
    expect(persistIntent).not.toHaveBeenCalled();
    expect(persistSettlement).not.toHaveBeenCalled();
    expect(increment).not.toHaveBeenCalled();
    expect(decrement).not.toHaveBeenCalled();
  });

  test("refetches and rejects an unpinned DB node before candidate-specific work", async () => {
    const unpinnedNode = { ...NODE, host_key_fingerprint: null };
    const provider = replacementProvider();
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(unpinnedNode);
    const refetch = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(
      unpinnedNode,
    );
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const steward = spyOn(stewardTenantConfig, "ensureStewardTenant");
    const headscale = spyOn(headscaleIntegration, "prepareContainerVPN");
    const ssh = spyOn(DockerSSHClient, "getClient");
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_SUCCESS_SSH_PIN_REQUIRED",
      context: { nodeId: NODE.node_id },
    });
    expect(refetch).toHaveBeenCalledWith(NODE.id);
    expect(ports).not.toHaveBeenCalled();
    expect(steward).not.toHaveBeenCalled();
    expect(headscale).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("never adopts a replacement row when the selected record disappears during TOFU refetch", async () => {
    const selected = { ...NODE, host_key_fingerprint: null };
    const replacementRow = {
      ...NODE,
      id: "22222222-2222-4222-8222-222222222222",
      host_key_fingerprint: "SHA256:replacement-row",
    };
    const provider = replacementProvider();
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(selected);
    const primary = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(
      replacementRow,
    );
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const ssh = spyOn(DockerSSHClient, "getClient");

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: async () => {},
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_SUCCESS_SSH_PIN_REQUIRED",
      context: { nodeId: NODE.node_id, nodeRecordId: NODE.id },
    });
    expect(primary).toHaveBeenCalledWith(NODE.id);
    expect(ports).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("rejects the unpinned environment seed before reading or mutating it", async () => {
    const provider = replacementProvider();
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(null);
    const autoscale = spyOn(
      provider as unknown as {
        provisionAutoscaledNodeForAgent: () => Promise<null>;
      },
      "provisionAutoscaledNodeForAgent",
    ).mockResolvedValue(null);
    const findAll = spyOn(dockerNodesRepository, "findAll");
    const ports = spyOn(dockerPortAllocation, "getUsedDockerHostPorts");
    const steward = spyOn(stewardTenantConfig, "ensureStewardTenant");
    const headscale = spyOn(headscaleIntegration, "prepareContainerVPN");
    const ssh = spyOn(DockerSSHClient, "getClient");
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SANDBOX_EXACT_SUCCESS_SSH_PIN_REQUIRED",
      context: { nodeId: null },
    });
    expect(autoscale).toHaveBeenCalledTimes(1);
    expect(findAll).not.toHaveBeenCalled();
    expect(ports).not.toHaveBeenCalled();
    expect(steward).not.toHaveBeenCalled();
    expect(headscale).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("tracks autoscale provisioning failures and readiness timeouts", async () => {
    const savedToken = process.env.HCLOUD_TOKEN;
    const savedPublicKey = process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY;
    process.env.HCLOUD_TOKEN = "hcloud-test-token";
    process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY = "ssh-ed25519 test";
    const provider = replacementProvider();
    const provisionFailure = new Error("autoscale response lost");
    const getAutoscaler = spyOn(nodeAutoscaler, "getNodeAutoscaler");
    const internals = provider as unknown as {
      provisionAutoscaledNodeForAgent: (
        input: { image: string; platform?: string },
        tracker: { causes: unknown[] },
      ) => Promise<DockerNode | null>;
    };

    try {
      getAutoscaler.mockReturnValue({
        provisionNode: async () => {
          throw provisionFailure;
        },
      } as never);
      const failedTracker = { causes: [] as unknown[] };
      await expect(
        internals.provisionAutoscaledNodeForAgent({ image: "eliza-agent:test" }, failedTracker),
      ).resolves.toBeNull();
      expect(failedTracker.causes).toEqual([provisionFailure]);

      getAutoscaler.mockReturnValue({
        provisionNode: async () => ({
          nodeId: "autoscaled-node",
          hostname: "192.0.2.50",
        }),
      } as never);
      let nowCalls = 0;
      spyOn(Date, "now").mockImplementation(() => (nowCalls++ === 0 ? 0 : 300_000));
      const timeoutTracker = { causes: [] as unknown[] };
      await expect(
        internals.provisionAutoscaledNodeForAgent({ image: "eliza-agent:test" }, timeoutTracker),
      ).resolves.toBeNull();
      expect(timeoutTracker.causes).toHaveLength(1);
      expect(timeoutTracker.causes[0]).toMatchObject({
        code: "DOCKER_AUTOSCALE_READINESS_UNRESOLVED",
      });
    } finally {
      if (savedToken === undefined) delete process.env.HCLOUD_TOKEN;
      else process.env.HCLOUD_TOKEN = savedToken;
      if (savedPublicKey === undefined) delete process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY;
      else process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY = savedPublicKey;
    }
  });

  test("does not enter the provider or emit success when the start response is lost", async () => {
    const provider = replacementProvider();
    const createOnce = spyOn(
      provider as unknown as { _createOnce: () => Promise<SandboxHandle> },
      "_createOnce",
    ).mockResolvedValue(replacementHandle());
    const startFailure = new Error("attempt-start commit response lost");
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {
            throw startFailure;
          },
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBe(startFailure);
    expect(createOnce).not.toHaveBeenCalled();
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("keeps cleanup-intent persistence failure distinct before Docker create", async () => {
    const savedEnvironment = process.env.ENVIRONMENT;
    const savedHeadscaleApiKey = process.env.HEADSCALE_API_KEY;
    const savedFallback = process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
    const savedStewardApiUrl = process.env.STEWARD_API_URL;
    const savedHeadscaleEndpoints = new Map(
      HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "development";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    delete process.env.HEADSCALE_API_KEY;
    delete process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
    for (const key of HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS) delete process.env[key];

    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    const commands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        commands.push(command);
        return "";
      }),
      execStdin: mock(async (command: string) => {
        commands.push(command);
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const intentFailure = new Error("cleanup-intent commit response lost");
    const persistSuccess = mock(async () => {});

    let error: unknown;
    try {
      error = await replacementProvider()
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            dockerImage: "eliza-agent:test",
            environmentVars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
            },
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: async () => {
              throw intentFailure;
            },
            onReplacementCreated: async () => {},
            onReplacementCreateSettled: persistSuccess,
          }),
        )
        .catch((caught: unknown) => caught);
    } finally {
      if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = savedEnvironment;
      if (savedHeadscaleApiKey === undefined) delete process.env.HEADSCALE_API_KEY;
      else process.env.HEADSCALE_API_KEY = savedHeadscaleApiKey;
      if (savedFallback === undefined) delete process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
      else process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK = savedFallback;
      if (savedStewardApiUrl === undefined) delete process.env.STEWARD_API_URL;
      else process.env.STEWARD_API_URL = savedStewardApiUrl;
      for (const [key, value] of savedHeadscaleEndpoints) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({ name: "ReplacementPlacementPersistenceError" });
    expect((error as Error).cause).toBe(intentFailure);
    expect(commands.some((command) => command.includes("docker network inspect"))).toBe(true);
    expect(commands.some((command) => command.includes("docker create"))).toBe(false);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("emits no success for a Docker-create timeout after durable cleanup intent", async () => {
    const provider = replacementProvider();
    const dockerTimeout = new Error(
      "[docker-ssh] Command timed out after 25000ms: docker [redacted]",
    );
    spyOn(
      provider as unknown as {
        _createOnce: (config: SandboxCreateConfig) => Promise<SandboxHandle>;
      },
      "_createOnce",
    ).mockImplementation(async (config) => {
      const intent = replacementHandle();
      const { containerId: _containerId, ...intentMetadata } = intent.metadata ?? {};
      await config.onReplacementCreateIntent?.({ ...intent, metadata: intentMetadata });
      throw dockerTimeout;
    });
    const persistSuccess = mock(async () => {});

    const error = await provider
      .create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          onReplacementCreateAttemptStarted: async () => {},
          onReplacementCreateIntent: async () => {},
          onReplacementCreated: async () => {},
          onReplacementCreateSettled: persistSuccess,
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      replacementAttemptId: ATTEMPT_ID,
      nodeId: NODE.node_id,
      containerId: null,
    });
    expect((error as Error).cause).toBe(dockerTimeout);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("suppresses success when a swallowed remote pull remains ambiguous", async () => {
    const controlledEnvironment = [
      "ENVIRONMENT",
      "HEADSCALE_API_KEY",
      ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
      "STEWARD_API_URL",
      "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_CLOUD_SERVICE_TOKEN",
      "AGENT_TOKEN_SERVICE_TOKEN",
      "STEWARD_ENABLE_TRADE_PLUGIN",
    ] as const;
    const savedEnvironment = new Map(
      controlledEnvironment.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "development";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    for (const key of controlledEnvironment.filter(
      (key) => key !== "ENVIRONMENT" && key !== "STEWARD_API_URL",
    )) {
      delete process.env[key];
    }

    const pullFailure = new Error("docker pull response became ambiguous");
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    const ssh = {
      exec: mock(async (command: string) => {
        if (command.startsWith("docker pull")) throw pullFailure;
        return "";
      }),
      execStdin: mock(async (command: string) => {
        if (command.includes("docker create")) return CONTAINER_ID;
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const persistSuccess = mock(async () => {});

    let error: unknown;
    try {
      error = await replacementProvider()
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            dockerImage: "eliza-agent:test",
            environmentVars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
            },
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: async () => {},
            onReplacementCreated: async () => {},
            onReplacementCreateSettled: persistSuccess,
          }),
        )
        .catch((caught: unknown) => caught);
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      replacementAttemptId: ATTEMPT_ID,
      containerId: CONTAINER_ID,
    });
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(((error as Error).cause as AggregateError).errors).toContain(pullFailure);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("suppresses exact success when registry credential cleanup is ambiguous", async () => {
    const controlledEnvironment = [
      "ENVIRONMENT",
      "HEADSCALE_API_KEY",
      ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
      "STEWARD_API_URL",
      "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
      "CONTAINERS_REGISTRY_TOKEN",
      "ELIZA_APP_IMAGE_REGISTRY_TOKEN",
      "GHCR_TOKEN",
      "CONTAINERS_REGISTRY_TOKEN_FILE",
      "ELIZA_APP_IMAGE_REGISTRY_TOKEN_FILE",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_CLOUD_SERVICE_TOKEN",
      "AGENT_TOKEN_SERVICE_TOKEN",
      "STEWARD_ENABLE_TRADE_PLUGIN",
    ] as const;
    const savedEnvironment = new Map(
      controlledEnvironment.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "development";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    for (const key of controlledEnvironment.filter(
      (key) => key !== "ENVIRONMENT" && key !== "STEWARD_API_URL",
    )) {
      delete process.env[key];
    }

    const registryFailure = new Error("docker logout response became ambiguous");
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    const ssh = {
      exec: mock(async (command: string) => {
        if (command.startsWith("docker logout")) throw registryFailure;
        return "";
      }),
      execStdin: mock(async (command: string) => {
        if (command.includes("docker create")) return CONTAINER_ID;
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const persistSuccess = mock(async () => {});

    let error: unknown;
    try {
      error = await replacementProvider()
        .create(
          replacementCreateConfig({
            replacementAttemptId: ATTEMPT_ID,
            dockerImage: "ghcr.io/elizaos/eliza:test",
            environmentVars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
            },
            onReplacementCreateAttemptStarted: async () => {},
            onReplacementCreateIntent: async () => {},
            onReplacementCreated: async () => {},
            onReplacementCreateSettled: persistSuccess,
          }),
        )
        .catch((caught: unknown) => caught);
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(((error as Error).cause as AggregateError).errors).toContain(registryFailure);
    expect(persistSuccess).not.toHaveBeenCalled();
  });

  test("tracks unresolved or unknown Headscale rename completion only in exact mode", async () => {
    const controlledEnvironment = [
      "ENVIRONMENT",
      "HEADSCALE_API_KEY",
      ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
      "STEWARD_API_URL",
      "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_CLOUD_SERVICE_TOKEN",
      "AGENT_TOKEN_SERVICE_TOKEN",
      "STEWARD_ENABLE_TRADE_PLUGIN",
    ] as const;
    const savedEnvironment = new Map(
      controlledEnvironment.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "production";
    process.env.HEADSCALE_API_KEY = "headscale-test-key";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    for (const key of controlledEnvironment.filter(
      (key) => key !== "ENVIRONMENT" && key !== "HEADSCALE_API_KEY" && key !== "STEWARD_API_URL",
    )) {
      delete process.env[key];
    }

    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(dockerNodesRepository, "incrementAllocated").mockResolvedValue();
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    spyOn(headscaleIntegration, "prepareContainerVPN").mockResolvedValue({
      preAuthKey: "preauth-test",
      envVars: {
        HEADSCALE_URL: "https://headscale.example.test",
        TS_AUTHKEY: "preauth-test",
        TS_HOSTNAME: "replacement-11111111-111",
        TS_STATE_DIR: "/var/lib/tailscale",
        TS_EXTRA_ARGS: "--accept-routes",
      },
      previousNodeId: PREVIOUS_VPN_NODE_ID,
    });
    let renameCompletion: unknown;
    spyOn(headscaleIntegration, "waitForVPNRegistration").mockImplementation(
      async () =>
        ({
          ip: "100.64.0.42",
          nodeId: EXACT_VPN_NODE_ID,
          ...(renameCompletion === undefined ? {} : { rename: renameCompletion }),
        }) as never,
    );
    const ssh = {
      exec: mock(async (command: string) =>
        command.includes("tailscale --socket=/tmp/tailscaled.sock ip -4") ? "100.64.0.42\n" : "",
      ),
      execStdin: mock(async (command: string) => {
        if (command.includes("docker create")) return CONTAINER_ID;
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);

    try {
      const renameFailure = new Error("rename response was lost");
      for (const scenario of ["unresolved", "unknown"] as const) {
        renameCompletion =
          scenario === "unresolved" ? { outcome: "unresolved", cause: renameFailure } : undefined;
        const persistSuccess = mock(async () => {});
        const error = await replacementProvider()
          .create(
            replacementCreateConfig({
              replacementAttemptId: ATTEMPT_ID,
              dockerImage: "eliza-agent:test",
              environmentVars: {
                ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
              },
              reclaimStaleVpnNode: false,
              onReplacementCreateAttemptStarted: async () => {},
              onReplacementCreateIntent: async () => {},
              onReplacementCreated: async () => {},
              onReplacementVpnRegistered: async () => {},
              onReplacementCreateSettled: persistSuccess,
            }),
          )
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
        expect((error as Error).cause).toBeInstanceOf(AggregateError);
        const causes = ((error as Error).cause as AggregateError).errors;
        if (scenario === "unresolved") {
          expect(causes).toContain(renameFailure);
        } else {
          expect(
            causes.some(
              (cause: unknown) =>
                cause instanceof Error &&
                "code" in cause &&
                cause.code === "HEADSCALE_RENAME_COMPLETION_UNKNOWN",
            ),
          ).toBe(true);
        }
        expect(persistSuccess).not.toHaveBeenCalled();
      }

      renameCompletion = undefined;
      await expect(
        replacementProvider().create(
          replacementCreateConfig({
            dockerImage: "eliza-agent:test",
            environmentVars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
            },
            reclaimStaleVpnNode: false,
          }),
        ),
      ).resolves.toMatchObject({
        metadata: { vpnNodeId: EXACT_VPN_NODE_ID },
      });
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("settles the real exact provider path with Headscale disabled and no VPN callback", async () => {
    const controlledEnvironment = [
      "ENVIRONMENT",
      "HEADSCALE_API_KEY",
      ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
      "STEWARD_API_URL",
      "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_CLOUD_SERVICE_TOKEN",
      "AGENT_TOKEN_SERVICE_TOKEN",
      "STEWARD_ENABLE_TRADE_PLUGIN",
    ] as const;
    const savedEnvironment = new Map(
      controlledEnvironment.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "development";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    for (const key of controlledEnvironment.filter(
      (key) => key !== "ENVIRONMENT" && key !== "STEWARD_API_URL",
    )) {
      delete process.env[key];
    }

    const exactNode = { ...NODE, metadata: { environment: "development" } };
    const provider = replacementProvider();
    const targetRead = spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(
      exactNode,
    );
    const attest = spyOn(dockerNodesRepository, "attestNodeIncarnation").mockResolvedValue(
      exactNode,
    );
    const discovery = spyOn(dockerNodeManager, "getAvailableNode");
    const autoscale = spyOn(
      provider as unknown as {
        provisionAutoscaledNodeForAgent: () => Promise<DockerNode | null>;
      },
      "provisionAutoscaledNodeForAgent",
    );
    const findAll = spyOn(dockerNodesRepository, "findAll");
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    const updateStatus = spyOn(dockerNodesRepository, "updateStatus").mockResolvedValue();
    const increment = spyOn(dockerNodesRepository, "incrementAllocated");
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated");
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });
    const prepareVpn = spyOn(headscaleIntegration, "prepareContainerVPN").mockRejectedValue(
      new Error("Headscale must remain disabled"),
    );
    const waitForVpn = spyOn(headscaleIntegration, "waitForVPNRegistration").mockRejectedValue(
      new Error("Headscale must remain disabled"),
    );
    const commands: string[] = [];
    const ssh = {
      connect: mock(async () => {}),
      exec: mock(async (command: string) => {
        commands.push(command);
        if (command.startsWith("docker info --format")) return exactTargetReadinessProbe();
        if (command === "cat /proc/sys/kernel/random/boot_id") {
          return `${NODE_INCARNATION}\n`;
        }
        if (command.includes("docker inspect --format")) {
          return `${CONTAINER_ID}|${ATTEMPT_ID}|/${CONTAINER_NAME}|true\n`;
        }
        return "";
      }),
      execStdin: mock(async (command: string) => {
        commands.push(command);
        if (command.includes("docker create")) return CONTAINER_ID;
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const events: string[] = [];

    try {
      const handle = await provider.create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          exactDockerTarget: exactDockerTarget(),
          dockerImage: "eliza-agent:test",
          container: { memoryMb: 3_072 },
          environmentVars: {
            ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
          },
          onReplacementCreateAttemptStarted: async () => {
            events.push("started");
          },
          onReplacementCreateIntent: async (candidate) => {
            events.push("intent");
            expect(candidate.metadata?.containerId).toBeUndefined();
          },
          onReplacementCreated: async (candidate) => {
            events.push("created");
            expect(candidate.metadata?.containerId).toBe(CONTAINER_ID);
          },
          onReplacementCreateSettled: async () => {
            events.push("settled");
          },
        }),
      );

      expect(handle.metadata).toMatchObject({
        replacementAttemptId: ATTEMPT_ID,
        containerId: CONTAINER_ID,
        replacementSecretCleanupVersion: 1,
      });
      expect(handle.metadata?.vpnNodeId).toBeUndefined();
      expect(events).toEqual(["started", "intent", "created", "settled"]);
      expect(prepareVpn).not.toHaveBeenCalled();
      expect(waitForVpn).not.toHaveBeenCalled();
      const dockerCreateCommand = commands.find((command) => command.includes("docker create"));
      const dockerStartCommand = commands.find((command) => command.includes("docker start"));
      const finalProofCommand = commands.find((command) =>
        command.includes("docker inspect --format"),
      );
      for (const command of [dockerCreateCommand, dockerStartCommand, finalProofCommand]) {
        expect(command).toContain("observed_boot_id=$(cat '/proc/sys/kernel/random/boot_id'");
        expect(command).toContain(NODE_INCARNATION);
      }
      expect(dockerStartCommand).toContain(CONTAINER_ID);
      expect(finalProofCommand).toContain(CONTAINER_ID);
      expect(finalProofCommand).toContain("ai.elizaos.replacement-attempt");
      expect(finalProofCommand).toContain(".State.Running");
      expect(
        commands.some((command) =>
          command.includes("tailscale --socket=/tmp/tailscaled.sock ip -4"),
        ),
      ).toBe(false);
      expect(targetRead).toHaveBeenCalledTimes(3);
      expect(discovery).not.toHaveBeenCalled();
      expect(autoscale).not.toHaveBeenCalled();
      expect(findAll).not.toHaveBeenCalled();
      expect(attest).toHaveBeenCalledWith(
        expect.objectContaining({
          id: NODE.id,
          nodeId: NODE.node_id,
          expectedIncarnation: NODE_INCARNATION,
          observedIncarnation: NODE_INCARNATION,
        }),
      );
      expect(updateStatus).not.toHaveBeenCalled();
      expect(increment).not.toHaveBeenCalled();
      expect(decrement).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("never settles after an exact-node reboot or a stopped final candidate", async () => {
    const controlledEnvironment = [
      "ENVIRONMENT",
      "HEADSCALE_API_KEY",
      ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
      "STEWARD_API_URL",
      "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_CLOUD_SERVICE_TOKEN",
      "AGENT_TOKEN_SERVICE_TOKEN",
      "STEWARD_ENABLE_TRADE_PLUGIN",
    ] as const;
    const savedEnvironment = new Map(
      controlledEnvironment.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "development";
    process.env.STEWARD_API_URL = "https://steward.example.test";
    for (const key of controlledEnvironment.filter(
      (key) => key !== "ENVIRONMENT" && key !== "STEWARD_API_URL",
    )) {
      delete process.env[key];
    }

    const rebootedIncarnation = "55555555-5555-4555-8555-555555555555";
    const exactNode = {
      ...NODE,
      metadata: { architecture: "amd64", environment: "development" },
    };
    const provider = replacementProvider();
    spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(exactNode);
    spyOn(dockerNodesRepository, "attestNodeIncarnation").mockResolvedValue(exactNode);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    const increment = spyOn(dockerNodesRepository, "incrementAllocated");
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated");
    const updateStatus = spyOn(dockerNodesRepository, "updateStatus").mockResolvedValue();
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue({
      tenantId: "tenant-test",
      isNew: false,
    });

    let activeWindow: "before-create" | "before-start" | "after-start" | "stopped-after-start" =
      "before-create";
    let observedBoot = NODE_INCARNATION;
    const guardedStages = new Set<string>();
    const events: string[] = [];
    const hasExpectedBootFence = (command: string): boolean =>
      command.includes("observed_boot_id=$(cat '/proc/sys/kernel/random/boot_id'") &&
      command.includes(NODE_INCARNATION);
    const rejectOnReboot = (command: string, stage: string): void => {
      if (hasExpectedBootFence(command)) guardedStages.add(`${activeWindow}:${stage}`);
      if (hasExpectedBootFence(command) && observedBoot !== NODE_INCARNATION) {
        throw new Error(`ELIZA_REPLACEMENT_BOOT_ID_MISMATCH:${stage}`);
      }
    };
    const ssh = {
      connect: mock(async () => {}),
      exec: mock(async (command: string) => {
        if (command.startsWith("docker info --format")) return exactTargetReadinessProbe();
        if (command === "cat /proc/sys/kernel/random/boot_id") return `${observedBoot}\n`;
        if (command.includes("docker start")) {
          rejectOnReboot(command, "start");
          if (activeWindow === "after-start") observedBoot = rebootedIncarnation;
          return `${CONTAINER_ID}\n`;
        }
        if (command.includes("docker inspect --format")) {
          rejectOnReboot(command, "proof");
          const running = activeWindow === "stopped-after-start" ? "false" : "true";
          return `${CONTAINER_ID}|${ATTEMPT_ID}|/${CONTAINER_NAME}|${running}\n`;
        }
        return "";
      }),
      execStdin: mock(async (command: string) => {
        if (command.includes("docker create")) {
          rejectOnReboot(command, "create");
          return CONTAINER_ID;
        }
        if (command.includes("steward-agent-register")) {
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);

    try {
      for (const rebootWindow of [
        "before-create",
        "before-start",
        "after-start",
        "stopped-after-start",
      ] as const) {
        activeWindow = rebootWindow;
        observedBoot = NODE_INCARNATION;
        events.length = 0;
        const persistSuccess = mock(async () => {
          events.push("settled");
        });

        const error = await provider
          .create(
            replacementCreateConfig({
              replacementAttemptId: ATTEMPT_ID,
              exactDockerTarget: exactDockerTarget(),
              dockerImage: "eliza-agent:test",
              container: { memoryMb: 3_072 },
              environmentVars: {
                ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
              },
              onReplacementCreateAttemptStarted: async () => {
                events.push("started");
              },
              onReplacementCreateIntent: async () => {
                events.push("intent");
                if (rebootWindow === "before-create") observedBoot = rebootedIncarnation;
              },
              onReplacementCreated: async () => {
                events.push("created");
                if (rebootWindow === "before-start") observedBoot = rebootedIncarnation;
              },
              onReplacementCreateSettled: persistSuccess,
            }),
          )
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
        expect(persistSuccess).not.toHaveBeenCalled();
        expect(events[0]).toBe("started");
        expect(events).toContain("intent");
        expect(events).not.toContain("settled");
      }

      expect(guardedStages).toEqual(
        new Set([
          "before-create:create",
          "before-start:create",
          "before-start:start",
          "after-start:create",
          "after-start:start",
          "after-start:proof",
          "stopped-after-start:create",
          "stopped-after-start:start",
          "stopped-after-start:proof",
        ]),
      );
      expect(updateStatus).not.toHaveBeenCalled();
      expect(increment).not.toHaveBeenCalled();
      expect(decrement).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("binds one exact attempt through intent, Docker label, enrichments, handle, and settlement", async () => {
    const controlledEnvironment = [
      "ENVIRONMENT",
      "HEADSCALE_API_KEY",
      ...HEADSCALE_ENDPOINT_ENVIRONMENT_KEYS,
      "STEWARD_API_URL",
      "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM",
      "ELIZA_CLOUD_SERVICE_TOKEN",
      "AGENT_TOKEN_SERVICE_TOKEN",
      "STEWARD_ENABLE_TRADE_PLUGIN",
    ] as const;
    const savedEnvironment = new Map(
      controlledEnvironment.map((key) => [key, process.env[key]] as const),
    );
    process.env.ENVIRONMENT = "production";
    process.env.HEADSCALE_API_KEY = "headscale-test-key";
    for (const key of controlledEnvironment.filter(
      (key) => key !== "ENVIRONMENT" && key !== "HEADSCALE_API_KEY",
    )) {
      delete process.env[key];
    }
    process.env.STEWARD_API_URL = "https://steward.example.test";

    const events: string[] = [];
    const callbackHandles: SandboxHandle[] = [];
    let strictCleanupIdentity:
      | {
          sandboxId: string;
          nodeId: unknown;
          nodeRecordId: unknown;
          nodeHostname: unknown;
          nodeSshPort: unknown;
          nodeSshUser: unknown;
          nodeHostKeyFingerprint: unknown;
          replacementSecretCleanupVersion: unknown;
          containerName: unknown;
          replacementAttemptId: unknown;
          vpnNodeName: unknown;
          previousVpnNodeId: unknown;
          vpnRegistrationStartedAt: unknown;
          allocationCounted: unknown;
          containerId: unknown;
          vpnNodeId: unknown;
        }
      | undefined;
    const persistStrictCleanupStage = async (
      stage: "intent" | "created" | "vpn",
      candidate: SandboxHandle,
    ): Promise<void> => {
      const metadata = candidate.metadata ?? {};
      const incoming = {
        sandboxId: candidate.sandboxId,
        nodeId: metadata.nodeId,
        nodeRecordId: metadata.nodeRecordId,
        nodeHostname: metadata.hostname,
        nodeSshPort: metadata.nodeSshPort,
        nodeSshUser: metadata.nodeSshUser,
        nodeHostKeyFingerprint: metadata.nodeHostKeyFingerprint,
        replacementSecretCleanupVersion: metadata.replacementSecretCleanupVersion,
        containerName: metadata.containerName,
        replacementAttemptId: metadata.replacementAttemptId,
        vpnNodeName: metadata.vpnNodeName ?? null,
        previousVpnNodeId: metadata.previousVpnNodeId ?? null,
        vpnRegistrationStartedAt: metadata.vpnRegistrationStartedAt ?? null,
        allocationCounted: metadata.allocationCounted,
        containerId: metadata.containerId ?? null,
        vpnNodeId: metadata.vpnNodeId ?? null,
      };
      if (strictCleanupIdentity) {
        for (const key of [
          "sandboxId",
          "nodeId",
          "nodeRecordId",
          "nodeHostname",
          "nodeSshPort",
          "nodeSshUser",
          "nodeHostKeyFingerprint",
          "replacementSecretCleanupVersion",
          "containerName",
          "replacementAttemptId",
          "vpnNodeName",
          "previousVpnNodeId",
          "vpnRegistrationStartedAt",
          "allocationCounted",
        ] as const) {
          if (strictCleanupIdentity[key] !== incoming[key]) {
            throw new Error(`strict cleanup identity changed at ${stage}: ${key}`);
          }
        }
        if (
          strictCleanupIdentity.containerId !== null &&
          incoming.containerId !== strictCleanupIdentity.containerId
        ) {
          throw new Error(`strict Docker identity changed at ${stage}`);
        }
        if (
          strictCleanupIdentity.vpnNodeId !== null &&
          incoming.vpnNodeId !== strictCleanupIdentity.vpnNodeId
        ) {
          throw new Error(`strict VPN identity changed at ${stage}`);
        }
        strictCleanupIdentity = {
          ...incoming,
          containerId: strictCleanupIdentity.containerId ?? incoming.containerId,
          vpnNodeId: strictCleanupIdentity.vpnNodeId ?? incoming.vpnNodeId,
        };
      } else {
        strictCleanupIdentity = incoming;
      }
      events.push(`persist-${stage}`);
      callbackHandles.push(candidate);
    };
    let dockerCreateCommand = "";
    spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    spyOn(dockerPortAllocation, "getUsedDockerHostPorts").mockResolvedValue(new Set());
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockImplementation(async () => {
      events.push("steward");
      return { tenantId: "tenant-test", isNew: false };
    });
    spyOn(headscaleIntegration, "prepareContainerVPN").mockImplementation(async () => {
      events.push("headscale-prepare");
      return {
        preAuthKey: "preauth-test",
        envVars: {
          HEADSCALE_URL: "https://headscale.example.test",
          TS_AUTHKEY: "preauth-test",
          TS_HOSTNAME: "replacement-11111111-111",
          TS_STATE_DIR: "/var/lib/tailscale",
          TS_EXTRA_ARGS: "--accept-routes",
        },
        previousNodeId: PREVIOUS_VPN_NODE_ID,
      };
    });
    spyOn(headscaleIntegration, "waitForVPNRegistration").mockImplementation(async () => {
      events.push("vpn-registration");
      return {
        ip: "100.64.0.42",
        nodeId: EXACT_VPN_NODE_ID,
        rename: { outcome: "succeeded" },
      };
    });
    const ssh = {
      exec: mock(async (command: string) => {
        if (command.includes("docker network inspect")) events.push("network-ready");
        if (command.startsWith("docker start")) events.push("docker-start");
        if (command.includes("tailscale --socket=/tmp/tailscaled.sock ip -4")) {
          events.push("tailnet-bound");
          return "100.64.0.42\n";
        }
        return "";
      }),
      execStdin: mock(async (command: string) => {
        if (command.includes("docker create")) {
          events.push("docker-create");
          dockerCreateCommand = command;
          return CONTAINER_ID;
        }
        if (command.includes("steward-agent-register")) {
          events.push("steward-register");
          return JSON.stringify({ token: "steward-token" });
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockImplementation(() => {
      events.push("ssh-client");
      return ssh as unknown as DockerSSHClient;
    });
    const provider = replacementProvider({ now: () => Date.parse(REGISTRATION_STARTED_AT) });

    let handle: SandboxHandle;
    try {
      handle = await provider.create(
        replacementCreateConfig({
          replacementAttemptId: ATTEMPT_ID,
          dockerImage: "eliza-agent:test",
          environmentVars: {
            ELIZAOS_CLOUD_BASE_URL: "https://api.example.test/api/v1",
          },
          reclaimStaleVpnNode: false,
          onReplacementCreateAttemptStarted: async (started) => {
            events.push("attempt-started");
            expect(started).toEqual({ replacementAttemptId: ATTEMPT_ID });
            expect(Object.isFrozen(started)).toBe(true);
          },
          onReplacementCreateIntent: async (intentHandle) => {
            await persistStrictCleanupStage("intent", intentHandle);
          },
          onReplacementCreated: async (createdHandle) => {
            await persistStrictCleanupStage("created", createdHandle);
          },
          onReplacementVpnRegistered: async (vpnHandle) => {
            await persistStrictCleanupStage("vpn", vpnHandle);
          },
          onReplacementCreateSettled: async (settlement) => {
            events.push(`settlement-${settlement.outcome}`);
            expect(settlement.replacementAttemptId).toBe(ATTEMPT_ID);
            expect(Object.isFrozen(settlement)).toBe(true);
          },
        }),
      );
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(events[0]).toBe("attempt-started");
    expect(events.indexOf("attempt-started")).toBeLessThan(events.indexOf("steward"));
    expect(events.indexOf("attempt-started")).toBeLessThan(events.indexOf("headscale-prepare"));
    expect(events.indexOf("attempt-started")).toBeLessThan(events.indexOf("ssh-client"));
    expect(events.indexOf("headscale-prepare")).toBeLessThan(events.indexOf("persist-intent"));
    expect(events.indexOf("steward-register")).toBeLessThan(events.indexOf("persist-intent"));
    expect(events.indexOf("network-ready")).toBeLessThan(events.indexOf("persist-intent"));
    expect(events.indexOf("persist-intent")).toBeLessThan(events.indexOf("docker-create"));
    expect(events.indexOf("persist-created")).toBeLessThan(events.indexOf("docker-start"));
    expect(events.indexOf("vpn-registration")).toBeLessThan(events.indexOf("tailnet-bound"));
    expect(events.indexOf("tailnet-bound")).toBeLessThan(events.indexOf("persist-vpn"));
    expect(events.at(-1)).toBe("settlement-succeeded");
    expect(dockerCreateCommand).toContain(`ai.elizaos.replacement-attempt=${ATTEMPT_ID}`);
    expect(callbackHandles).toHaveLength(3);
    expect(callbackHandles.map((candidate) => candidate.metadata?.replacementAttemptId)).toEqual([
      ATTEMPT_ID,
      ATTEMPT_ID,
      ATTEMPT_ID,
    ]);
    expect(callbackHandles[0]?.metadata).toMatchObject({
      vpnNodeName: "replacement-11111111-111",
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      previousVpnNodeId: PREVIOUS_VPN_NODE_ID,
    });
    expect(callbackHandles[1]?.metadata).toMatchObject({
      containerId: CONTAINER_ID,
      vpnNodeName: "replacement-11111111-111",
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      previousVpnNodeId: PREVIOUS_VPN_NODE_ID,
    });
    expect(callbackHandles[2]?.metadata).toMatchObject({
      containerId: CONTAINER_ID,
      vpnNodeId: EXACT_VPN_NODE_ID,
      replacementAttemptId: ATTEMPT_ID,
    });
    expect(handle.metadata).toMatchObject({
      containerId: CONTAINER_ID,
      vpnNodeId: EXACT_VPN_NODE_ID,
      replacementAttemptId: ATTEMPT_ID,
    });
    expect(strictCleanupIdentity).toMatchObject({
      nodeRecordId: NODE.id,
      nodeHostname: NODE.hostname,
      nodeSshPort: NODE.ssh_port,
      nodeSshUser: NODE.ssh_user,
      nodeHostKeyFingerprint: NODE.host_key_fingerprint,
      replacementSecretCleanupVersion: 1,
      replacementAttemptId: ATTEMPT_ID,
      containerId: CONTAINER_ID,
      vpnNodeId: EXACT_VPN_NODE_ID,
      vpnNodeName: "replacement-11111111-111",
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
    });
  });

  test("verifies attempt label and id before exact-node cleanup without releasing capacity", async () => {
    const { primary: findNode } = stubNodeLookup();
    const { bootCheckCommands, commands, secretCleanupCommands } = stubSsh(async (command) => {
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
      "1442",
      replacementIdentity(),
    );

    expect(findNode).toHaveBeenCalledWith(NODE.id);
    expect(bootCheckCommands).toHaveLength(2);
    expect(commands[0]).toContain("docker inspect --format");
    expect(commands[0]).toContain(CONTAINER_ID);
    expect(commands[1]).toContain(`docker stop -t 10 '${CONTAINER_ID}'`);
    expect(commands[2]).toContain(`docker rm -f '${CONTAINER_ID}'`);
    expect(commands[1]).toContain("ELIZA_REPLACEMENT_BOOT_ID_MISMATCH");
    expect(commands[2]).toContain("ELIZA_REPLACEMENT_BOOT_ID_MISMATCH");
    expect(secretCleanupCommands[0]).toContain("ELIZA_REPLACEMENT_BOOT_ID_MISMATCH");
    expect(deleteVpn).toHaveBeenCalledWith("1442");
    expect(decrement).not.toHaveBeenCalled();
  });

  test("retires an exact post-cutover primary without candidate secret cleanup", async () => {
    const { primary: findNode } = stubNodeLookup();
    const { commands, candidateObservationCommands, secretCleanupCommands } = stubSsh(
      async (command) => {
        if (command.startsWith("docker inspect")) {
          return inspectLine(CONTAINER_ID, "");
        }
        return "";
      },
    );
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();

    await replacementProvider().stopOnSpecificNodeForReplacement(
      NODE.node_id,
      CONTAINER_NAME,
      null,
      postCutoverPrimaryIdentity(),
    );

    expect(findNode).toHaveBeenCalledWith(NODE.id);
    expect(secretCleanupCommands).toEqual([]);
    expect(candidateObservationCommands).toEqual([]);
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain(`docker inspect --format`);
    expect(commands[0]).toContain(`'${CONTAINER_ID}'`);
    expect(commands[1]).toContain(`docker stop -t 10 '${CONTAINER_ID}'`);
    expect(commands[2]).toContain(`docker rm -f '${CONTAINER_ID}'`);
    expect(commands.every((command) => !command.includes(`'${CONTAINER_NAME}'`))).toBe(true);
    expect(decrement).not.toHaveBeenCalled();
  });

  test("never targets a same-name successor when the published primary disappears after stop", async () => {
    stubNodeLookup();
    const successorContainerId = "b".repeat(64);
    let oldContainerPresent = true;
    let successorOwnsName = false;
    const destructiveDockerCommands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        if (command === REPLACEMENT_BOOT_ID_READ_COMMAND) return `${NODE_INCARNATION}\n`;
        if (command.startsWith("docker inspect")) {
          expect(command).toContain(`'${CONTAINER_ID}'`);
          return inspectLine(CONTAINER_ID, "");
        }
        if (command.includes("docker stop")) {
          destructiveDockerCommands.push(command);
          expect(command).toContain(`docker stop -t 10 '${CONTAINER_ID}'`);
          oldContainerPresent = false;
          successorOwnsName = true;
          return "";
        }
        if (command.includes("docker rm")) {
          destructiveDockerCommands.push(command);
          expect(successorOwnsName).toBe(true);
          expect(command).toContain(`docker rm -f '${CONTAINER_ID}'`);
          expect(command).not.toContain(successorContainerId);
          if (!oldContainerPresent) {
            throw new Error(`Error response from daemon: No such container: ${CONTAINER_ID}`);
          }
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);

    await expect(
      replacementProvider().stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        postCutoverPrimaryIdentity(),
      ),
    ).resolves.toBeUndefined();

    expect(destructiveDockerCommands).toHaveLength(2);
    expect(
      destructiveDockerCommands.every(
        (command) =>
          command.includes(`'${CONTAINER_ID}'`) &&
          !command.includes(`'${CONTAINER_NAME}'`) &&
          !command.includes(successorContainerId),
      ),
    ).toBe(true);
  });

  test("rejects post-cutover cleanup without a published full Docker id before SSH", async () => {
    stubNodeLookup();

    for (const containerId of [null, CONTAINER_ID.slice(0, 12)]) {
      const ssh = spyOn(DockerSSHClient, "getClient");
      const error = await replacementProvider()
        .stopOnSpecificNodeForReplacement(
          NODE.node_id,
          CONTAINER_NAME,
          null,
          postCutoverPrimaryIdentity(containerId),
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
      expect((error as Error).cause).toMatchObject({
        code: "SANDBOX_REPLACEMENT_NODE_AUTHORITY_INVALID",
      });
      expect(ssh).not.toHaveBeenCalled();
      mock.restore();
      stubNodeLookup();
    }
  });

  test("fails unresolved before Docker or Headscale mutation when SSH boot differs from DB", async () => {
    stubNodeLookup();
    const remoteCommands: string[] = [];
    const differentBootId = "99999999-9999-4999-8999-999999999999";
    spyOn(DockerSSHClient, "getClient").mockReturnValue({
      exec: mock(async (command: string) => {
        remoteCommands.push(command);
        if (command === REPLACEMENT_BOOT_ID_READ_COMMAND) return `${differentBootId}\n`;
        throw new Error("unexpected remote mutation");
      }),
    } as unknown as DockerSSHClient);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();

    const error = await replacementProvider()
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        EXACT_VPN_NODE_ID,
        replacementIdentity(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_REMOTE_NODE_INCARNATION_MISMATCH",
    });
    expect(remoteCommands).toEqual([REPLACEMENT_BOOT_ID_READ_COMMAND]);
    expect(remoteCommands.some((command) => /docker (stop|rm)/.test(command))).toBe(false);
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("fences rm independently when the node reboots after a successful stop", async () => {
    stubNodeLookup();
    let remoteBootId = NODE_INCARNATION;
    const executedDockerMutations: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        if (command === REPLACEMENT_BOOT_ID_READ_COMMAND) return `${remoteBootId}\n`;
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          return `${getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID)}\n`;
        }
        if (command.startsWith("docker inspect")) return inspectLine(CONTAINER_ID, ATTEMPT_ID);
        if (command.includes("docker stop")) {
          expect(command).toContain("ELIZA_REPLACEMENT_BOOT_ID_MISMATCH");
          expect(remoteBootId).toBe(NODE_INCARNATION);
          executedDockerMutations.push("stop");
          remoteBootId = "99999999-9999-4999-8999-999999999999";
          return "";
        }
        if (command.includes("docker rm")) {
          expect(command).toContain("ELIZA_REPLACEMENT_BOOT_ID_MISMATCH");
          if (remoteBootId !== NODE_INCARNATION) {
            throw new Error("ELIZA_REPLACEMENT_BOOT_ID_MISMATCH");
          }
          executedDockerMutations.push("rm");
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();

    await expect(
      replacementProvider().stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        EXACT_VPN_NODE_ID,
        replacementIdentity(),
      ),
    ).rejects.toThrow("ELIZA_REPLACEMENT_BOOT_ID_MISMATCH");

    expect(executedDockerMutations).toEqual(["stop"]);
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("rejects a malformed secret-cleanup receipt before inspecting Docker or mutating Headscale", async () => {
    stubNodeLookup();
    const commands: string[] = [];
    spyOn(DockerSSHClient, "getClient").mockReturnValue({
      exec: mock(async (command: string) => {
        if (command === REPLACEMENT_BOOT_ID_READ_COMMAND) return `${NODE_INCARNATION}\n`;
        commands.push(command);
        return "unexpected-output\n";
      }),
    } as unknown as DockerSSHClient);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();

    const error = await replacementProvider()
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        EXACT_VPN_NODE_ID,
        replacementIdentity(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toContain("receipt was missing or malformed");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("ELIZA_REPLACEMENT_SECRET_PURGED_V1");
    expect(commands[0]).not.toContain("docker inspect");
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("retains the fence when exact Headscale deletion does not make node 1404 absent", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => {
      throw new Error(`Error response from daemon: No such container: ${CONTAINER_NAME}`);
    });
    const survivingNode = headscaleNode(
      EXACT_VPN_NODE_ID,
      "agent-replacement",
      "2026-07-23T00:05:02.000Z",
    );
    spyOn(headscaleClient, "listNodesStrict").mockResolvedValue([survivingNode]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();

    const error = await replacementProvider()
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        EXACT_VPN_NODE_ID,
        replacementIdentity(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toContain(
      `Cannot prove Headscale node ${EXACT_VPN_NODE_ID} absent`,
    );
    expect(commands).toHaveLength(1);
    expect(deleteVpn).toHaveBeenCalledWith(EXACT_VPN_NODE_ID);
  });

  test("rejects exact node-record ABA or SSH tuple drift before opening SSH", async () => {
    for (const authoritativeNode of [
      null,
      { ...NODE, id: "55555555-5555-4555-8555-555555555555" },
      { ...NODE, node_id: "node-reused-by-sibling" },
      { ...NODE, node_incarnation: "66666666-6666-4666-8666-666666666666" },
      { ...NODE, current_node_history_id: "77777777-7777-4777-8777-777777777777" },
      { ...NODE, hostname: "192.0.2.99" },
      { ...NODE, ssh_port: 2222 },
      { ...NODE, ssh_user: "operator" },
      { ...NODE, host_key_fingerprint: "SHA256:rotated-key" },
    ]) {
      const provider = replacementProvider();
      spyOn(dockerNodesRepository, "findByIdOnPrimary").mockResolvedValue(authoritativeNode);
      const ssh = spyOn(DockerSSHClient, "getClient");

      const error = await provider
        .stopOnSpecificNodeForReplacement(
          NODE.node_id,
          CONTAINER_NAME,
          null,
          replacementIdentity({ vpnNodeName: null, previousVpnNodeId: null }),
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
      expect((error as Error).cause).toMatchObject({
        code:
          authoritativeNode === null
            ? "SANDBOX_REPLACEMENT_NODE_AUTHORITY_MISSING"
            : "SANDBOX_REPLACEMENT_NODE_AUTHORITY_DRIFT",
      });
      expect(ssh).not.toHaveBeenCalled();
      mock.restore();
    }
  });

  test("rejects malformed exact replay identities before SSH or Headscale mutation", async () => {
    const cases: Array<{
      identity: ReturnType<typeof replacementIdentity>;
      vpnNodeId: string | null;
    }> = [
      { identity: replacementIdentity({ containerId: "" }), vpnNodeId: null },
      {
        identity: replacementIdentity({
          vpnNodeName: null,
          previousVpnNodeId: PREVIOUS_VPN_NODE_ID,
        }),
        vpnNodeId: null,
      },
      {
        identity: replacementIdentity({ vpnRegistrationStartedAt: "not-a-date" }),
        vpnNodeId: null,
      },
      { identity: replacementIdentity(), vpnNodeId: PREVIOUS_VPN_NODE_ID },
      { identity: replacementIdentity({ containerId: null }), vpnNodeId: EXACT_VPN_NODE_ID },
    ];

    for (const testCase of cases) {
      const provider = replacementProvider();
      const ssh = spyOn(DockerSSHClient, "getClient");
      const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();

      const error = await provider
        .stopOnSpecificNodeForReplacement(
          NODE.node_id,
          CONTAINER_NAME,
          testCase.vpnNodeId,
          testCase.identity,
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
      expect((error as Error).cause).toMatchObject({
        code: "SANDBOX_REPLACEMENT_NODE_AUTHORITY_INVALID",
      });
      expect(ssh).not.toHaveBeenCalled();
      expect(deleteVpn).not.toHaveBeenCalled();
      mock.restore();
    }
  });

  test("refuses legacy nodeId-only cleanup before lookup, SSH, or remote mutation", async () => {
    const legacyLookup = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(NODE);
    const ssh = spyOn(DockerSSHClient, "getClient");

    const error = await replacementProvider()
      .stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, {
        replacementAttemptId: ATTEMPT_ID,
        containerId: CONTAINER_ID,
        allocationCounted: true,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_NODE_AUTHORITY_INVALID",
    });
    expect(legacyLookup).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  test("refuses a same-name label mismatch inside the converge grace window", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => inspectLine(CONTAINER_ID, "another-attempt"));
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider({
      now: () => CONTAINER_CREATED_AT_MS + 30 * 60 * 1000,
    });

    const error = await provider
      .stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, "1443", replacementIdentity())
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
      .stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, "1445", replacementIdentity())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(commands).toHaveLength(1);
    expect(deleteVpn).not.toHaveBeenCalled();
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
        "1447",
        replacementIdentity(),
      ),
    ).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(deleteVpn).toHaveBeenCalledWith("1447");
  });

  test("keeps an exact id-less fence unresolved when Docker reports absence", async () => {
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
        null,
        replacementIdentity({ containerId: null, vpnNodeName: null }),
      ),
    ).rejects.toThrow("Cannot prove id-less replacement");

    expect(commands).toHaveLength(1);
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("settles a pre-ID exact absence with VPN configured only when Docker is durably quiescent", async () => {
    stubNodeLookup();
    const commands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        if (command === REPLACEMENT_BOOT_ID_READ_COMMAND) return `${NODE_INCARNATION}\n`;
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          return `${getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID)}\n${getReplacementDockerCreateQuiescentReceipt(ATTEMPT_ID)}\n`;
        }
        commands.push(command);
        throw new Error(`Error: No such object: ${CONTAINER_NAME}`);
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ containerId: null }),
      ),
    ).resolves.toBeUndefined();

    expect(commands).toHaveLength(1);
  });

  test("retires the exact labeled candidate before settling an id-less fence", async () => {
    stubNodeLookup();
    const { candidateObservationCommands, commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        return inspectLine(CONTAINER_ID, ATTEMPT_ID);
      }
      return "";
    });
    const provider = replacementProvider();

    await expect(
      provider.stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        replacementIdentity({ containerId: null, vpnNodeName: null }),
      ),
    ).resolves.toBeUndefined();

    expect(commands).toHaveLength(3);
    expect(candidateObservationCommands).toHaveLength(1);
    expect(candidateObservationCommands[0]).toContain("ELIZA_REPLACEMENT_BOOT_ID_MISMATCH");
    expect(commands[1]).toContain(`docker stop -t 10 '${CONTAINER_ID}'`);
    expect(commands[2]).toContain(`docker rm -f '${CONTAINER_ID}'`);
  });

  test("replays an exact id-less cleanup after its first successful removal", async () => {
    stubNodeLookup();
    let candidateObserved = false;
    let candidatePresent = true;
    const inspectCommands: string[] = [];
    const stopCommands: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        if (command === REPLACEMENT_BOOT_ID_READ_COMMAND) return `${NODE_INCARNATION}\n`;
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          return [
            getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID),
            ...(candidateObserved
              ? [getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID)]
              : []),
          ].join("\n");
        }
        if (command.includes("ELIZA_REPLACEMENT_CANDIDATE_OBSERVED_V1")) {
          candidateObserved = true;
          return getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID);
        }
        if (command.startsWith("docker inspect")) {
          inspectCommands.push(command);
          if (!candidatePresent) {
            throw new Error(`Error: No such object: ${CONTAINER_ID}`);
          }
          return inspectLine(CONTAINER_ID, ATTEMPT_ID);
        }
        if (command.includes("docker stop")) {
          stopCommands.push(command);
          return "";
        }
        if (command.includes("docker rm")) {
          stopCommands.push(command);
          candidatePresent = false;
          return "";
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const provider = replacementProvider();
    const identity = replacementIdentity({ containerId: null, vpnNodeName: null });

    await expect(
      provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
    ).resolves.toBeUndefined();
    await expect(
      provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
    ).resolves.toBeUndefined();

    expect(inspectCommands).toHaveLength(2);
    expect(inspectCommands[0]).toContain(CONTAINER_NAME);
    expect(inspectCommands[1]).toContain(CONTAINER_ID);
    expect(stopCommands[0]).toContain(`docker stop -t 10 '${CONTAINER_ID}'`);
    expect(stopCommands[1]).toContain(`docker rm -f '${CONTAINER_ID}'`);
  });

  test("converges when an active id-less create materializes after the first cleanup", async () => {
    stubNodeLookup();
    let candidateObserved = false;
    let candidatePresent = false;
    const inspectTargets: string[] = [];
    const lifecycleCommands: string[] = [];
    const retirementEvents: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        if (command === REPLACEMENT_BOOT_ID_READ_COMMAND) return `${NODE_INCARNATION}\n`;
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          return [
            getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID),
            ...(candidateObserved
              ? [getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID)]
              : []),
          ].join("\n");
        }
        if (command.includes("ELIZA_REPLACEMENT_CANDIDATE_OBSERVED_V1")) {
          candidateObserved = true;
          retirementEvents.push("observe");
          return getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID);
        }
        if (command.startsWith("docker inspect")) {
          const target = command.includes(`'${CONTAINER_ID}'`) ? CONTAINER_ID : CONTAINER_NAME;
          inspectTargets.push(target);
          if (!candidatePresent) throw new Error(`Error: No such object: ${target}`);
          return inspectLine(CONTAINER_ID, ATTEMPT_ID);
        }
        if (command.includes("docker stop")) {
          retirementEvents.push("stop");
          lifecycleCommands.push(command);
          return "";
        }
        if (command.includes("docker rm")) {
          retirementEvents.push("rm");
          lifecycleCommands.push(command);
          candidatePresent = false;
          return "";
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const provider = replacementProvider();
    const identity = replacementIdentity({ containerId: null, vpnNodeName: null });

    await expect(
      provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
    ).rejects.toThrow("Cannot prove id-less replacement");

    candidatePresent = true;
    await expect(
      provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
    ).resolves.toBeUndefined();
    await expect(
      provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
    ).resolves.toBeUndefined();

    expect(candidateObserved).toBe(true);
    expect(inspectTargets).toEqual([CONTAINER_NAME, CONTAINER_NAME, CONTAINER_ID]);
    expect(retirementEvents).toEqual(["observe", "stop", "rm"]);
    expect(lifecycleCommands[0]).toContain(`docker stop -t 10 '${CONTAINER_ID}'`);
    expect(lifecycleCommands[1]).toContain(`docker rm -f '${CONTAINER_ID}'`);
  });

  test("recovers an observation-marker response loss before or after commit", async () => {
    stubNodeLookup();
    let mode: "before-commit" | "after-commit" = "before-commit";
    let candidateObserved = false;
    let candidatePresent = true;
    let markerWrites = 0;
    let failNextMarkerWrite = true;
    const inspectTargets: string[] = [];
    const ssh = {
      exec: mock(async (command: string) => {
        if (command === REPLACEMENT_BOOT_ID_READ_COMMAND) return `${NODE_INCARNATION}\n`;
        if (command.includes("ELIZA_REPLACEMENT_SECRET_PURGED_V1")) {
          return [
            getReplacementSecretArtifactsCleanupReceipt(ATTEMPT_ID),
            ...(candidateObserved
              ? [getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID)]
              : []),
          ].join("\n");
        }
        if (command.includes("ELIZA_REPLACEMENT_CANDIDATE_OBSERVED_V1")) {
          markerWrites += 1;
          if (failNextMarkerWrite) {
            failNextMarkerWrite = false;
            if (mode === "after-commit") candidateObserved = true;
            throw new Error("candidate observation response lost");
          }
          candidateObserved = true;
          return getReplacementCandidateObservedReceipt(ATTEMPT_ID, CONTAINER_ID);
        }
        if (command.startsWith("docker inspect")) {
          inspectTargets.push(command);
          if (!candidatePresent) throw new Error(`Error: No such object: ${CONTAINER_ID}`);
          return inspectLine(CONTAINER_ID, ATTEMPT_ID);
        }
        if (command.includes("docker rm")) {
          candidatePresent = false;
        }
        return "";
      }),
    };
    spyOn(DockerSSHClient, "getClient").mockReturnValue(ssh as unknown as DockerSSHClient);
    const provider = replacementProvider();
    const identity = replacementIdentity({ containerId: null, vpnNodeName: null });

    for (const scenario of ["before-commit", "after-commit"] as const) {
      mode = scenario;
      candidateObserved = false;
      candidatePresent = true;
      markerWrites = 0;
      failNextMarkerWrite = true;
      inspectTargets.length = 0;

      await expect(
        provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
      ).rejects.toThrow("candidate observation response lost");
      expect(candidatePresent).toBe(true);

      await expect(
        provider.stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, identity),
      ).resolves.toBeUndefined();
      expect(candidatePresent).toBe(false);
      expect(markerWrites).toBe(scenario === "before-commit" ? 2 : 1);
      expect(inspectTargets[1]).toContain(
        scenario === "before-commit" ? CONTAINER_NAME : CONTAINER_ID,
      );
    }
  });

  test("accepts wrapped Docker rm absence only after the inspected attempt identity matches", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        return inspectLine(CONTAINER_ID, ATTEMPT_ID);
      }
      if (command.includes("docker rm")) {
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

  test("keeps exact id-less VPN cleanup unresolved without a server-side registration barrier", async () => {
    stubNodeLookup();
    stubSsh(async () => {
      throw new Error(`Error response from daemon: No such container: ${CONTAINER_NAME}`);
    });
    const listNodes = spyOn(headscaleClient, "listNodesStrict").mockResolvedValue([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    const error = await provider
      .stopOnSpecificNodeForReplacement(NODE.node_id, CONTAINER_NAME, null, replacementIdentity())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_VPN_NODE_ID_UNRESOLVED",
    });
    expect(listNodes).not.toHaveBeenCalled();
    expect(deleteVpn).not.toHaveBeenCalled();
  });

  test("retains the complete legacy locator when exact node authority is absent", async () => {
    const ssh = spyOn(DockerSSHClient, "getClient");
    const listNodes = spyOn(headscaleClient, "listNodesStrict");
    const decrement = spyOn(dockerNodesRepository, "decrementAllocated").mockResolvedValue();
    const provider = replacementProvider();

    const error = await provider
      .stopOnSpecificNodeForReplacement(
        NODE.node_id,
        CONTAINER_NAME,
        null,
        legacyReplacementIdentity(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      sandboxId: CONTAINER_NAME,
      nodeId: NODE.node_id,
      replacementAttemptId: ATTEMPT_ID,
      vpnNodeName: "agent-replacement",
      previousVpnNodeId: PREVIOUS_VPN_NODE_ID,
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      allocationCounted: true,
    });
    expect((error as Error).cause).toMatchObject({
      code: "SANDBOX_REPLACEMENT_NODE_AUTHORITY_INVALID",
    });
    expect(ssh).not.toHaveBeenCalled();
    expect(listNodes).not.toHaveBeenCalled();
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
        vpnNodeId: "1413",
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

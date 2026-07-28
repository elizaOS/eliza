/**
 * Exercises the durable Docker replacement fence across remote-create crash
 * windows, exact attempt identity, VPN recovery, and capacity-neutral cleanup.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import { dockerNodeManager } from "../docker-node-manager";
import {
  buildSnapshotRestoreBindingEnvironment,
  buildSnapshotSourceAttestationEnvironment,
  createDockerContainerAfterReplacementIntent,
  DockerSandboxProvider,
  getRestoreValidationPhysicalIdentity,
} from "../docker-sandbox-provider";
import { DockerSSHClient } from "../docker-ssh";
import { type HeadscaleNode, headscaleClient } from "../headscale-client";
import { headscaleIntegration, inferTailscaleHostname } from "../headscale-integration";
import {
  type SandboxCreateConfig,
  SandboxReplacementCleanupUnresolvedError,
  type SandboxRestoreValidationCandidateLocator,
} from "../sandbox-provider-types";
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
const TARGET_IMAGE_DIGEST = `sha256:${"03".repeat(32)}`;
const TARGET_IMAGE = `ghcr.io/elizaos/eliza@${TARGET_IMAGE_DIGEST}`;
const LOGICAL_ROUTE_AGENT_ID = "55555555-5555-4555-8555-555555555555";

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
    reserveHostPorts: async () => ({ bridgePort: 18790, webUiPort: 20000 }),
    releaseHostPorts: async () => 2,
    ...(options?.now ? { now: options.now } : {}),
  });
}

function restoreValidationConfig(
  overrides: Partial<SandboxCreateConfig> = {},
): SandboxCreateConfig {
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    agentName: "Restore validation",
    organizationId: "22222222-2222-4222-8222-222222222222",
    routeAgentId: LOGICAL_ROUTE_AGENT_ID,
    environmentVars: {},
    dockerImage: TARGET_IMAGE,
    snapshotRestoreBinding: {
      backupId: "44444444-4444-4444-8444-444444444444",
      captureNonce: "01".repeat(32),
      sourceEnvironmentRevision: 7,
      sourceImageDigest: `sha256:${"02".repeat(32)}`,
      sourceSandboxId: "33333333-3333-4333-8333-333333333333",
      targetImageDigest: TARGET_IMAGE_DIGEST,
    },
    restoreValidationCandidate: {
      primaryNodeId: "node-primary",
      replacementAttemptId: ATTEMPT_ID,
      rollbackStandbyNodeId: "node-standby",
    },
    onRestoreValidationPlacementIntent: async () => ({
      bridgePort: 18790,
      webUiPort: 20000,
    }),
    onReplacementCreateIntent: async () => {},
    onReplacementCreated: async () => {},
    onReplacementVpnRegistered: async () => {},
    ...overrides,
  };
}

function restoreValidationLocator(
  overrides: Partial<SandboxRestoreValidationCandidateLocator> = {},
): SandboxRestoreValidationCandidateLocator {
  const identity = getRestoreValidationPhysicalIdentity(ATTEMPT_ID);
  return {
    sandboxId: identity.containerName,
    nodeId: NODE.node_id,
    containerName: identity.containerName,
    replacementAttemptId: ATTEMPT_ID,
    containerId: CONTAINER_ID,
    volumePath: identity.volumePath,
    vpnNodeId: null,
    vpnNodeName: null,
    previousVpnNodeId: null,
    vpnRegistrationStartedAt: null,
    allocationCounted: true,
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

describe("DockerSandboxProvider replacement cleanup", () => {
  test("injects an exact provider-bound restore identity and rejects caller overrides", () => {
    const environment = buildSnapshotRestoreBindingEnvironment({
      environmentVars: { USER_SETTING: "preserved" },
      replacementAttemptId: ATTEMPT_ID,
      seed: {
        backupId: "44444444-4444-4444-8444-444444444444",
        captureNonce: "01".repeat(32),
        sourceEnvironmentRevision: 7,
        sourceImageDigest: `sha256:${"02".repeat(32)}`,
        sourceSandboxId: "33333333-3333-4333-8333-333333333333",
        targetImageDigest: `sha256:${"03".repeat(32)}`,
      },
      targetSandboxId: CONTAINER_NAME,
    });

    expect(environment).toEqual({
      ELIZA_SNAPSHOT_RESTORE_BACKUP_ID: "44444444-4444-4444-8444-444444444444",
      ELIZA_SNAPSHOT_RESTORE_CANDIDATE_ATTEMPT_ID: ATTEMPT_ID,
      ELIZA_SNAPSHOT_RESTORE_NONCE: "01".repeat(32),
      ELIZA_SNAPSHOT_RESTORE_PROVIDER_SANDBOX_ID: CONTAINER_NAME,
      ELIZA_SNAPSHOT_RESTORE_SOURCE_ENVIRONMENT_REVISION: "7",
      ELIZA_SNAPSHOT_RESTORE_SOURCE_IMAGE_DIGEST: `sha256:${"02".repeat(32)}`,
      ELIZA_SNAPSHOT_RESTORE_SOURCE_SANDBOX_ID: "33333333-3333-4333-8333-333333333333",
      ELIZA_SNAPSHOT_RESTORE_TARGET_IMAGE_DIGEST: `sha256:${"03".repeat(32)}`,
    });

    expect(() =>
      buildSnapshotRestoreBindingEnvironment({
        environmentVars: {
          ELIZA_SNAPSHOT_RESTORE_NONCE: "caller-controlled",
        },
        replacementAttemptId: ATTEMPT_ID,
        seed: undefined,
        targetSandboxId: CONTAINER_NAME,
      }),
    ).toThrow("is provider-owned");
    expect(() =>
      buildSnapshotRestoreBindingEnvironment({
        environmentVars: {},
        replacementAttemptId: ATTEMPT_ID,
        seed: {
          backupId: "44444444-4444-4444-8444-444444444444",
          captureNonce: "01".repeat(32),
          sourceEnvironmentRevision: 7,
          sourceImageDigest: "02".repeat(32),
          sourceSandboxId: "33333333-3333-4333-8333-333333333333",
          targetImageDigest: `sha256:${"03".repeat(32)}`,
        },
        targetSandboxId: CONTAINER_NAME,
      }),
    ).toThrow("binding seed is malformed");
  });

  test("attests the exact digest-pinned provider placement and rejects caller substitution", () => {
    const digest = `sha256:${"04".repeat(32)}`;
    expect(
      buildSnapshotSourceAttestationEnvironment({
        environmentVars: { USER_SETTING: "preserved" },
        placementId: ATTEMPT_ID,
        resolvedImage: `ghcr.io/elizaos/eliza@${digest}`,
        seed: {
          environmentRevision: 9,
          imageDigest: digest,
        },
      }),
    ).toEqual({
      ELIZA_SNAPSHOT_SOURCE_ENVIRONMENT_REVISION: "9",
      ELIZA_SNAPSHOT_SOURCE_IMAGE_DIGEST: digest,
      ELIZA_SNAPSHOT_SOURCE_SANDBOX_ID: ATTEMPT_ID,
    });
    expect(() =>
      buildSnapshotSourceAttestationEnvironment({
        environmentVars: {
          ELIZA_SNAPSHOT_SOURCE_SANDBOX_ID: "55555555-5555-4555-8555-555555555555",
        },
        placementId: ATTEMPT_ID,
        resolvedImage: `ghcr.io/elizaos/eliza@${digest}`,
        seed: undefined,
      }),
    ).toThrow("is provider-owned");
    for (const resolvedImage of [
      "ghcr.io/elizaos/eliza:develop",
      `ghcr.io/elizaos/eliza@sha256:${"05".repeat(32)}`,
    ]) {
      expect(() =>
        buildSnapshotSourceAttestationEnvironment({
          environmentVars: {},
          placementId: ATTEMPT_ID,
          resolvedImage,
          seed: {
            environmentRevision: 9,
            imageDigest: digest,
          },
        }),
      ).toThrow("does not match the pinned launch placement");
    }
  });

  test("derives unique provider-owned physical identities from restore attempts", () => {
    const first = getRestoreValidationPhysicalIdentity(ATTEMPT_ID);
    const second = getRestoreValidationPhysicalIdentity("66666666-6666-4666-8666-666666666666");

    expect(first).toEqual({
      containerName: "restore-validation-33333333333343338333333333333333",
      volumePath: `/data/agents/.restore-validation/${ATTEMPT_ID}`,
      vpnAgentId: ATTEMPT_ID,
      vpnAgentName: "restore-validation-33333333333343338333333333333333",
    });
    expect(second.containerName).not.toBe(first.containerName);
    expect(second.volumePath).not.toBe(first.volumePath);
    expect(second.vpnAgentId).not.toBe(first.vpnAgentId);
    expect(() => getRestoreValidationPhysicalIdentity("not-an-attempt")).toThrow(
      "replacement attempt is malformed",
    );
  });

  test("rejects incomplete identity, mutable-image, or caller-owned restore candidate config", async () => {
    const provider = replacementProvider();
    const invalidConfigs: SandboxCreateConfig[] = [
      restoreValidationConfig({ routeAgentId: null }),
      restoreValidationConfig({
        restoreValidationCandidate: {
          primaryNodeId: "same-node",
          replacementAttemptId: ATTEMPT_ID,
          rollbackStandbyNodeId: "same-node",
        },
      }),
      restoreValidationConfig({ onRestoreValidationPlacementIntent: undefined }),
      restoreValidationConfig({ onReplacementVpnRegistered: undefined }),
      restoreValidationConfig({ dockerImage: "ghcr.io/elizaos/eliza:develop" }),
      restoreValidationConfig({
        snapshotSourceAttestation: {
          environmentRevision: 7,
          imageDigest: TARGET_IMAGE_DIGEST,
        },
      }),
      restoreValidationConfig({ environmentVars: { SANDBOX_AGENT_ID: "caller" } }),
      restoreValidationConfig({ environmentVars: { STEWARD_AGENT_TOKEN: "caller" } }),
      restoreValidationConfig({
        environmentVars: { ELIZA_RUNTIME_BOOT_MODE: "normal" },
      }),
      restoreValidationConfig({ environmentVars: { OPENAI_API_KEY: "user-secret" } }),
      restoreValidationConfig({
        environmentVars: { ELIZA_LOCAL_ROOT_KEY: "agent-root-key" },
      }),
    ];

    for (const config of invalidConfigs) {
      await expect(provider.create(config)).rejects.toThrow();
    }
  });

  test("creates a never-routed candidate on neither serving node with only restore identity", async () => {
    const savedEnvironment = process.env.ENVIRONMENT;
    const savedHeadscaleApiKey = process.env.HEADSCALE_API_KEY;
    const savedFallback = process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK;
    const savedKmsBackend = process.env.ELIZA_KMS_BACKEND;
    const savedLocalRootKey = process.env.ELIZA_LOCAL_ROOT_KEY;
    process.env.ENVIRONMENT = "development";
    process.env.HEADSCALE_API_KEY = "headscale-test-key";
    process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK = "1";
    process.env.ELIZA_KMS_BACKEND = "local";
    process.env.ELIZA_LOCAL_ROOT_KEY = "orchestrator-root-key";

    const getAvailableNode = spyOn(dockerNodeManager, "getAvailableNode").mockResolvedValue(NODE);
    const prepareVpn = spyOn(headscaleIntegration, "prepareContainerVPN").mockResolvedValue({
      preAuthKey: "restore-validation-auth-key",
      envVars: {
        HEADSCALE_URL: "https://headscale.example.test",
        TS_AUTHKEY: "restore-validation-auth-key",
        TS_HOSTNAME: "restore-validation-candidate",
        TS_STATE_DIR: "/var/lib/tailscale",
        TS_EXTRA_ARGS: "--accept-routes",
      },
    });
    spyOn(headscaleIntegration, "waitForVPNRegistration").mockResolvedValue({
      ip: "100.64.0.42",
      nodeId: "vpn-restore-validation",
    });
    const ensureTenant = spyOn(stewardTenantConfig, "ensureStewardTenant");
    const increment = spyOn(dockerNodesRepository, "incrementAllocated").mockResolvedValue();
    const { commands } = stubSsh(async (command) =>
      command.startsWith("docker create") ? `${CONTAINER_ID}\n` : "",
    );
    const persistPlacement = mock(async () => {
      expect(prepareVpn).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      return {
        bridgePort: 19_123,
        webUiPort: 23_123,
      };
    });
    const persistIntent = mock(async () => {
      expect(commands.some((command) => command.startsWith("mkdir -p"))).toBe(false);
      expect(commands.some((command) => command.startsWith("docker create"))).toBe(false);
    });
    const persistCreated = mock(async () => {});
    const provider = replacementProvider();

    try {
      const handle = await provider.create(
        restoreValidationConfig({
          onRestoreValidationPlacementIntent: persistPlacement,
          onReplacementCreateIntent: persistIntent,
          onReplacementCreated: persistCreated,
        }),
      );
      const metadata = handle.metadata as {
        containerName: string;
        replacementAttemptId: string;
        volumePath: string;
      };
      const physicalIdentity = getRestoreValidationPhysicalIdentity(metadata.replacementAttemptId);
      const createCommand = commands.find((command) => command.startsWith("docker create"));

      expect(getAvailableNode).toHaveBeenCalledWith({
        requiredPlatform: expect.anything(),
        excludeNodeId: undefined,
        excludeNodeIds: ["node-primary", "node-standby"],
      });
      expect(metadata).toMatchObject({
        containerName: physicalIdentity.containerName,
        replacementAttemptId: physicalIdentity.vpnAgentId,
        volumePath: physicalIdentity.volumePath,
      });
      expect(createCommand).toContain(`--name '${physicalIdentity.containerName}'`);
      expect(createCommand).toContain(`-v '${physicalIdentity.volumePath}':/app/data`);
      expect(createCommand).toContain("-p 127.0.0.1:19123:");
      expect(createCommand).toContain("-p 127.0.0.1:23123:");
      expect(createCommand).toContain("--restart=no");
      expect(createCommand).toContain(`-e 'ELIZA_RUNTIME_BOOT_MODE=restore-validation'`);
      expect(createCommand).toContain(`-e 'SANDBOX_ROUTE_AGENT_ID=${LOGICAL_ROUTE_AGENT_ID}'`);
      expect(createCommand).toContain(
        `-e 'ELIZA_SNAPSHOT_RESTORE_TARGET_IMAGE_DIGEST=${TARGET_IMAGE_DIGEST}'`,
      );
      expect(createCommand).not.toContain("STEWARD_");
      expect(createCommand).not.toContain("SANDBOX_REGISTRY_");
      expect(createCommand).not.toContain("SANDBOX_AGENT_ID=");
      expect(createCommand).not.toContain("SANDBOX_SERVER_NAME=");
      expect(createCommand).not.toContain("SANDBOX_PUBLIC_URL=");
      expect(createCommand).not.toContain("AGENT_SERVER_SHARED_SECRET=");
      expect(createCommand).not.toContain("ELIZA_SNAPSHOT_SOURCE_");
      expect(createCommand).not.toContain("ELIZA_KMS_BACKEND=");
      expect(createCommand).not.toContain("ELIZA_LOCAL_ROOT_KEY=");
      expect(createCommand).not.toContain("ELIZA_VAULT_PASSPHRASE=");
      expect(createCommand).not.toContain("JWT_SECRET=");
      expect(createCommand).not.toContain("OPENAI_API_KEY=");
      expect(createCommand).toContain("-e 'ELIZA_STATE_DIR=/root/.eliza'");
      expect(createCommand).toContain("-e 'PGLITE_DATA_DIR=/root/.eliza/.pgdata'");
      expect(createCommand).not.toContain("--restart unless-stopped");
      expect(ensureTenant).not.toHaveBeenCalled();
      expect(increment).not.toHaveBeenCalled();
      expect(persistPlacement).toHaveBeenCalledTimes(1);
      expect(persistIntent).toHaveBeenCalledTimes(1);
      expect(persistCreated).toHaveBeenCalledTimes(1);
      expect(commands.findIndex((command) => command.startsWith("mkdir -p"))).toBeLessThan(
        commands.findIndex((command) => command.startsWith("docker create")),
      );
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
      if (savedKmsBackend === undefined) {
        delete process.env.ELIZA_KMS_BACKEND;
      } else {
        process.env.ELIZA_KMS_BACKEND = savedKmsBackend;
      }
      if (savedLocalRootKey === undefined) {
        delete process.env.ELIZA_LOCAL_ROOT_KEY;
      } else {
        process.env.ELIZA_LOCAL_ROOT_KEY = savedLocalRootKey;
      }
    }
  });

  test("retires the exact candidate container, VPN node, and volume with absence proof", async () => {
    stubNodeLookup();
    const locator = restoreValidationLocator();
    const vpnNodeName = inferTailscaleHostname({
      agentId: ATTEMPT_ID,
      agentName: locator.containerName,
    });
    let inspectCount = 0;
    const { commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        inspectCount += 1;
        if (inspectCount === 1) return `${CONTAINER_ID}|${ATTEMPT_ID}\n`;
        throw new Error(`Error response from daemon: No such object: ${locator.containerName}`);
      }
      return "";
    });
    spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([
        headscaleNode("vpn-restore", vpnNodeName, "2026-07-23T00:05:01.000Z"),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const now = Date.parse("2026-07-23T01:00:00.000Z");
    const provider = replacementProvider({ now: () => now });

    const proof = await provider.retireRestoreValidationCandidate({
      ...locator,
      vpnNodeId: "vpn-restore",
      vpnNodeName,
      vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
    });

    expect(proof).toEqual({
      sandboxId: locator.sandboxId,
      nodeId: NODE.node_id,
      containerName: locator.containerName,
      replacementAttemptId: ATTEMPT_ID,
      containerId: CONTAINER_ID,
      containerAbsentAt: "2026-07-23T01:00:00.000Z",
      volumePath: locator.volumePath,
      volumeAbsentAt: "2026-07-23T01:00:00.000Z",
      vpnNodeId: "vpn-restore",
      vpnNodeName,
      vpnAbsentAt: "2026-07-23T01:00:00.000Z",
    });
    expect(deleteVpn).toHaveBeenCalledWith("vpn-restore");
    expect(commands).toEqual([
      expect.stringContaining("docker inspect --format"),
      `docker stop -t 10 '${CONTAINER_ID}'`,
      `docker rm -f '${CONTAINER_ID}'`,
      expect.stringContaining("docker inspect --format"),
      expect.stringContaining("docker inspect --format"),
      `rm -rf -- '${locator.volumePath}' && test ! -e '${locator.volumePath}'`,
    ]);
  });

  test("retains the locator when a late container appears after VPN settlement", async () => {
    stubNodeLookup();
    const locator = restoreValidationLocator();
    const vpnNodeName = inferTailscaleHostname({
      agentId: ATTEMPT_ID,
      agentName: locator.containerName,
    });
    let inspectCount = 0;
    const { commands } = stubSsh(async (command) => {
      if (command.startsWith("docker inspect")) {
        inspectCount += 1;
        if (inspectCount <= 2) {
          throw new Error(`Error response from daemon: No such object: ${locator.containerName}`);
        }
        return `${CONTAINER_ID}|${ATTEMPT_ID}\n`;
      }
      return "";
    });
    spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([
        headscaleNode("vpn-restore", vpnNodeName, "2026-07-23T00:05:01.000Z"),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const releaseHostPorts = mock(async () => 2);
    const now = Date.parse("2026-07-23T01:00:00.000Z");
    const provider = new DockerSandboxProvider({
      replacementVpnSettleDelay: async () => {},
      reserveHostPorts: async () => ({ bridgePort: 18790, webUiPort: 20000 }),
      releaseHostPorts,
      now: () => now,
    });

    const error = await provider
      .retireRestoreValidationCandidate({
        ...locator,
        vpnNodeId: "vpn-restore",
        vpnNodeName,
        vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("appeared after VPN settlement"),
    );
    expect(error).toMatchObject({
      replacementAttemptId: ATTEMPT_ID,
      volumePath: locator.volumePath,
      vpnNodeId: "vpn-restore",
    });
    expect(deleteVpn).toHaveBeenCalledWith("vpn-restore");
    expect(commands.filter((command) => command.startsWith("docker inspect"))).toHaveLength(3);
    expect(commands.every((command) => !command.startsWith("rm -rf --"))).toBe(true);
    expect(releaseHostPorts).not.toHaveBeenCalled();
  });

  test("classifies only an exact restore candidate as running, exited, or absent", async () => {
    stubNodeLookup();
    const locator = restoreValidationLocator();
    let inspection: string | Error = `${CONTAINER_ID}|${ATTEMPT_ID}|running\n`;
    stubSsh(async (command) => {
      expect(command).toContain("docker inspect --format");
      if (inspection instanceof Error) throw inspection;
      return inspection;
    });
    const provider = replacementProvider();

    await expect(provider.inspectRestoreValidationCandidate(locator)).resolves.toBe("running");
    inspection = `${CONTAINER_ID}|${ATTEMPT_ID}|exited\n`;
    await expect(provider.inspectRestoreValidationCandidate(locator)).resolves.toBe("exited");
    inspection = `${CONTAINER_ID}|different-attempt|exited\n`;
    await expect(provider.inspectRestoreValidationCandidate(locator)).resolves.toBe("unresolved");
    inspection = new Error(`Error response from daemon: No such object: ${locator.containerName}`);
    await expect(provider.inspectRestoreValidationCandidate(locator)).resolves.toBe("absent");
    inspection = new Error("SSH connection timed out");
    await expect(provider.inspectRestoreValidationCandidate(locator)).resolves.toBe("unresolved");
  });

  test("fails before remote retirement when candidate identity or volume is not exact", async () => {
    const findNode = stubNodeLookup();
    const { commands } = stubSsh();
    const provider = replacementProvider();

    await expect(
      provider.retireRestoreValidationCandidate(
        restoreValidationLocator({ volumePath: "/data/agents/wrong" }),
      ),
    ).rejects.toThrow("volume path does not match");
    await expect(
      provider.retireRestoreValidationCandidate(
        restoreValidationLocator({ containerName: CONTAINER_NAME }),
      ),
    ).rejects.toThrow("container identity does not match");
    expect(findNode).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
  });

  test("does not remove the volume when VPN absence cannot be proven", async () => {
    stubNodeLookup();
    const locator = restoreValidationLocator();
    const vpnNodeName = inferTailscaleHostname({
      agentId: ATTEMPT_ID,
      agentName: locator.containerName,
    });
    const { commands } = stubSsh(async () => {
      throw new Error(`Error response from daemon: No such object: ${locator.containerName}`);
    });
    const vpnNode = headscaleNode("vpn-restore", vpnNodeName, "2026-07-23T00:05:01.000Z");
    spyOn(headscaleClient, "listNodesStrict")
      .mockResolvedValueOnce([vpnNode])
      .mockResolvedValueOnce([vpnNode])
      .mockResolvedValueOnce([vpnNode])
      .mockResolvedValueOnce([vpnNode]);
    spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    const error = await provider
      .retireRestoreValidationCandidate({
        ...locator,
        vpnNodeId: vpnNode.id,
        vpnNodeName,
        vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxReplacementCleanupUnresolvedError);
    expect(error).toMatchObject({
      replacementAttemptId: ATTEMPT_ID,
      volumePath: locator.volumePath,
      vpnNodeId: vpnNode.id,
    });
    expect(commands.every((command) => !command.startsWith("rm -rf --"))).toBe(true);
  });

  test("fails closed when the persisted VPN id is absent but a same-name registration remains", async () => {
    stubNodeLookup();
    const locator = restoreValidationLocator();
    const vpnNodeName = inferTailscaleHostname({
      agentId: ATTEMPT_ID,
      agentName: locator.containerName,
    });
    const { commands } = stubSsh(async () => {
      throw new Error(`Error response from daemon: No such object: ${locator.containerName}`);
    });
    spyOn(headscaleClient, "listNodesStrict").mockResolvedValue([
      headscaleNode("vpn-different", vpnNodeName, "2026-07-23T00:05:01.000Z"),
    ]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await expect(
      provider.retireRestoreValidationCandidate({
        ...locator,
        vpnNodeId: "vpn-persisted",
        vpnNodeName,
        vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      }),
    ).rejects.toThrow("VPN identity is ambiguous");

    expect(deleteVpn).not.toHaveBeenCalled();
    expect(commands.every((command) => !command.startsWith("rm -rf --"))).toBe(true);
  });

  test("fails closed when the persisted VPN id has the wrong registration identity", async () => {
    stubNodeLookup();
    const locator = restoreValidationLocator();
    const vpnNodeName = inferTailscaleHostname({
      agentId: ATTEMPT_ID,
      agentName: locator.containerName,
    });
    const { commands } = stubSsh(async () => {
      throw new Error(`Error response from daemon: No such object: ${locator.containerName}`);
    });
    spyOn(headscaleClient, "listNodesStrict").mockResolvedValue([
      headscaleNode("vpn-persisted", "unrelated-node", "2026-07-23T00:05:01.000Z"),
    ]);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

    await expect(
      provider.retireRestoreValidationCandidate({
        ...locator,
        vpnNodeId: "vpn-persisted",
        vpnNodeName,
        vpnRegistrationStartedAt: REGISTRATION_STARTED_AT,
      }),
    ).rejects.toThrow("does not match its registration identity");

    expect(deleteVpn).not.toHaveBeenCalled();
    expect(commands.every((command) => !command.startsWith("rm -rf --"))).toBe(true);
  });

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
        return `${CONTAINER_ID}|${ATTEMPT_ID}\n`;
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
    expect(commands[0]).toContain(CONTAINER_NAME);
    expect(commands.slice(1)).toEqual([
      `docker stop -t 10 '${CONTAINER_ID}'`,
      `docker rm -f '${CONTAINER_ID}'`,
    ]);
    expect(deleteVpn).toHaveBeenCalledWith("vpn-node-42");
    expect(decrement).not.toHaveBeenCalled();
  });

  test("refuses to touch a same-name occupant with a different attempt label", async () => {
    stubNodeLookup();
    const { commands } = stubSsh(async () => `${CONTAINER_ID}|another-attempt\n`);
    const deleteVpn = spyOn(headscaleClient, "deleteNode").mockResolvedValue();
    const provider = replacementProvider();

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

  test("refuses cleanup when Docker's inspected id differs from the persisted id", async () => {
    stubNodeLookup();
    const otherId = "b".repeat(64);
    const { commands } = stubSsh(async () => `${otherId}|${ATTEMPT_ID}\n`);
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
        return `${CONTAINER_ID}|${ATTEMPT_ID}\n`;
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
        environmentVars: {},
      }),
    ).rejects.toBe(unresolved);
    expect(createOnce).toHaveBeenCalledTimes(1);
  });
});

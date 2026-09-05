/**
 * Pins Hetzner container lifecycle and stdin-environment boundaries with
 * deterministic repository, scheduler, registry, and SSH fakes. No live node,
 * provider, or database is reached.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// bun runs cloud-shared test files in one process and `mock.module` overrides
// are process-global; snapshot the real modules first and reinstall them in
// afterAll so these stubs never leak into sibling files.
import * as realContainersRepo from "../../../../db/repositories/containers";
import * as realDockerNodesRepo from "../../../../db/repositories/docker-nodes";
import { containersEnv } from "../../../config/containers-env";
import * as realDockerNodeManager from "../../docker-node-manager";
import * as realDockerPortAllocation from "../../docker-port-allocation";
import {
  buildDockerEnvFileStdinTransport,
  getReplacementCandidateObservedReceipt,
  getReplacementDockerCreateQuiescentReceipt,
  getReplacementSecretArtifactsCleanupReceipt,
} from "../../docker-sandbox-utils";
import * as realDockerSsh from "../../docker-ssh";
import * as realHetznerVolumes from "../hetzner-volumes";
import * as realMetadata from "./metadata";
import * as realRegistry from "./registry";
import { type CreateContainerInput, HetznerClientError } from "./types";

const realContainersRepoSnap = { ...realContainersRepo };
const realDockerNodesRepoSnap = { ...realDockerNodesRepo };
const realDockerNodeManagerSnap = { ...realDockerNodeManager };
const realDockerPortAllocationSnap = { ...realDockerPortAllocation };
const realHetznerVolumesSnap = { ...realHetznerVolumes };
const realDockerSshSnap = { ...realDockerSsh };
const realMetadataSnap = { ...realMetadata };
const realRegistrySnap = { ...realRegistry };

const findById = mock(async (_id: string, _org: string): Promise<unknown> => null);
const listByOrganization = mock(async (_org: string): Promise<unknown[]> => []);
const deleteRow = mock(async (_id: string, _org: string): Promise<void> => {});
const tryReleaseNodeSlot = mock(async (): Promise<void> => {});
const updateRow = mock(async (): Promise<unknown> => null);
const updateStatus = mock(async (): Promise<void> => {});
const prepareFundedRestart = mock(async (): Promise<void> => {});
const reserveCreatePlacement = mock(async (..._args: unknown[]): Promise<void> => {});
const completeCreatePlacement = mock(async (..._args: unknown[]) => ROW);
const settleCreateFailure = mock(async (..._args: unknown[]): Promise<void> => {});
const findCreateCleanupCandidates = mock(async (): Promise<unknown[]> => []);
const findByIdOnPrimary = mock(async (_id: string): Promise<unknown> => null);
const createWithProjectIntentAndQuotaCheck = mock(
  async (): Promise<unknown> => ({
    container: ROW,
    created: false,
  }),
);

const readMetadata = mock((_row: unknown): unknown => null);

const execMock = mock(async (_cmd: string, _timeout?: number): Promise<string> => "");
const execStdinMock = mock(
  async (_cmd: string, _input: Buffer | string, _timeout?: number): Promise<string> => "",
);
const fakeSsh = { exec: execMock, execStdin: execStdinMock, execStream: mock(async () => {}) };
const getClient = mock(() => fakeSsh);
const findByNodeId = mock(async (_id: string): Promise<unknown> => null);
const incrementAllocated = mock(async (_id: string): Promise<void> => {});
const getAvailableNode = mock(async (): Promise<unknown> => null);
const getUsedDockerHostPorts = mock(async (): Promise<Set<number>> => new Set());
const ensureRegistryAccess = mock(async (): Promise<void> => {});
const readPulledImageDigest = mock(async (): Promise<string | undefined> => undefined);
const getOrCreateProjectVolume = mock(
  async (): Promise<unknown> => ({
    id: 11,
    location: { name: "fsn1" },
  }),
);
let volumesAvailable = false;

mock.module("../../../../db/repositories/containers", () => ({
  ...realContainersRepo,
  containersRepository: {
    ...realContainersRepo.containersRepository,
    findById,
    listByOrganization,
    delete: deleteRow,
    tryReleaseNodeSlot,
    update: updateRow,
    updateStatus,
    prepareFundedRestart,
    reserveCreatePlacement,
    completeCreatePlacement,
    settleCreateFailure,
    findCreateCleanupCandidates,
    createWithProjectIntentAndQuotaCheck,
  },
}));

mock.module("../../../../db/repositories/docker-nodes", () => ({
  ...realDockerNodesRepo,
  dockerNodesRepository: {
    ...realDockerNodesRepo.dockerNodesRepository,
    findByNodeId,
    findByIdOnPrimary,
    incrementAllocated,
  },
}));

mock.module("../../docker-node-manager", () => ({
  ...realDockerNodeManager,
  dockerNodeManager: {
    ...realDockerNodeManager.dockerNodeManager,
    getAvailableNode,
  },
}));

mock.module("../../docker-port-allocation", () => ({
  ...realDockerPortAllocation,
  getUsedDockerHostPorts,
}));

mock.module("../hetzner-volumes", () => ({
  ...realHetznerVolumes,
  isHetznerVolumesAvailable: () => volumesAvailable,
  getHetznerVolumeService: () => ({ getOrCreateProjectVolume }),
}));

mock.module("../../docker-ssh", () => ({
  ...realDockerSsh,
  DockerSSHClient: { getClient },
}));

mock.module("./metadata", () => ({
  ...realMetadata,
  readMetadata,
}));

mock.module("./registry", () => ({
  ...realRegistry,
  ensureRegistryAccess,
  readPulledImageDigest,
}));

const { getHetznerContainersClient } = await import("./client");

const META = {
  provider: "hetzner-docker" as const,
  nodeId: "node-1",
  hostname: "10.0.0.1",
  containerName: "app-11111111-1111-4111-8111-111111111111",
  hostPort: 8080,
  image: "ghcr.io/elizaos/eliza:stable",
  containerPort: 3000,
};

const ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "existing",
  project_name: "project-one",
  organization_id: "org1",
  user_id: "user1",
  image_tag: "ghcr.io/elizaos/eliza:stable",
  port: 3000,
  desired_count: 1,
  cpu: 1024,
  memory: 512,
  environment_vars: {},
  health_check_path: "/health",
  hcloud_volume_id: null,
  lifecycle_revision: 7,
  status: "running",
  load_balancer_url: "https://existing.example",
  metadata: META,
  error_message: null,
  created_at: new Date("2026-08-20T12:00:00.000Z"),
  updated_at: new Date("2026-08-20T12:00:00.000Z"),
};

const NODE = {
  id: "22222222-2222-4222-8222-222222222222",
  node_incarnation: "33333333-3333-4333-8333-333333333333",
  metadata: { environment: containersEnv.environment() },
  node_id: "node-create",
  hostname: "10.0.0.2",
  ssh_port: 22,
  ssh_user: "root",
  host_key_fingerprint: "SHA256:test-host-pin",
};

const NEW_CONTAINER_INPUT: CreateContainerInput = {
  name: "stdin-env",
  projectName: "project-stdin-env",
  organizationId: "org1",
  userId: "user1",
  image: "ghcr.io/elizaos/eliza:stable",
  port: 3000,
  desiredCount: 1,
  cpu: 1024,
  memoryMb: 1024,
};
const TEST_PRIVATE_KEY_HEADER = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");

function expectedEnvironmentFrame(environment: Readonly<Record<string, string>>): string {
  return buildDockerEnvFileStdinTransport(environment, () => "true").input;
}

function dockerCreateCommands(): string[] {
  return execStdinMock.mock.calls.map((call) => call[0]);
}

function assertSecretsAbsentFromCommands(secrets: readonly string[]): void {
  const commands = [...execMock.mock.calls.map((call) => call[0]), ...dockerCreateCommands()];
  for (const command of commands) {
    expect(command).not.toMatch(/\bdocker\s+(?:create|run)\s[^;\n]*\s-e(?:\s|$)/);
    for (const secret of secrets) {
      if (secret.length > 0) expect(command).not.toContain(secret);
    }
  }
}

afterAll(() => {
  mock.module("../../../../db/repositories/containers", () => realContainersRepoSnap);
  mock.module("../../../../db/repositories/docker-nodes", () => realDockerNodesRepoSnap);
  mock.module("../../docker-node-manager", () => realDockerNodeManagerSnap);
  mock.module("../../docker-port-allocation", () => realDockerPortAllocationSnap);
  mock.module("../hetzner-volumes", () => realHetznerVolumesSnap);
  mock.module("../../docker-ssh", () => realDockerSshSnap);
  mock.module("./metadata", () => realMetadataSnap);
  mock.module("./registry", () => realRegistrySnap);
});

beforeEach(() => {
  for (const m of [
    findById,
    listByOrganization,
    deleteRow,
    tryReleaseNodeSlot,
    updateRow,
    updateStatus,
    prepareFundedRestart,
    reserveCreatePlacement,
    completeCreatePlacement,
    settleCreateFailure,
    findCreateCleanupCandidates,
    findByIdOnPrimary,
    createWithProjectIntentAndQuotaCheck,
    readMetadata,
    execMock,
    execStdinMock,
    getClient,
    findByNodeId,
    incrementAllocated,
    getAvailableNode,
    getUsedDockerHostPorts,
    ensureRegistryAccess,
    readPulledImageDigest,
    getOrCreateProjectVolume,
  ]) {
    m.mockReset();
  }
  findById.mockResolvedValue(ROW);
  listByOrganization.mockResolvedValue([]);
  deleteRow.mockResolvedValue(undefined);
  tryReleaseNodeSlot.mockResolvedValue(undefined);
  updateRow.mockResolvedValue(null);
  updateStatus.mockResolvedValue(undefined);
  prepareFundedRestart.mockResolvedValue(undefined);
  reserveCreatePlacement.mockResolvedValue(undefined);
  completeCreatePlacement.mockResolvedValue(ROW);
  settleCreateFailure.mockResolvedValue(undefined);
  findCreateCleanupCandidates.mockResolvedValue([]);
  findByIdOnPrimary.mockResolvedValue(NODE);
  createWithProjectIntentAndQuotaCheck.mockResolvedValue({
    container: ROW,
    created: false,
  });
  readMetadata.mockReturnValue(META);
  execMock.mockResolvedValue("");
  execStdinMock.mockResolvedValue("");
  getClient.mockReturnValue(fakeSsh);
  findByNodeId.mockResolvedValue(null);
  incrementAllocated.mockResolvedValue(undefined);
  getAvailableNode.mockResolvedValue(NODE);
  getUsedDockerHostPorts.mockResolvedValue(new Set());
  ensureRegistryAccess.mockResolvedValue(undefined);
  readPulledImageDigest.mockResolvedValue(undefined);
  getOrCreateProjectVolume.mockResolvedValue({ id: 11, location: { name: "fsn1" } });
  volumesAvailable = false;
});

describe("createContainer — primary project intent", () => {
  test("returns the existing row without any provider-side effect", async () => {
    const client = getHetznerContainersClient();
    await expect(
      client.createContainer({
        name: "existing",
        projectName: "project-one",
        organizationId: "org1",
        userId: "user1",
        image: "ghcr.io/elizaos/eliza:stable",
        port: 3000,
        desiredCount: 1,
        cpu: 1024,
        memoryMb: 1024,
      }),
    ).resolves.toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      projectName: "project-one",
    });

    expect(createWithProjectIntentAndQuotaCheck).toHaveBeenCalledTimes(1);
    expect(getClient).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(updateRow).not.toHaveBeenCalled();
  });

  test("marks a newly admitted intent failed when provider preflight rejects", async () => {
    createWithProjectIntentAndQuotaCheck.mockResolvedValue({
      container: ROW,
      created: true,
    });
    volumesAvailable = true;
    getOrCreateProjectVolume.mockRejectedValue(new Error("volume preflight unavailable"));

    const client = getHetznerContainersClient();
    await expect(
      client.createContainer({
        name: "existing",
        projectName: "project-one",
        organizationId: "org1",
        userId: "user1",
        image: "ghcr.io/elizaos/eliza:stable",
        port: 3000,
        desiredCount: 1,
        cpu: 1024,
        memoryMb: 1024,
        persistVolume: true,
        useHetznerVolume: true,
      }),
    ).rejects.toMatchObject({ code: "container_create_failed" });

    expect(updateStatus).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "failed",
      "volume preflight unavailable",
    );
    expect(getClient).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe("createContainer — placement and cleanup authority", () => {
  test("background cleanup refuses a replacement boot but settles the original pinned host", async () => {
    findCreateCleanupCandidates.mockResolvedValue([
      {
        ...ROW,
        status: "cleanup_required",
        node_id: NODE.node_id,
        metadata: {
          ...META,
          nodeRecordId: NODE.id,
          environment: containersEnv.environment(),
          createNodeIncarnation: NODE.node_incarnation,
          createHostKeyFingerprint: NODE.host_key_fingerprint,
          createHostname: NODE.hostname,
          createSshPort: NODE.ssh_port,
          createSshUser: NODE.ssh_user,
        },
      },
    ]);
    findByIdOnPrimary.mockResolvedValue({
      ...NODE,
      node_incarnation: "44444444-4444-4444-8444-444444444444",
    });
    expect(await getHetznerContainersClient().reconcileCreateCleanup()).toEqual({
      checked: 1,
      removed: 0,
      pending: 1,
    });
    expect(execMock).not.toHaveBeenCalled();
    expect(settleCreateFailure).not.toHaveBeenCalled();
    findByIdOnPrimary.mockResolvedValue(NODE);
    execMock.mockImplementation(async (command) =>
      command.includes("attempt_cancelled")
        ? `${getReplacementSecretArtifactsCleanupReceipt(ROW.id)}\n${getReplacementDockerCreateQuiescentReceipt(ROW.id)}\n`
        : "",
    );
    expect(await getHetznerContainersClient().reconcileCreateCleanup()).toEqual({
      checked: 1,
      removed: 1,
      pending: 0,
    });
    expect(settleCreateFailure.mock.calls[0]?.[2]).toBe(NODE.id);
  });

  test("port inventory failure cannot leave a node reservation", async () => {
    createWithProjectIntentAndQuotaCheck.mockResolvedValue({ container: ROW, created: true });
    getUsedDockerHostPorts.mockRejectedValue(new Error("primary inventory unavailable"));
    await expect(getHetznerContainersClient().createContainer(NEW_CONTAINER_INPUT)).rejects.toThrow(
      "primary inventory unavailable",
    );
    expect(reserveCreatePlacement).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(execStdinMock).not.toHaveBeenCalled();
  });

  test("rejected placement never reaches Docker", async () => {
    createWithProjectIntentAndQuotaCheck.mockResolvedValue({ container: ROW, created: true });
    reserveCreatePlacement.mockRejectedValue(new Error("node was retired"));
    await expect(getHetznerContainersClient().createContainer(NEW_CONTAINER_INPUT)).rejects.toThrow(
      "node was retired",
    );
    expect(execMock).not.toHaveBeenCalled();
    expect(execStdinMock).not.toHaveBeenCalled();
    expect(completeCreatePlacement).not.toHaveBeenCalled();
  });

  test("unreachable cleanup keeps the capacity claim", async () => {
    createWithProjectIntentAndQuotaCheck.mockResolvedValue({ container: ROW, created: true });
    execStdinMock.mockRejectedValue(new Error("create acknowledgement lost"));
    execMock.mockImplementation(async (command) => {
      if (
        command.includes("attempt_cancelled") ||
        command.includes("docker rm -f") ||
        command.includes("docker inspect --format")
      ) {
        throw new Error("SSH connection lost");
      }
      return "";
    });
    await expect(getHetznerContainersClient().createContainer(NEW_CONTAINER_INPUT)).rejects.toThrow(
      "create acknowledgement lost",
    );
    expect(settleCreateFailure.mock.calls[0]?.[4]).toBe(false);
    expect(incrementAllocated).not.toHaveBeenCalled();
    expect(completeCreatePlacement).not.toHaveBeenCalled();
  });

  test("quiescent create without a candidate preserves a pre-existing container", async () => {
    createWithProjectIntentAndQuotaCheck.mockResolvedValue({ container: ROW, created: true });
    execStdinMock.mockRejectedValue(new Error("create rejected before a candidate was produced"));
    let existingContainerPresent = true;
    execMock.mockImplementation(async (command) => {
      if (command.includes("attempt_cancelled"))
        return `${getReplacementSecretArtifactsCleanupReceipt(ROW.id)}\n${getReplacementDockerCreateQuiescentReceipt(ROW.id)}\n`;
      if (command.includes("docker rm -f")) existingContainerPresent = false;
      return "";
    });
    await expect(getHetznerContainersClient().createContainer(NEW_CONTAINER_INPUT)).rejects.toThrow(
      "create rejected before a candidate was produced",
    );
    expect(existingContainerPresent).toBe(true);
    expect(settleCreateFailure.mock.calls[0]?.[4]).toBe(true);
  });

  test("lost removal acknowledgement settles through explicit Docker absence", async () => {
    createWithProjectIntentAndQuotaCheck.mockResolvedValue({ container: ROW, created: true });
    execStdinMock.mockRejectedValue(
      new Error("[docker-ssh] Command exited with code 1: create failed"),
    );
    execMock.mockImplementation(async (command) => {
      if (command.includes("attempt_cancelled"))
        return `${getReplacementSecretArtifactsCleanupReceipt(ROW.id)}\n${getReplacementCandidateObservedReceipt(ROW.id, "a".repeat(64))}\n`;
      if (command.includes("docker rm -f")) throw new Error("SSH response lost");
      if (command.includes("docker inspect --format"))
        throw new Error(
          "Error: No such container: cloud-container-11111111-1111-4111-8111-111111111111",
        );
      return "";
    });
    await expect(getHetznerContainersClient().createContainer(NEW_CONTAINER_INPUT)).rejects.toThrow(
      "create failed",
    );
    expect(settleCreateFailure.mock.calls[0]?.[4]).toBe(true);
    expect(completeCreatePlacement).not.toHaveBeenCalled();
  });

  test("removal cannot release capacity while a timed-out create may still finish", async () => {
    createWithProjectIntentAndQuotaCheck.mockResolvedValue({ container: ROW, created: true });
    execStdinMock.mockRejectedValue(new Error("SSH create timed out"));
    execMock.mockImplementation(async (command) =>
      command.includes("attempt_cancelled")
        ? `${getReplacementSecretArtifactsCleanupReceipt(ROW.id)}\n`
        : "",
    );
    await expect(getHetznerContainersClient().createContainer(NEW_CONTAINER_INPUT)).rejects.toThrow(
      "SSH create timed out",
    );
    expect(settleCreateFailure.mock.calls[0]?.[4]).toBe(false);
  });

  test("cleanup removes the recorded candidate ID instead of a reusable name", async () => {
    const candidateId = "a".repeat(64);
    createWithProjectIntentAndQuotaCheck.mockResolvedValue({ container: ROW, created: true });
    execStdinMock.mockRejectedValue(new Error("SSH response lost"));
    execMock.mockImplementation(async (command) =>
      command.includes("attempt_cancelled")
        ? `${getReplacementSecretArtifactsCleanupReceipt(ROW.id)}\n${getReplacementCandidateObservedReceipt(ROW.id, candidateId)}\n`
        : "",
    );
    await expect(getHetznerContainersClient().createContainer(NEW_CONTAINER_INPUT)).rejects.toThrow(
      "SSH response lost",
    );
    const removals = execMock.mock.calls
      .map(([command]) => command)
      .filter((command) => command.includes("docker rm -f"));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toEndWith(`docker rm -f '${candidateId}'`);
    expect(settleCreateFailure.mock.calls[0]?.[4]).toBe(true);
  });
});

describe("createContainer — stdin-only environment transport", () => {
  test("a newly admitted intent keeps multiline and 70 KiB values off every command", async () => {
    const privateKey = `${TEST_PRIVATE_KEY_HEADER}\nline one with 'quotes'\nline two\n-----END PRIVATE KEY-----\n`;
    const largeSecret = `seventy-kib-secret:${"x".repeat(70 * 1024)}`;
    const environmentVars = {
      APP_SECRET: "new-intent-secret-sentinel",
      PRIVATE_KEY: privateKey,
      LARGE_SECRET: largeSecret,
    };
    createWithProjectIntentAndQuotaCheck.mockResolvedValue({
      container: { ...ROW, environment_vars: environmentVars },
      created: true,
    });

    const client = getHetznerContainersClient();
    await expect(
      client.createContainer({ ...NEW_CONTAINER_INPUT, environmentVars }),
    ).resolves.toMatchObject({ id: "11111111-1111-4111-8111-111111111111" });

    expect(createWithProjectIntentAndQuotaCheck).toHaveBeenCalledTimes(1);
    expect(createWithProjectIntentAndQuotaCheck.mock.calls[0]?.[0]).toMatchObject({
      environment_vars: environmentVars,
    });
    expect(execStdinMock).toHaveBeenCalledTimes(1);
    const [command, input, timeout] = execStdinMock.mock.calls[0]!;
    expect(command).toContain("docker create");
    expect(command).toContain('--env-file "$env_file"');
    expect(input).toBe(expectedEnvironmentFrame(environmentVars));
    expect(input).toContain(TEST_PRIVATE_KEY_HEADER);
    expect(input).toContain("line two\n-----END PRIVATE KEY-----");
    expect(input).toContain(largeSecret);
    expect(Buffer.byteLength(input)).toBeGreaterThan(70 * 1024);
    expect(timeout).toBe(60_000);
    assertSecretsAbsentFromCommands(Object.values(environmentVars));
    for (const key of Object.keys(environmentVars)) expect(command).not.toContain(key);
  });

  test("a host-port collision retries with byte-identical stdin and a distinct port", async () => {
    const environmentVars = {
      API_TOKEN: "collision-secret-sentinel",
      PRIVATE_KEY: "first line\nsecond line\n",
    };
    createWithProjectIntentAndQuotaCheck.mockResolvedValue({
      container: { ...ROW, environment_vars: environmentVars },
      created: true,
    });
    execStdinMock.mockImplementation(async () => {
      if (execStdinMock.mock.calls.length === 1) {
        throw new Error("Bind for 0.0.0.0 failed: port is already allocated");
      }
      return "";
    });

    const client = getHetznerContainersClient();
    await expect(
      client.createContainer({ ...NEW_CONTAINER_INPUT, environmentVars }),
    ).resolves.toMatchObject({ id: "11111111-1111-4111-8111-111111111111" });

    expect(execStdinMock).toHaveBeenCalledTimes(2);
    const firstCommand = execStdinMock.mock.calls[0]![0];
    const secondCommand = execStdinMock.mock.calls[1]![0];
    const firstInput = execStdinMock.mock.calls[0]![1];
    const secondInput = execStdinMock.mock.calls[1]![1];
    expect(firstInput).toBe(expectedEnvironmentFrame(environmentVars));
    expect(secondInput).toBe(firstInput);
    expect(Buffer.from(secondInput)).toEqual(Buffer.from(firstInput));

    const firstPort = firstCommand.match(/\s-p (\d+):3000(?:\s|$)/)?.[1];
    const secondPort = secondCommand.match(/\s-p (\d+):3000(?:\s|$)/)?.[1];
    expect(firstPort).toMatch(/^\d+$/);
    expect(secondPort).toMatch(/^\d+$/);
    expect(secondPort).not.toBe(firstPort);
    expect(
      execMock.mock.calls.filter(([command]) => command.includes("docker network inspect")),
    ).toHaveLength(2);
    assertSecretsAbsentFromCommands(Object.values(environmentVars));
  });

  test("NUL and oversized values are rejected before intent admission, node selection, or SSH", async () => {
    const invalidEnvironments = [
      { PRIVATE_KEY: "nul-secret\0must-not-travel" },
      { LARGE_SECRET: `oversized-secret:${"x".repeat(121 * 1024)}` },
    ];
    const client = getHetznerContainersClient();

    for (const environmentVars of invalidEnvironments) {
      let rejection: unknown;
      try {
        await client.createContainer({ ...NEW_CONTAINER_INPUT, environmentVars });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(HetznerClientError);
      expect(rejection).toMatchObject({ code: "invalid_input" });
    }

    expect(createWithProjectIntentAndQuotaCheck).not.toHaveBeenCalled();
    expect(getAvailableNode).not.toHaveBeenCalled();
    expect(getUsedDockerHostPorts).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(execStdinMock).not.toHaveBeenCalled();
    expect(updateRow).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe("setEnv — validate before mutation and recreate through stdin", () => {
  test("rejects invalid frames before funding state, lookup, stop, rm, or SSH", async () => {
    const client = getHetznerContainersClient();
    const invalidEnvironments = [
      { PRIVATE_KEY: "nul-secret\0must-not-travel" },
      { LARGE_SECRET: `oversized-secret:${"x".repeat(121 * 1024)}` },
    ];

    for (const environmentVars of invalidEnvironments) {
      let rejection: unknown;
      try {
        await client.setEnv("11111111-1111-4111-8111-111111111111", "org1", environmentVars);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(HetznerClientError);
      expect(rejection).toMatchObject({ code: "invalid_input" });
    }

    expect(prepareFundedRestart).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
    expect(findByNodeId).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(execStdinMock).not.toHaveBeenCalled();
    expect(updateRow).not.toHaveBeenCalled();
  });

  test("orders stop, rm, network, stdin create, start, then persists the exact environment", async () => {
    const environmentVars = {
      API_TOKEN: "set-env-secret-sentinel",
      PRIVATE_KEY: "-----BEGIN KEY-----\nmultiline\n-----END KEY-----\n",
      EMPTY: "",
    };
    const events: string[] = [];
    prepareFundedRestart.mockImplementation(async () => {
      events.push("funded");
    });
    execMock.mockImplementation(async (command: string) => {
      if (command.includes("docker stop")) events.push("stop");
      else if (command.includes("docker rm -f")) events.push("rm");
      else if (command.includes("docker network inspect")) events.push("network");
      else if (command.includes("docker start")) events.push("start");
      return "";
    });
    execStdinMock.mockImplementation(async () => {
      events.push("stdin-create");
      return "";
    });
    updateRow.mockImplementation(async () => {
      events.push("persist");
      return null;
    });

    const client = getHetznerContainersClient();
    await expect(
      client.setEnv("11111111-1111-4111-8111-111111111111", "org1", environmentVars),
    ).resolves.toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
    });

    expect(events).toEqual(["funded", "stop", "rm", "network", "stdin-create", "start", "persist"]);
    expect(prepareFundedRestart).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "org1",
      expect.any(Date),
    );
    expect(execStdinMock).toHaveBeenCalledTimes(1);
    const [command, input, timeout] = execStdinMock.mock.calls[0]!;
    expect(command).toContain("docker create");
    expect(command).toContain('--env-file "$env_file"');
    expect(input).toBe(expectedEnvironmentFrame(environmentVars));
    expect(timeout).toBe(60_000);
    expect(updateRow).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "org1",
      expect.objectContaining({
        environment_vars: environmentVars,
        status: "deploying",
      }),
    );
    assertSecretsAbsentFromCommands(Object.values(environmentVars));
    for (const key of Object.keys(environmentVars)) expect(command).not.toContain(key);
  });

  test("a remote create error can quote its command without disclosing stdin secrets", async () => {
    const environmentVars = {
      API_TOKEN: "set-env-error-secret-sentinel",
      PRIVATE_KEY: "error-path-line-one\nerror-path-line-two\n",
    };
    execStdinMock.mockImplementation(async (command: string) => {
      throw new Error(`remote create rejected command: ${command}`);
    });

    const client = getHetznerContainersClient();
    let rejection: unknown;
    try {
      await client.setEnv("11111111-1111-4111-8111-111111111111", "org1", environmentVars);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const rejectionText = String(rejection);
    expect(rejectionText).toContain("remote create rejected command");
    for (const [key, secret] of Object.entries(environmentVars)) {
      expect(rejectionText).not.toContain(key);
      expect(rejectionText).not.toContain(secret);
    }
    assertSecretsAbsentFromCommands(Object.values(environmentVars));
    expect(updateRow).not.toHaveBeenCalled();
  });
});

describe("deleteContainer — fail-closed host teardown", () => {
  test("happy path removes the container and then deletes the control-plane row", async () => {
    const client = getHetznerContainersClient();
    await expect(
      client.deleteContainer("11111111-1111-4111-8111-111111111111", "org1"),
    ).resolves.toBeUndefined();

    const cmds = execMock.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c.includes("docker rm -f"))).toBe(true);
    expect(deleteRow).toHaveBeenCalledTimes(1);
    expect(deleteRow.mock.calls[0]).toEqual(["11111111-1111-4111-8111-111111111111", "org1"]);
  });

  test("authoritative `docker rm -f` failure PROPAGATES and the row is NOT deleted", async () => {
    // The un-caught rm -f is the real teardown; if it fails we must not silently
    // delete the DB row (that would leak a live Docker container). Fail closed.
    execMock.mockImplementation(async (cmd: string) => {
      if (cmd.includes("docker rm -f")) throw new Error("rm boom");
      return "";
    });

    const client = getHetznerContainersClient();
    await expect(
      client.deleteContainer("11111111-1111-4111-8111-111111111111", "org1"),
    ).rejects.toThrow("rm boom");
    expect(deleteRow).not.toHaveBeenCalled();
  });

  test("best-effort `docker stop` failure is swallowed — DISTINCT from an internal failure", async () => {
    // A graceful-stop failure is designed best-effort (J6): rm -f still runs and
    // the delete completes. This proves the swallow is scoped to the non-load-
    // bearing stop, not the authoritative teardown above.
    execMock.mockImplementation(async (cmd: string) => {
      if (cmd.includes("docker stop")) throw new Error("stop boom");
      return "";
    });

    const client = getHetznerContainersClient();
    await expect(
      client.deleteContainer("11111111-1111-4111-8111-111111111111", "org1"),
    ).resolves.toBeUndefined();
    expect(deleteRow).toHaveBeenCalledTimes(1);
  });

  test("SSH connection failure during teardown surfaces as a typed HetznerClientError", async () => {
    // execOnNode J2 boundary translation: connection-level SSH errors are
    // reclassified (so routes 503) but still THROW — never swallowed to success.
    execMock.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:22");
    });

    const client = getHetznerContainersClient();
    await expect(
      client.deleteContainer("11111111-1111-4111-8111-111111111111", "org1"),
    ).rejects.toMatchObject({
      code: "ssh_unreachable",
    });
    expect(deleteRow).not.toHaveBeenCalled();
  });
});

describe("billing stop — provider absence proof", () => {
  test("a successful docker removal reports a fresh provider acknowledgement", async () => {
    const client = getHetznerContainersClient();
    await expect(
      client.stopContainerRuntimeForBilling("11111111-1111-4111-8111-111111111111", "org1", 7),
    ).resolves.toEqual({
      nodeId: "node-1",
      alreadyAbsent: false,
    });
  });

  test("a retry after docker removal confirms exact container absence", async () => {
    execMock.mockImplementation(async (cmd: string) => {
      if (cmd.includes("docker rm -f")) {
        throw new Error(
          "[docker-ssh] Command exited with code 1 on 10.0.0.1: [stderr] Error response from daemon: No such container: app-11111111-1111-4111-8111-111111111111",
        );
      }
      return "";
    });

    const client = getHetznerContainersClient();
    await expect(
      client.stopContainerRuntimeForBilling("11111111-1111-4111-8111-111111111111", "org1", 7),
    ).resolves.toEqual({
      nodeId: "node-1",
      alreadyAbsent: true,
    });
  });

  test("malformed provider metadata cannot fabricate runtime absence", async () => {
    readMetadata.mockReturnValue(null);
    const client = getHetznerContainersClient();
    await expect(
      client.stopContainerRuntimeForBilling("11111111-1111-4111-8111-111111111111", "org1", 7),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(execMock).not.toHaveBeenCalled();
  });

  test("generic not-found text remains a retryable provider failure", async () => {
    execMock.mockImplementation(async (cmd: string) => {
      if (cmd.includes("docker rm -f")) throw new Error("docker helper binary not found");
      return "";
    });
    const client = getHetznerContainersClient();
    await expect(
      client.stopContainerRuntimeForBilling("11111111-1111-4111-8111-111111111111", "org1", 7),
    ).rejects.toThrow("docker helper binary not found");
  });
});

describe("read path — designed-empty stays distinct from internal failure", () => {
  test("listContainers returns [] for a legitimately-empty org (200 with no rows)", async () => {
    listByOrganization.mockResolvedValue([]);
    const client = getHetznerContainersClient();
    await expect(client.listContainers("org1")).resolves.toEqual([]);
  });

  test("listContainers PROPAGATES a repository failure instead of masking it as empty", async () => {
    listByOrganization.mockImplementation(async () => {
      throw new Error("db down");
    });
    const client = getHetznerContainersClient();
    await expect(client.listContainers("org1")).rejects.toThrow("db down");
  });
});

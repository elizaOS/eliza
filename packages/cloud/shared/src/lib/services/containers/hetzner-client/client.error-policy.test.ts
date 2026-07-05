// Pins the fail-closed error policy of HetznerContainersClient: an authoritative
// host-teardown failure (the un-caught `docker rm -f`) must PROPAGATE and leave
// the control-plane row intact, while a best-effort `docker stop` failure and a
// legitimately-empty list stay distinct from an internal failure. Harness is a
// deterministic in-process fake (mocked repositories + SSH client); no live
// Hetzner node or DB is reached.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// bun runs cloud-shared test files in one process and `mock.module` overrides
// are process-global; snapshot the real modules first and reinstall them in
// afterAll so these stubs never leak into sibling files.
import * as realContainersRepo from "../../../../db/repositories/containers";
import * as realDockerNodesRepo from "../../../../db/repositories/docker-nodes";
import * as realDockerSsh from "../../docker-ssh";
import * as realHetznerVolumes from "../hetzner-volumes";
import * as realMetadata from "./metadata";

const realContainersRepoSnap = { ...realContainersRepo };
const realDockerNodesRepoSnap = { ...realDockerNodesRepo };
const realHetznerVolumesSnap = { ...realHetznerVolumes };
const realDockerSshSnap = { ...realDockerSsh };
const realMetadataSnap = { ...realMetadata };

const findById = mock(async (_id: string, _org: string): Promise<unknown> => null);
const listByOrganization = mock(async (_org: string): Promise<unknown[]> => []);
const deleteRow = mock(async (_id: string, _org: string): Promise<void> => {});
const tryReleaseNodeSlot = mock(async (): Promise<void> => {});
const updateRow = mock(async (): Promise<unknown> => null);
const updateStatus = mock(async (): Promise<void> => {});

const readMetadata = mock((_row: unknown): unknown => null);

const execMock = mock(async (_cmd: string, _timeout?: number): Promise<string> => "");
const fakeSsh = { exec: execMock, execStream: mock(async () => {}) };
const getClient = mock(() => fakeSsh);
const findByNodeId = mock(async (_id: string): Promise<unknown> => null);

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
  },
}));

mock.module("../../../../db/repositories/docker-nodes", () => ({
  ...realDockerNodesRepo,
  dockerNodesRepository: {
    ...realDockerNodesRepo.dockerNodesRepository,
    findByNodeId,
  },
}));

mock.module("../hetzner-volumes", () => ({
  ...realHetznerVolumes,
  isHetznerVolumesAvailable: () => false,
  getHetznerVolumeService: () => ({}),
}));

mock.module("../../docker-ssh", () => ({
  ...realDockerSsh,
  DockerSSHClient: { getClient },
}));

mock.module("./metadata", () => ({
  ...realMetadata,
  readMetadata,
}));

const { getHetznerContainersClient } = await import("./client");

const META = {
  provider: "hetzner-docker" as const,
  nodeId: "node-1",
  hostname: "10.0.0.1",
  containerName: "app-ct1",
  hostPort: 8080,
  image: "ghcr.io/elizaos/eliza:stable",
  containerPort: 3000,
};

const ROW = { id: "ct1", organization_id: "org1", hcloud_volume_id: null };

afterAll(() => {
  mock.module("../../../../db/repositories/containers", () => realContainersRepoSnap);
  mock.module("../../../../db/repositories/docker-nodes", () => realDockerNodesRepoSnap);
  mock.module("../hetzner-volumes", () => realHetznerVolumesSnap);
  mock.module("../../docker-ssh", () => realDockerSshSnap);
  mock.module("./metadata", () => realMetadataSnap);
});

beforeEach(() => {
  for (const m of [
    findById,
    listByOrganization,
    deleteRow,
    tryReleaseNodeSlot,
    updateRow,
    updateStatus,
    readMetadata,
    execMock,
    getClient,
    findByNodeId,
  ]) {
    m.mockReset();
  }
  findById.mockResolvedValue(ROW);
  listByOrganization.mockResolvedValue([]);
  deleteRow.mockResolvedValue(undefined);
  tryReleaseNodeSlot.mockResolvedValue(undefined);
  updateRow.mockResolvedValue(null);
  updateStatus.mockResolvedValue(undefined);
  readMetadata.mockReturnValue(META);
  execMock.mockResolvedValue("");
  getClient.mockReturnValue(fakeSsh);
  findByNodeId.mockResolvedValue(null);
});

describe("deleteContainer — fail-closed host teardown", () => {
  test("happy path removes the container and then deletes the control-plane row", async () => {
    const client = getHetznerContainersClient();
    await expect(client.deleteContainer("ct1", "org1")).resolves.toBeUndefined();

    const cmds = execMock.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c.includes("docker rm -f"))).toBe(true);
    expect(deleteRow).toHaveBeenCalledTimes(1);
    expect(deleteRow.mock.calls[0]).toEqual(["ct1", "org1"]);
  });

  test("authoritative `docker rm -f` failure PROPAGATES and the row is NOT deleted", async () => {
    // The un-caught rm -f is the real teardown; if it fails we must not silently
    // delete the DB row (that would leak a live Docker container). Fail closed.
    execMock.mockImplementation(async (cmd: string) => {
      if (cmd.includes("docker rm -f")) throw new Error("rm boom");
      return "";
    });

    const client = getHetznerContainersClient();
    await expect(client.deleteContainer("ct1", "org1")).rejects.toThrow("rm boom");
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
    await expect(client.deleteContainer("ct1", "org1")).resolves.toBeUndefined();
    expect(deleteRow).toHaveBeenCalledTimes(1);
  });

  test("SSH connection failure during teardown surfaces as a typed HetznerClientError", async () => {
    // execOnNode J2 boundary translation: connection-level SSH errors are
    // reclassified (so routes 503) but still THROW — never swallowed to success.
    execMock.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:22");
    });

    const client = getHetznerContainersClient();
    await expect(client.deleteContainer("ct1", "org1")).rejects.toMatchObject({
      code: "ssh_unreachable",
    });
    expect(deleteRow).not.toHaveBeenCalled();
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

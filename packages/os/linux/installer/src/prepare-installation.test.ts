import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorySourceOptions } from "./factory-source";
import { prepareInstallationFilesystems } from "./prepare-installation";
import type { PlannedPartition } from "./types";

const dependencies = vi.hoisted(() => ({ stage: vi.fn(), build: vi.fn() }));
vi.mock("./factory-source", () => ({
  stageFactorySources: dependencies.stage,
}));
vi.mock("./filesystem-image", () => ({
  buildFilesystemImage: dependencies.build,
}));
const mib = 1024 ** 2;
const layout = (): PlannedPartition[] => [
  { role: "esp", filesystem: "fat32", startBytes: mib, endBytes: 513 * mib },
  {
    role: "recovery",
    filesystem: "ext4",
    startBytes: 513 * mib,
    endBytes: 577 * mib,
  },
  {
    role: "root",
    filesystem: "ext4",
    startBytes: 577 * mib,
    endBytes: 705 * mib,
  },
  {
    role: "state",
    filesystem: "ext4",
    startBytes: 705 * mib,
    endBytes: 769 * mib,
  },
];
// These tests isolate orchestration; the VM suite exercises real source handles,
// signed manifests, filesystem tools and UUID-based mounts.
const options = () =>
  ({
    storage: { directoryPath: "/private/store", disk: { stableId: "storage" } },
  }) as FactorySourceOptions;

beforeEach(() => vi.resetAllMocks());
describe("installation filesystem preparation", () => {
  it("rejects incomplete, reused and overlapping layouts before staging", async () => {
    const missing = layout().slice(1);
    const reused = layout();
    reused[0] = {
      ...reused[0],
      reusePartitionId: "existing",
    } as PlannedPartition;
    const overlap = layout();
    overlap[1] = {
      role: "recovery",
      filesystem: "ext4",
      startBytes: mib,
      endBytes: 65 * mib,
    };
    for (const partitions of [missing, reused, overlap])
      await expect(
        prepareInstallationFilesystems(options(), partitions, 512),
      ).rejects.toMatchObject({ code: "ELIZAOS_INSTALL_PREPARATION_ERROR" });
    expect(dependencies.stage).not.toHaveBeenCalled();
    expect(dependencies.build).not.toHaveBeenCalled();
  });

  it("snapshots the reviewed layout and binds every prepared filesystem identity", async () => {
    let release: (value: unknown) => void = () => {
      throw new Error("staging not started");
    };
    dependencies.stage.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    dependencies.build.mockImplementation(
      async (
        _storage,
        partition,
        _sector,
        _signal,
        _source,
        _boot,
        mounts,
      ) => ({
        uuid: mounts?.rootUuid ?? `${partition.role}-uuid`,
        sizeBytes: partition.endBytes - partition.startBytes,
        filesystem: partition.filesystem,
        storageStableId: "storage",
        sha256: "a".repeat(64),
      }),
    );
    const partitions = layout();
    const input = options();
    const operation = prepareInstallationFilesystems(input, partitions, 4096);
    partitions[0] = { ...partitions[0], endBytes: mib } as PlannedPartition;
    input.storage.directoryPath = "/changed";
    release({
      manifest: { architecture: "x86_64", boot: { kernelPath: "/kernel" } },
      sources: { recovery: { sha256: "recovery" }, esp: { sha256: "esp" } },
    });
    const result = await operation;
    expect(dependencies.build.mock.calls.map((call) => call[1].role)).toEqual([
      "state",
      "recovery",
      "esp",
      "root",
    ]);
    for (const call of dependencies.build.mock.calls)
      expect(call[0].directoryPath).toBe("/private/store");
    const espCall = dependencies.build.mock.calls[2];
    const rootCall = dependencies.build.mock.calls[3];
    expect(espCall?.[1].endBytes).toBe(513 * mib);
    expect(espCall?.[5]).toMatchObject({
      rootUuid: result.images.root.uuid,
      recoveryUuid: result.images.recovery.uuid,
    });
    expect(rootCall?.[6]).toEqual({
      rootUuid: result.images.root.uuid,
      homeUuid: result.images.state.uuid,
      espUuid: result.images.esp.uuid,
    });
    expect(Object.isFrozen(result.images)).toBe(true);
    expect(Object.isFrozen(result.images.root)).toBe(true);
  });

  it("does not build filesystems when authentication fails or cancellation is already requested", async () => {
    dependencies.stage.mockRejectedValue(new Error("invalid signature"));
    await expect(
      prepareInstallationFilesystems(options(), layout(), 512),
    ).rejects.toThrow("invalid signature");
    await expect(
      prepareInstallationFilesystems(
        { ...options(), signal: AbortSignal.abort(new Error("cancelled")) },
        layout(),
        512,
      ),
    ).rejects.toThrow("cancelled");
    expect(dependencies.stage).toHaveBeenCalledTimes(1);
    expect(dependencies.build).not.toHaveBeenCalled();
  });
});

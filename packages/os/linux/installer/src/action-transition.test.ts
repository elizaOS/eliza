import { describe, expect, it } from "vitest";
import { assertInstallActionTransition } from "./action-transition";
import { applyTestInventoryAction } from "./test-inventory";
import type {
  DiskInventory,
  InstallerAction,
  PartitionInventory,
} from "./types";

const GIB = 1024 ** 3;
function partitionAt(disk: DiskInventory, index: number): PartitionInventory {
  const partition = disk.partitions.at(index);
  if (!partition) throw new Error(`Missing fixture partition ${index}`);
  return partition;
}
function inventory(): DiskInventory {
  return {
    stableId: "disk",
    path: "/dev/disk/by-id/test",
    sizeBytes: 64 * GIB,
    logicalSectorBytes: 512,
    partitionTable: "gpt",
    gptRedundancyVerified: true,
    bootAncestryResolved: true,
    currentBootSource: false,
    firmware: "uefi",
    hardwareIdentity: {
      serial: "test",
      firmwarePath: "/sys/test",
      gptDiskGuid: "11111111-2222-4333-8444-555555555555",
    },
    freeExtents: [],
    partitions: [
      {
        id: "esp",
        startBytes: 1024 ** 2,
        endBytes: GIB,
        filesystem: "fat32",
        role: "esp",
        encryption: "none",
        mounted: false,
      },
      {
        id: "root",
        startBytes: GIB,
        endBytes: 32 * GIB,
        filesystem: "ext4",
        role: "os",
        encryption: "none",
        mounted: false,
      },
    ],
  };
}
const shrink: InstallerAction = {
  type: "shrink-partition",
  partitionId: "root",
  newEndBytes: 16 * GIB,
  destructive: true,
};
const create: InstallerAction = {
  type: "create-partition",
  destructive: true,
  partition: {
    role: "state",
    filesystem: "ext4",
    startBytes: 40 * GIB,
    endBytes: 63 * GIB,
  },
};

describe("installer action inventory postconditions", () => {
  it("allows only the exact reviewed shrink and preserves other partitions", () => {
    const before = inventory();
    const after = structuredClone(before);
    expect(() => assertInstallActionTransition(shrink, before, after)).toThrow(
      /reviewed operation/,
    );
    applyTestInventoryAction(after, shrink);
    expect(() =>
      assertInstallActionTransition(shrink, before, after),
    ).not.toThrow();
    partitionAt(after, 0).id = "replacement-esp";
    expect(() => assertInstallActionTransition(shrink, before, after)).toThrow(
      /identity/,
    );
  });

  it.each(["geometry", "filesystem", "encryption", "extra partition"])(
    "refuses creation with unexpected %s",
    (mutation) => {
      const before = inventory();
      const after = structuredClone(before);
      applyTestInventoryAction(after, create);
      expect(() =>
        assertInstallActionTransition(create, before, after),
      ).not.toThrow();
      const added = partitionAt(after, -1);
      if (mutation === "geometry") added.startBytes += 1024 ** 2;
      if (mutation === "filesystem") added.filesystem = "unknown";
      if (mutation === "encryption") added.encryption = "unknown";
      if (mutation === "extra partition")
        after.partitions.push({ ...added, id: "extra" });
      expect(() =>
        assertInstallActionTransition(create, before, after),
      ).toThrow(/Unexpected partition transition/);
    },
  );

  it.each<InstallerAction>([
    { type: "reuse-esp", partitionId: "esp", destructive: false },
    {
      type: "install-system",
      rootStartBytes: GIB,
      rootEndBytes: 32 * GIB,
      destructive: true,
    },
    { type: "install-bootloader", espPartitionId: "esp", destructive: true },
  ])("requires $type to leave the partition table unchanged", (action) => {
    const before = inventory();
    const after = structuredClone(before);
    expect(() =>
      assertInstallActionTransition(action, before, after),
    ).not.toThrow();
    partitionAt(after, 1).endBytes -= GIB;
    expect(() => assertInstallActionTransition(action, before, after)).toThrow(
      /reviewed operation/,
    );
  });

  it("refuses image or boot targets absent from the observed layout", () => {
    const before = inventory();
    expect(() =>
      assertInstallActionTransition(
        {
          type: "install-system",
          rootStartBytes: 40 * GIB,
          rootEndBytes: 63 * GIB,
          destructive: true,
        },
        before,
        before,
      ),
    ).toThrow(/image target/);
    expect(() =>
      assertInstallActionTransition(
        { type: "reuse-esp", partitionId: "root", destructive: false },
        before,
        before,
      ),
    ).toThrow(/FAT32 ESP/);
    before.partitions.push({ ...partitionAt(before, 0), id: "second-esp" });
    expect(() =>
      assertInstallActionTransition(
        { type: "install-bootloader", destructive: true },
        before,
        before,
      ),
    ).toThrow(/ambiguous/);
  });

  it("allows GPT identity replacement only for a verified empty erase result", () => {
    const before = inventory();
    const after = structuredClone(before);
    after.hardwareIdentity.gptDiskGuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(() => assertInstallActionTransition(create, before, after)).toThrow(
      /GPT disk identity/,
    );
    const erase: InstallerAction = {
      type: "erase-partition-table",
      diskStableId: "disk",
      destructive: true,
    };
    expect(() => assertInstallActionTransition(erase, before, after)).toThrow(
      /existing partitions/,
    );
    after.partitions = [];
    expect(() =>
      assertInstallActionTransition(erase, before, after),
    ).not.toThrow();
    after.gptRedundancyVerified = false;
    expect(() => assertInstallActionTransition(erase, before, after)).toThrow(
      /verified redundant GPT/,
    );
  });
});

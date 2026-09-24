import { describe, expect, it } from "vitest";
import {
  createDiskConfirmationToken,
  createDiskInventoryFingerprint,
  createInstallPlan,
  validateDiskInventory,
} from "./planner";
import type {
  DiskInventory,
  InstallRequest,
  PartitionInventory,
} from "./types";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function disk(overrides: Partial<DiskInventory> = {}): DiskInventory {
  return {
    stableId: "nvme-serial-123",
    path: "/dev/nvme0n1",
    hardwareIdentity: {
      serial: "S3Z9NB0K123456",
      wwn: "eui.002538b221aabbcc",
      firmwarePath: "/sys/devices/pci0000:00/0000:00:04.0/nvme/nvme0",
      gptDiskGuid: "56f01c36-1e33-4b83-8ec6-f7a0e3c4af2e",
    },
    sizeBytes: 512 * GIB,
    logicalSectorBytes: 512,
    partitionTable: "gpt",
    gptRedundancyVerified: true,
    bootAncestryResolved: true,
    currentBootSource: false,
    firmware: "uefi",
    partitions: [
      {
        id: "esp",
        startBytes: MIB,
        endBytes: 513 * MIB,
        mounted: false,
        role: "esp",
        filesystem: "fat32",
        encryption: "none",
      },
      {
        id: "host-os",
        startBytes: 513 * MIB,
        endBytes: 300 * GIB,
        mounted: false,
        role: "os",
        filesystem: "ntfs",
        osFamily: "windows",
        hibernated: false,
        encryption: "none",
      },
    ],
    freeExtents: [{ id: "free-1", startBytes: 300 * GIB, endBytes: 511 * GIB }],
    ...overrides,
  };
}

function partition(index: number): PartitionInventory {
  const value = disk().partitions[index];
  if (!value) throw new Error(`Missing test partition ${index}.`);
  return value;
}

function request(
  target: DiskInventory,
  overrides: Partial<InstallRequest> = {},
): InstallRequest {
  return {
    mode: "alongside",
    targetStableId: target.stableId,
    expectedSizeBytes: target.sizeBytes,
    confirmationToken: createDiskConfirmationToken(target),
    freeExtentId: "free-1",
    ...overrides,
  };
}

describe("elizaOS internal-disk installer planner", () => {
  it("creates a deterministic, non-executable erase plan bound to disk identity", () => {
    const target = disk({ freeExtents: [] });
    const input = request(target, {
      mode: "erase-disk",
      freeExtentId: undefined,
    });
    const first = createInstallPlan(input, target);
    const second = createInstallPlan(input, target);

    expect(first).toEqual(second);
    expect(first.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.executable).toBe(false);
    expect(first.actions[0]).toMatchObject({
      type: "erase-partition-table",
      destructive: true,
    });
    expect(first.preservedPartitionIds).toEqual([]);
    expect(first.target.hardwareIdentity).toEqual(target.hardwareIdentity);
    expect(first.target.logicalSectorBytes).toBe(512);
  });

  it.each([
    ["Windows", { filesystem: "ntfs", osFamily: "windows" }],
    ["macOS on Intel", { filesystem: "apfs", osFamily: "macos" }],
    ["Linux", { filesystem: "ext4", osFamily: "linux" }],
  ] as const)(
    "plans alongside %s only inside verified free space",
    (_name, host) => {
      const target = disk({
        firmware: host.osFamily === "macos" ? "apple-intel-efi" : "uefi",
        partitions: [
          partition(0),
          {
            ...partition(1),
            ...host,
            hibernated: host.osFamily === "windows" ? false : undefined,
          } as PartitionInventory,
        ],
      });
      const plan = createInstallPlan(request(target), target);

      expect(plan.preservedPartitionIds).toEqual(["esp", "host-os"]);
      expect(
        plan.actions.some((action) => action.type === "erase-partition-table"),
      ).toBe(false);
      expect(plan.actions).toContainEqual({
        type: "reuse-esp",
        partitionId: "esp",
        destructive: false,
      });
      expect(
        plan.partitions
          .filter((part) => !part.reusePartitionId)
          .every((part) => part.startBytes >= 300 * GIB),
      ).toBe(true);
      expect(plan.compatibility.preparationRequiredInExistingOs).toBe(
        host.osFamily === "macos",
      );
    },
  );

  it("plans a verified Windows NTFS shrink but keeps the plan non-executable", () => {
    const target = disk({
      partitions: [
        partition(0),
        {
          ...partition(1),
          endBytes: 500 * GIB,
          resize: {
            filesystemHealthy: true,
            mounted: false,
            minimumBytes: 200 * GIB,
            bitlocker: "suspended",
            hibernated: false,
            dirty: false,
          },
        },
      ],
      freeExtents: [],
    });
    const plan = createInstallPlan(
      request(target, {
        freeExtentId: undefined,
        shrinkPartitionId: "host-os",
      }),
      target,
    );

    expect(plan.actions[0]).toMatchObject({
      type: "shrink-partition",
      partitionId: "host-os",
    });
    expect(plan.compatibility.automaticShrinkSupported).toBe(true);
    expect(plan.executable).toBe(false);
  });

  it("refuses free-space installation while any target descendant is mounted", () => {
    const target = disk({
      partitions: [partition(0), { ...partition(1), mounted: true }],
    });
    expect(() => createInstallPlan(request(target), target)).toThrow(
      /stacked descendant is mounted/,
    );
  });

  it("refuses free-space alongside installation for hibernated or dirty hosts", () => {
    const hibernated = disk({
      partitions: [partition(0), { ...partition(1), hibernated: true }],
    });
    expect(() => createInstallPlan(request(hibernated), hibernated)).toThrow(
      /hibernation and Fast Startup/,
    );

    const dirty = disk({
      partitions: [partition(0), { ...partition(1), dirty: true }],
    });
    expect(() => createInstallPlan(request(dirty), dirty)).toThrow(
      /filesystem is dirty/,
    );
  });

  it("refuses free-space alongside planning when Windows hibernation state is unknown", () => {
    const windowsPartition = { ...partition(1) };
    delete windowsPartition.hibernated;
    const target = disk({
      partitions: [partition(0), windowsPartition],
    });

    expect(() => createInstallPlan(request(target), target)).toThrow(
      /without explicit evidence.*hibernation and Fast Startup/i,
    );
  });

  it("refuses free-space alongside planning for an opaque BitLocker volume", () => {
    const target = disk({
      partitions: [
        partition(0),
        {
          ...partition(1),
          filesystem: "unknown",
          osFamily: "windows",
          encryption: "bitlocker",
          hibernated: undefined,
        },
      ],
    });

    expect(() => createInstallPlan(request(target), target)).toThrow(
      /without explicit evidence.*hibernation and Fast Startup/i,
    );
  });

  it("binds hibernation and dirty-state evidence into inventory identity", () => {
    const clean = disk({
      partitions: [
        partition(0),
        { ...partition(1), hibernated: false, dirty: false },
      ],
    });
    const hibernated = disk({
      partitions: [
        partition(0),
        { ...partition(1), hibernated: true, dirty: false },
      ],
    });
    const dirty = disk({
      partitions: [
        partition(0),
        { ...partition(1), hibernated: false, dirty: true },
      ],
    });

    expect(createDiskInventoryFingerprint(hibernated)).not.toBe(
      createDiskInventoryFingerprint(clean),
    );
    expect(createDiskInventoryFingerprint(dirty)).not.toBe(
      createDiskInventoryFingerprint(clean),
    );
  });

  it("requires explicit BitLocker evidence before planning an NTFS shrink", () => {
    const target = disk({
      partitions: [
        partition(0),
        {
          ...partition(1),
          endBytes: 500 * GIB,
          resize: {
            filesystemHealthy: true,
            mounted: false,
            minimumBytes: 200 * GIB,
            hibernated: false,
            dirty: false,
          },
        },
      ],
      freeExtents: [],
    });
    expect(() =>
      createInstallPlan(
        request(target, {
          freeExtentId: undefined,
          shrinkPartitionId: "host-os",
        }),
        target,
      ),
    ).toThrow(/BitLocker off or suspended/);
  });

  it.each([
    ["BitLocker", { encryption: "bitlocker" as const }],
    [
      "FileVault",
      {
        encryption: "filevault" as const,
        filesystem: "apfs" as const,
        osFamily: "macos" as const,
        hibernated: undefined,
      },
    ],
    [
      "LUKS",
      {
        encryption: "luks" as const,
        filesystem: "ext4" as const,
        osFamily: "linux" as const,
        hibernated: undefined,
      },
    ],
  ])(
    "blocks automatic shrinking of %s-encrypted partitions",
    (_name, override) => {
      const target = disk({
        firmware:
          "osFamily" in override && override.osFamily === "macos"
            ? "apple-intel-efi"
            : "uefi",
        partitions: [
          partition(0),
          {
            ...partition(1),
            ...override,
            endBytes: 500 * GIB,
            resize: {
              filesystemHealthy: true,
              mounted: false,
              minimumBytes: 200 * GIB,
              hibernated: false,
              dirty: false,
            },
          },
        ],
        freeExtents: [],
      });
      expect(() =>
        createInstallPlan(
          request(target, {
            freeExtentId: undefined,
            shrinkPartitionId: "host-os",
          }),
          target,
        ),
      ).toThrow(/Encrypted|APFS/);
    },
  );

  it.each([
    ["hibernated", { hibernated: true, dirty: false }],
    ["dirty", { hibernated: false, dirty: true }],
    [
      "unhealthy",
      { hibernated: false, dirty: false, filesystemHealthy: false },
    ],
  ])(
    "blocks a %s Windows filesystem before planning a shrink",
    (_name, evidenceOverride) => {
      const target = disk({
        partitions: [
          partition(0),
          {
            ...partition(1),
            endBytes: 500 * GIB,
            resize: {
              filesystemHealthy: true,
              mounted: false,
              minimumBytes: 200 * GIB,
              bitlocker: "off",
              ...evidenceOverride,
            },
          },
        ],
        freeExtents: [],
      });
      expect(() =>
        createInstallPlan(
          request(target, {
            freeExtentId: undefined,
            shrinkPartitionId: "host-os",
          }),
          target,
        ),
      ).toThrow();
    },
  );

  it("blocks generic Apple Silicon alongside claims", () => {
    const target = disk({ firmware: "apple-silicon" });
    expect(() => createInstallPlan(request(target), target)).toThrow(
      "Asahi/m1n1",
    );
  });

  it("rejects stale identity, current boot media, and overlapping inventory", () => {
    const target = disk();
    expect(() =>
      createInstallPlan(
        { ...request(target), expectedSizeBytes: target.sizeBytes + 1 },
        target,
      ),
    ).toThrow("identity changed");
    expect(() =>
      createInstallPlan(request({ ...target, currentBootSource: true }), {
        ...target,
        currentBootSource: true,
      }),
    ).toThrow("booted the installer");
    expect(() =>
      validateDiskInventory({
        ...target,
        freeExtents: [
          { id: "overlap", startBytes: 200 * GIB, endBytes: 400 * GIB },
        ],
      }),
    ).toThrow("Overlapping");
  });

  it("invalidates owner confirmation when the reviewed partition layout changes", () => {
    const reviewed = disk();
    const reviewedRequest = request(reviewed);
    const changed = disk({
      partitions: [partition(0), { ...partition(1), endBytes: 299 * GIB }],
    });
    expect(() => createInstallPlan(reviewedRequest, changed)).toThrow(
      "confirmation token is missing or stale",
    );
  });

  it("binds plans to hardware, GPT, and resolved boot ancestry", () => {
    const target = disk();
    const reviewed = createInstallPlan(request(target), target);

    for (const changed of [
      disk({
        hardwareIdentity: {
          ...target.hardwareIdentity,
          serial: "S3Z9NB0K654321",
        },
      }),
      disk({
        hardwareIdentity: {
          ...target.hardwareIdentity,
          wwn: "eui.002538b221ddeeff",
        },
      }),
      disk({
        hardwareIdentity: {
          ...target.hardwareIdentity,
          firmwarePath: "/sys/devices/pci0000:00/0000:00:05.0/nvme/nvme0",
        },
      }),
      disk({ logicalSectorBytes: 4096 }),
      disk({
        hardwareIdentity: {
          ...target.hardwareIdentity,
          gptDiskGuid: "11385e1d-df71-4d61-93cd-13f272f15e7a",
        },
      }),
    ]) {
      expect(createInstallPlan(request(changed), changed).planId).not.toBe(
        reviewed.planId,
      );
    }
    expect(() =>
      createInstallPlan(
        request(disk({ gptRedundancyVerified: false })),
        disk({ gptRedundancyVerified: false }),
      ),
    ).toThrow(/GPT main\/backup redundancy is unverified/);
    expect(() =>
      createInstallPlan(
        request(disk({ bootAncestryResolved: false })),
        disk({ bootAncestryResolved: false }),
      ),
    ).toThrow(/boot-device ancestry is unresolved/);
  });

  it("rejects unknown runtime inventory enum values and malformed probe evidence", () => {
    expect(() =>
      validateDiskInventory({
        ...disk(),
        firmware: "invented" as DiskInventory["firmware"],
      }),
    ).toThrow("firmware inventory");
    expect(() =>
      validateDiskInventory({
        ...disk(),
        hardwareIdentity: {
          ...disk().hardwareIdentity,
          serial: "",
          wwn: undefined,
        },
      }),
    ).toThrow("hardware identity");
    const missingMountState = partition(1);
    delete (missingMountState as Partial<PartitionInventory>).mounted;
    expect(() =>
      validateDiskInventory({
        ...disk(),
        partitions: [partition(0), missingMountState],
      }),
    ).toThrow("mount state");
    expect(() =>
      validateDiskInventory({
        ...disk(),
        partitions: [
          partition(0),
          {
            ...partition(1),
            mounted: true,
            resize: {
              filesystemHealthy: true,
              mounted: false,
              minimumBytes: 200 * GIB,
            },
          },
        ],
      }),
    ).toThrow("resize evidence");
    expect(() =>
      validateDiskInventory({
        ...disk(),
        partitions: [
          partition(0),
          {
            ...partition(1),
            filesystem: "ext4",
            osFamily: "linux",
            hibernated: false,
          },
        ],
      }),
    ).toThrow("outside Windows NTFS");
    expect(() =>
      validateDiskInventory({
        ...disk(),
        partitions: [
          partition(0),
          {
            ...partition(1),
            hibernated: true,
            resize: {
              filesystemHealthy: true,
              mounted: false,
              minimumBytes: 200 * GIB,
              hibernated: false,
            },
          },
        ],
      }),
    ).toThrow("resize evidence");
    expect(() =>
      validateDiskInventory({
        ...disk(),
        partitions: [
          partition(0),
          {
            ...partition(1),
            filesystemHealth: "dirty",
            resize: {
              filesystemHealthy: true,
              mounted: false,
              minimumBytes: 200 * GIB,
            },
          },
        ],
      }),
    ).toThrow("resize evidence");
    const missingGptVerification = disk();
    delete missingGptVerification.gptRedundancyVerified;
    expect(() => validateDiskInventory(missingGptVerification)).toThrow(
      "GPT inventory",
    );
    expect(() =>
      validateDiskInventory({
        ...disk(),
        bootAncestryResolved: undefined as unknown as boolean,
      }),
    ).toThrow("Boot ancestry inventory");
    const mbrInventory = disk({
      partitionTable: "mbr",
      gptRedundancyVerified: undefined,
      hardwareIdentity: {
        ...disk().hardwareIdentity,
        gptDiskGuid: undefined,
      },
    });
    expect(() => validateDiskInventory(mbrInventory)).not.toThrow();
    expect(() =>
      validateDiskInventory({ ...mbrInventory, gptRedundancyVerified: true }),
    ).toThrow("GPT inventory");
    expect(() =>
      validateDiskInventory({
        ...disk(),
        hardwareIdentity: { ...disk().hardwareIdentity, gptDiskGuid: "bad" },
      }),
    ).toThrow("hardware identity");
    expect(() =>
      validateDiskInventory({
        ...disk(),
        partitions: [
          partition(0),
          {
            ...partition(1),
            resize: {
              filesystemHealthy: true,
              mounted: false,
              minimumBytes: 1.5,
            },
          },
        ],
      }),
    ).toThrow("minimumBytes");
  });
});

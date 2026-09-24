import { describe, expect, it, vi } from "vitest";
import type {
  LinuxInventoryCommandResult,
  LinuxInventoryCommandRunner,
} from "./linux-inventory";
import {
  assertLinuxInventorySnapshotUnchanged,
  isSgdiskRedundancyVerified,
  LinuxInstallInventoryProvider,
  parseLinuxBootAncestorPaths,
  parseLinuxLsblkInventory,
  parseLinuxRootBlockSource,
  probeLinuxBtrfsFilesystem,
  probeLinuxExt4Filesystem,
  probeLinuxNtfsFilesystem,
  probeLinuxPartitionFilesystems,
} from "./linux-inventory";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: vi.fn(async () => ({ isSymbolicLink: () => true })),
    realpath: vi.fn(async () => "/dev/vda"),
  };
});

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function serializedInventory(
  overrides: Record<string, unknown> = {},
  partitionOverrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    blockdevices: [
      {
        path: "/dev/vda",
        kname: "/dev/vda",
        pkname: null,
        type: "disk",
        size: 128 * GIB,
        "log-sec": 512,
        pttype: "gpt",
        ptuuid: "b5afe67e-7ed7-4f10-99bd-efb8173c53ce",
        fstype: null,
        mountpoints: [null],
        parttype: null,
        partuuid: null,
        partlabel: null,
        start: null,
        serial: "QEMU-DISK-0001",
        wwn: "0x5000c50012345678",
        ro: false,
        rm: false,
        ...overrides,
      },
      {
        path: "/dev/vda1",
        kname: "/dev/vda1",
        pkname: "/dev/vda",
        type: "part",
        size: 512 * MIB,
        "log-sec": 512,
        pttype: "gpt",
        ptuuid: "b5afe67e-7ed7-4f10-99bd-efb8173c53ce",
        fstype: "vfat",
        mountpoints: [null],
        parttype: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
        partuuid: "b27e2419-9e58-416e-a921-d8d51a443692",
        partlabel: "EFI System Partition",
        start: 2048,
        serial: null,
        wwn: null,
        ro: false,
        rm: false,
      },
      {
        path: "/dev/vda2",
        kname: "/dev/vda2",
        pkname: "/dev/vda",
        type: "part",
        size: 40 * GIB,
        "log-sec": 512,
        pttype: "gpt",
        ptuuid: "b5afe67e-7ed7-4f10-99bd-efb8173c53ce",
        fstype: "ext4",
        mountpoints: [null],
        parttype: "0fc63daf-8483-4772-8e79-3d69d8477de4",
        partuuid: "f498a3cd-f27a-4548-afb0-51ef5b2f0084",
        partlabel: "host-root",
        start: 1_050_624,
        serial: null,
        wwn: null,
        ro: false,
        rm: false,
        ...partitionOverrides,
      },
    ],
  });
}

function parse(
  serialized = serializedInventory(),
  partitionTableVerified = true,
  gptRedundancyVerified = true,
  bootAncestorPaths: readonly string[] = [],
  bootAncestryResolved = true,
) {
  return parseLinuxLsblkInventory({
    stableId: "virtio-QEMU-DISK-0001",
    stablePath: "/dev/disk/by-id/virtio-QEMU-DISK-0001",
    devicePath: "/dev/vda",
    firmwarePath: "/devices/pci0000:00/0000:00:04.0/virtio2/block/vda",
    firmware: "uefi",
    serialized,
    partitionTableVerified,
    gptRedundancyVerified,
    bootAncestorPaths,
    bootAncestryResolved,
  });
}

describe("Linux read-only disk inventory parser", () => {
  it("captures two provider snapshots around filesystem probes and rejects runner drift", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    let diskSnapshot = 0;
    const runner: LinuxInventoryCommandRunner = {
      async run(command, args) {
        calls.push([command, args]);
        if (command === "/usr/bin/findmnt") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              filesystems: [{ source: "overlay", target: "/" }],
            }),
            stderr: "",
          };
        }
        if (command === "/usr/bin/lsblk" && args.includes("--bytes")) {
          diskSnapshot += 1;
          return {
            exitCode: 0,
            stdout: serializedInventory(
              diskSnapshot === 2 ? { size: 129 * GIB } : {},
            ),
            stderr: "",
          };
        }
        if (command === "/usr/bin/udevadm") {
          return {
            exitCode: 0,
            stdout: "/devices/pci0000:00/0000:00:04.0/virtio2/block/vda\n",
            stderr: "",
          };
        }
        if (command === "/usr/sbin/sgdisk") {
          return { exitCode: 0, stdout: "No problems found.\n", stderr: "" };
        }
        if (command === "/usr/sbin/dumpe2fs") {
          return {
            exitCode: 0,
            stdout: "Filesystem state: clean\nBlock size: 4096\n",
            stderr: "",
          };
        }
        if (command === "/usr/sbin/resize2fs") {
          return {
            exitCode: 0,
            stdout: "Estimated minimum size of the filesystem: 1000000\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const provider = new LinuxInstallInventoryProvider({
      runner,
      firmware: "uefi",
      resolveDeviceIdentity: async () => "252:0:17",
    });

    await expect(provider.inspect("virtio-QEMU-DISK-0001")).rejects.toThrow(
      /changed during filesystem probing/,
    );

    const diskProbeIndexes = calls
      .map(([command, args], index) =>
        command === "/usr/bin/lsblk" && args.includes("--bytes") ? index : -1,
      )
      .filter((index) => index !== -1);
    const filesystemProbeIndexes = calls
      .map(([command], index) =>
        command === "/usr/sbin/dumpe2fs" ||
        command === "/usr/sbin/e2fsck" ||
        command === "/usr/sbin/resize2fs"
          ? index
          : -1,
      )
      .filter((index) => index !== -1);
    expect(diskProbeIndexes).toHaveLength(2);
    expect(filesystemProbeIndexes.length).toBeGreaterThan(0);
    expect(Math.max(...filesystemProbeIndexes)).toBeLessThan(
      diskProbeIndexes[1] as number,
    );
    expect(Math.min(...filesystemProbeIndexes)).toBeGreaterThan(
      diskProbeIndexes[0] as number,
    );
    expect(
      calls.filter(([command]) => command === "/usr/bin/findmnt"),
    ).toHaveLength(2);
    expect(
      calls.filter(([command]) => command === "/usr/bin/udevadm"),
    ).toHaveLength(2);
    expect(
      calls.filter(([command]) => command === "/usr/sbin/sfdisk"),
    ).toHaveLength(2);
    expect(
      calls.filter(([command]) => command === "/usr/sbin/sgdisk"),
    ).toHaveLength(2);
  });

  it("rejects same-path block-device replacement before returning inventory", async () => {
    let identityChecks = 0;
    const runner: LinuxInventoryCommandRunner = {
      async run(command, args) {
        if (command === "/usr/bin/findmnt") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              filesystems: [{ source: "overlay", target: "/" }],
            }),
            stderr: "",
          };
        }
        if (command === "/usr/bin/lsblk" && args.includes("--bytes")) {
          return { exitCode: 0, stdout: serializedInventory(), stderr: "" };
        }
        if (command === "/usr/bin/udevadm") {
          return {
            exitCode: 0,
            stdout: "/devices/pci0000:00/0000:00:04.0/virtio2/block/vda\n",
            stderr: "",
          };
        }
        if (command === "/usr/sbin/sgdisk") {
          return { exitCode: 0, stdout: "No problems found.\n", stderr: "" };
        }
        if (command === "/usr/sbin/dumpe2fs") {
          return {
            exitCode: 0,
            stdout: "Filesystem state: clean\nBlock size: 4096\n",
            stderr: "",
          };
        }
        if (command === "/usr/sbin/resize2fs") {
          return {
            exitCode: 0,
            stdout: "Estimated minimum size of the filesystem: 1000000\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const provider = new LinuxInstallInventoryProvider({
      runner,
      firmware: "uefi",
      resolveDeviceIdentity: async () => {
        identityChecks += 1;
        return identityChecks < 4 ? "252:0:17" : "252:0:18";
      },
    });

    await expect(provider.inspect("virtio-QEMU-DISK-0001")).rejects.toThrow(
      /stable ID changed during probing/,
    );
  });

  it("rejects identity, geometry, mount, and GPT drift across filesystem probes", () => {
    const before = parse();
    expect(() =>
      assertLinuxInventorySnapshotUnchanged(before, structuredClone(before)),
    ).not.toThrow();

    const drifted = [
      { ...structuredClone(before), sizeBytes: before.sizeBytes + MIB },
      {
        ...structuredClone(before),
        hardwareIdentity: {
          ...before.hardwareIdentity,
          serial: "QEMU-DISK-REPLACED",
        },
      },
      {
        ...structuredClone(before),
        hardwareIdentity: {
          ...before.hardwareIdentity,
          gptDiskGuid: "706d33b7-afb8-411e-9154-253971d8c5eb",
        },
      },
      {
        ...structuredClone(before),
        partitions: before.partitions.map((partition, index) =>
          index === 1
            ? { ...partition, startBytes: partition.startBytes + MIB }
            : partition,
        ),
      },
      {
        ...structuredClone(before),
        partitions: before.partitions.map((partition, index) =>
          index === 1 ? { ...partition, mounted: true } : partition,
        ),
      },
      { ...structuredClone(before), gptRedundancyVerified: false },
      { ...structuredClone(before), bootAncestryResolved: false },
      { ...structuredClone(before), currentBootSource: true },
    ];

    for (const after of drifted) {
      expect(() =>
        assertLinuxInventorySnapshotUnchanged(before, after),
      ).toThrow(/changed during filesystem probing/);
    }
  });

  it("classifies a clean unmounted btrfs filesystem without inventing resize evidence", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const evidence = await probeLinuxBtrfsFilesystem({
      devicePath: "/dev/vda2",
      runner: {
        async run(command, args) {
          calls.push([command, args]);
          return {
            exitCode: 0,
            stdout: [
              "Opening filesystem to check...",
              "found 163840 bytes used, no error found",
              "[8/8] checking quota groups skipped (not enabled on this FS)",
            ].join("\n"),
            stderr: "",
          };
        },
      },
    });

    expect(evidence).toEqual({ filesystemHealth: "healthy" });
    expect(evidence).not.toHaveProperty("minimumBytes");
    expect(calls).toEqual([
      ["/usr/bin/btrfs", ["check", "--readonly", "/dev/vda2"]],
    ]);
  });

  it("wires btrfs health into partition inventory and skips mounted filesystems", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const runner: LinuxInventoryCommandRunner = {
      async run(command, args) {
        calls.push([command, args]);
        return {
          exitCode: 0,
          stdout: "found 163840 bytes used, no error found\n",
          stderr: "",
        };
      },
    };
    const serialized = serializedInventory({}, { fstype: "btrfs" });
    const partitions = await probeLinuxPartitionFilesystems({
      inventory: parse(serialized),
      serialized,
      runner,
    });

    expect(partitions[1]).toMatchObject({
      filesystem: "btrfs",
      filesystemHealth: "healthy",
    });
    expect(partitions[1]?.resize).toBeUndefined();
    expect(calls).toEqual([
      ["/usr/bin/btrfs", ["check", "--readonly", "/dev/vda2"]],
    ]);

    calls.length = 0;
    const mountedSerialized = serializedInventory(
      {},
      { fstype: "btrfs", mountpoints: ["/srv"] },
    );
    const mounted = await probeLinuxPartitionFilesystems({
      inventory: parse(mountedSerialized),
      serialized: mountedSerialized,
      runner,
    });
    expect(mounted[1]?.filesystemHealth).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("fails btrfs health classification closed on errors and ambiguous output", async () => {
    const probe = async (result: LinuxInventoryCommandResult) =>
      probeLinuxBtrfsFilesystem({
        devicePath: "/dev/vda2",
        runner: {
          async run() {
            return result;
          },
        },
      });

    await expect(
      probe({ exitCode: 1, stdout: "", stderr: "errors found" }),
    ).resolves.toEqual({ filesystemHealth: "unhealthy" });
    await expect(
      probe({
        exitCode: 0,
        stdout: "no error found",
        stderr: "WARNING: checksum mismatch",
      }),
    ).resolves.toEqual({ filesystemHealth: "unhealthy" });
    await expect(
      probe({ exitCode: 0, stdout: "check complete", stderr: "" }),
    ).resolves.toEqual({ filesystemHealth: "unknown" });
    await expect(
      probe({ exitCode: 127, stdout: "", stderr: "not found" }),
    ).resolves.toEqual({ filesystemHealth: "unknown" });
    await expect(
      probeLinuxBtrfsFilesystem({
        devicePath: "/dev/../etc/passwd",
        runner: {
          async run() {
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      }),
    ).rejects.toThrow(/device path/);
  });

  it("derives bounded NTFS evidence from one forensic no-action probe", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const evidence = await probeLinuxNtfsFilesystem({
      devicePath: "/dev/vda2",
      partitionSizeBytes: 8 * GIB,
      runner: {
        async run(command, args) {
          calls.push([command, args]);
          return {
            exitCode: 0,
            stdout: [
              "NTFS volume version: 3.1",
              "Current device size: 8589934592 bytes (8590 MB)",
              "Checking filesystem consistency ...",
              "You might resize at 4294967296 bytes or 4295 MB (freeing 4295 MB).",
            ].join("\n"),
            stderr: "",
          };
        },
      },
    });

    expect(evidence).toEqual({
      filesystemHealth: "healthy",
      dirty: false,
      minimumBytes: 4 * GIB,
    });
    expect(calls).toEqual([
      [
        "/usr/sbin/ntfsresize",
        ["--info", "--no-action", "--no-progress-bar", "/dev/vda2"],
      ],
    ]);
  });

  it("retains typed NTFS hibernation, dirty, and failure evidence", async () => {
    const probe = async (result: LinuxInventoryCommandResult) =>
      probeLinuxNtfsFilesystem({
        devicePath: "/dev/vda2",
        partitionSizeBytes: 8 * GIB,
        runner: {
          async run() {
            return result;
          },
        },
      });

    await expect(
      probe({
        exitCode: 1,
        stdout: "The NTFS partition is hibernated.",
        stderr: "",
      }),
    ).resolves.toEqual({ filesystemHealth: "unknown", hibernated: true });
    await expect(
      probe({
        exitCode: 1,
        stdout: "The NTFS journal file is unclean.",
        stderr: "",
      }),
    ).resolves.toEqual({ filesystemHealth: "dirty", dirty: true });
    await expect(
      probe({ exitCode: 1, stdout: "", stderr: "I/O failure" }),
    ).resolves.toEqual({ filesystemHealth: "unhealthy" });
    await expect(
      probe({ exitCode: 127, stdout: "", stderr: "not found" }),
    ).resolves.toEqual({ filesystemHealth: "unknown" });
    await expect(
      probe({
        exitCode: 0,
        stdout:
          "Current device size: 4294967296 bytes\nYou might resize at 1073741824 bytes\n",
        stderr: "",
      }),
    ).resolves.toEqual({ filesystemHealth: "unhealthy" });
    await expect(
      probeLinuxNtfsFilesystem({
        devicePath: "/dev/../etc/passwd",
        partitionSizeBytes: 8 * GIB,
        runner: {
          async run() {
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      }),
    ).rejects.toThrow(/device path/);
  });

  it("wires NTFS state through the shared dispatcher and fails missing tooling closed", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const runner: LinuxInventoryCommandRunner = {
      async run(command, args) {
        calls.push([command, args]);
        return {
          exitCode: 0,
          stdout: [
            `Current device size: ${40 * GIB} bytes`,
            `You might resize at ${8 * GIB} bytes`,
          ].join("\n"),
          stderr: "",
        };
      },
    };
    const serialized = serializedInventory({}, { fstype: "ntfs" });
    const partitions = await probeLinuxPartitionFilesystems({
      inventory: parse(serialized),
      serialized,
      runner,
    });

    expect(partitions[1]).toMatchObject({
      filesystem: "ntfs",
      osFamily: "windows",
      encryption: "unknown",
      filesystemHealth: "healthy",
      dirty: false,
      resize: {
        minimumBytes: 8 * GIB,
        dirty: false,
      },
    });
    expect(partitions[1]?.hibernated).toBeUndefined();
    expect(partitions[1]?.resize?.hibernated).toBeUndefined();
    expect(partitions[1]?.resize?.bitlocker).toBeUndefined();
    expect(calls).toHaveLength(1);

    const unavailable = await probeLinuxPartitionFilesystems({
      inventory: parse(serialized),
      serialized,
      runner: {
        async run() {
          return { exitCode: 127, stdout: "", stderr: "not found" };
        },
      },
    });
    expect(unavailable[1]).toMatchObject({
      filesystem: "ntfs",
      filesystemHealth: "unknown",
    });
    expect(unavailable[1]?.hibernated).toBeUndefined();
    expect(unavailable[1]?.resize).toBeUndefined();

    calls.length = 0;
    const mountedSerialized = serializedInventory(
      {},
      { fstype: "ntfs", mountpoints: ["/mnt/windows"] },
    );
    const mounted = await probeLinuxPartitionFilesystems({
      inventory: parse(mountedSerialized),
      serialized: mountedSerialized,
      runner,
    });
    expect(mounted[1]?.filesystemHealth).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("classifies an opaque BitLocker volume as Windows without inventing NTFS state", () => {
    const inventory = parse(serializedInventory({}, { fstype: "bitlocker" }));
    expect(inventory.partitions[1]).toMatchObject({
      filesystem: "unknown",
      osFamily: "windows",
      encryption: "bitlocker",
    });
    expect(inventory.partitions[1]?.hibernated).toBeUndefined();
  });

  it("derives bounded ext4 resize evidence from read-only native probes", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const runner: LinuxInventoryCommandRunner = {
      async run(command, args): Promise<LinuxInventoryCommandResult> {
        calls.push([command, args]);
        if (command.endsWith("dumpe2fs")) {
          return {
            exitCode: 0,
            stdout:
              "Filesystem state:         clean\nBlock size:               4096\n",
            stderr: "",
          };
        }
        if (command.endsWith("e2fsck")) {
          return { exitCode: 0, stdout: "clean\n", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: "Estimated minimum size of the filesystem: 1048576\n",
          stderr: "",
        };
      },
    };

    await expect(
      probeLinuxExt4Filesystem({
        runner,
        devicePath: "/dev/vda2",
        partitionSizeBytes: 8 * GIB,
      }),
    ).resolves.toEqual({
      filesystemHealth: "healthy",
      minimumBytes: 4 * GIB,
    });
    expect(calls).toEqual([
      ["/usr/sbin/dumpe2fs", ["-h", "/dev/vda2"]],
      ["/usr/sbin/e2fsck", ["-f", "-n", "/dev/vda2"]],
      ["/usr/sbin/resize2fs", ["-P", "/dev/vda2"]],
    ]);
  });

  it("fails ext4 resize evidence closed for dirty, unhealthy, or malformed probes", async () => {
    const probe = async (options: {
      state?: string;
      checkExit?: number;
      minimum?: string;
      blockSize?: number;
    }) =>
      probeLinuxExt4Filesystem({
        devicePath: "/dev/vda2",
        partitionSizeBytes: 8 * GIB,
        runner: {
          async run(command) {
            if (command.endsWith("dumpe2fs")) {
              return {
                exitCode: 0,
                stdout: `Filesystem state: ${options.state ?? "clean"}\nBlock size: ${options.blockSize ?? 4096}\n`,
                stderr: "",
              };
            }
            if (command.endsWith("e2fsck")) {
              return {
                exitCode: options.checkExit ?? 0,
                stdout: "",
                stderr: "",
              };
            }
            return {
              exitCode: 0,
              stdout: `Estimated minimum size of the filesystem: ${options.minimum ?? "1048576"}\n`,
              stderr: "",
            };
          },
        },
      });

    await expect(probe({ state: "not clean with errors" })).resolves.toEqual({
      filesystemHealth: "dirty",
    });
    await expect(probe({ checkExit: 4 })).resolves.toEqual({
      filesystemHealth: "unhealthy",
    });
    await expect(probe({ minimum: "999999999999999999999" })).resolves.toEqual({
      filesystemHealth: "healthy",
    });
    await expect(probe({ blockSize: 1024 })).resolves.toEqual({
      filesystemHealth: "healthy",
    });
    await expect(
      probeLinuxExt4Filesystem({
        runner: {
          async run() {
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
        devicePath: "/dev/../etc/passwd",
        partitionSizeBytes: 8 * GIB,
      }),
    ).rejects.toThrow(/device path/);
  });

  it("resolves root block sources and complete inverse ancestry", () => {
    expect(
      parseLinuxRootBlockSource(
        JSON.stringify({
          filesystems: [{ source: "/dev/mapper/cryptroot[/@]", target: "/" }],
        }),
      ),
    ).toBe("/dev/mapper/cryptroot");
    expect(
      parseLinuxRootBlockSource(
        JSON.stringify({
          filesystems: [{ source: "overlay", target: "/" }],
        }),
      ),
    ).toBeUndefined();
    expect(
      parseLinuxBootAncestorPaths(
        JSON.stringify({
          blockdevices: [
            { path: "/dev/mapper/cryptroot", type: "crypt" },
            { path: "/dev/md0", type: "raid1" },
            { path: "/dev/nvme1n1p2", type: "part" },
            { path: "/dev/nvme1n1", type: "disk" },
            { path: "/dev/nvme0n1p2", type: "part" },
            { path: "/dev/nvme0n1", type: "disk" },
          ],
        }),
        "/dev/mapper/cryptroot",
      ),
    ).toEqual([
      "/dev/mapper/cryptroot",
      "/dev/md0",
      "/dev/nvme0n1",
      "/dev/nvme0n1p2",
      "/dev/nvme1n1",
      "/dev/nvme1n1p2",
    ]);
    expect(() =>
      parseLinuxBootAncestorPaths(
        JSON.stringify({ blockdevices: [] }),
        "/dev/mapper/cryptroot",
      ),
    ).toThrow(/incomplete/);
    expect(() =>
      parseLinuxBootAncestorPaths(
        JSON.stringify({
          blockdevices: [{ path: "/dev/../etc/passwd", type: "disk" }],
        }),
        "/dev/mapper/cryptroot",
      ),
    ).toThrow(/invalid/);
    expect(() =>
      parseLinuxBootAncestorPaths(
        JSON.stringify({
          blockdevices: [{ path: "/dev/mapper/cryptroot", type: "crypt" }],
        }),
        "/dev/mapper/cryptroot",
      ),
    ).toThrow(/incomplete/);
  });

  it("rejects sgdisk reports that recover corruption despite exit zero", () => {
    expect(
      isSgdiskRedundancyVerified({
        exitCode: 0,
        stdout:
          "No problems found. 67517 free sectors available in 2 segments.\n",
        stderr: "",
      }),
    ).toBe(true);
    expect(
      isSgdiskRedundancyVerified({
        exitCode: 0,
        stdout: [
          "Caution: invalid backup GPT header, but valid main header; regenerating backup header from main header.",
          "Warning! One or more CRCs don't match. You should repair the disk!",
          "Main header: OK",
          "Backup header: ERROR",
          "No problems found. 67517 free sectors available in 2 segments.",
        ].join("\n"),
        stderr: "",
      }),
    ).toBe(false);
    expect(
      isSgdiskRedundancyVerified({
        exitCode: 0,
        stdout:
          "Problem: main and backup partition tables do not match.\nNo problems found.\n",
        stderr: "",
      }),
    ).toBe(false);
    expect(
      isSgdiskRedundancyVerified({
        exitCode: 0,
        stdout: "No problems found. 1 free sector available.\n",
        stderr: "Warning: mismatched main and backup data.\n",
      }),
    ).toBe(false);
    expect(
      isSgdiskRedundancyVerified({
        exitCode: 2,
        stdout: "No problems found. 1 free sector available.\n",
        stderr: "",
      }),
    ).toBe(false);
  });

  it("binds whole-disk hardware identity, GPT IDs, boundaries, and free extents", () => {
    const inventory = parse();

    expect(inventory.hardwareIdentity).toEqual({
      serial: "QEMU-DISK-0001",
      wwn: "0x5000c50012345678",
      firmwarePath: "/devices/pci0000:00/0000:00:04.0/virtio2/block/vda",
      gptDiskGuid: "b5afe67e-7ed7-4f10-99bd-efb8173c53ce",
    });
    expect(inventory.logicalSectorBytes).toBe(512);
    expect(inventory.gptRedundancyVerified).toBe(true);
    expect(inventory.bootAncestryResolved).toBe(true);
    expect(inventory.partitions).toHaveLength(2);
    expect(inventory.partitions[0]).toMatchObject({
      id: "b27e2419-9e58-416e-a921-d8d51a443692",
      startBytes: MIB,
      endBytes: 513 * MIB,
      mounted: false,
      role: "esp",
      filesystem: "fat32",
    });
    expect(inventory.partitions[1]).toMatchObject({
      mounted: false,
      role: "data",
      filesystem: "ext4",
      encryption: "none",
    });
    expect(inventory.freeExtents).toEqual([
      {
        id: `free-${40 * GIB + 513 * MIB}-${128 * GIB - MIB}`,
        startBytes: 40 * GIB + 513 * MIB,
        endBytes: 128 * GIB - MIB,
      },
    ]);
    expect(inventory.currentBootSource).toBe(false);
    expect(inventory.protectedReason).toBeUndefined();
  });

  it("marks root-backed, read-only, removable, and unverified disks as protected", () => {
    const rootBacked = parse(serializedInventory({}, { mountpoints: ["/"] }));
    expect(rootBacked.currentBootSource).toBe(true);
    expect(rootBacked.partitions[1]?.mounted).toBe(true);
    expect(rootBacked.protectedReason).toMatch(/mounted partition/);
    expect(parse(serializedInventory({ ro: true })).protectedReason).toMatch(
      /read-only/,
    );
    expect(parse(serializedInventory({ rm: true })).protectedReason).toMatch(
      /removable/,
    );
    expect(parse(serializedInventory(), false).protectedReason).toMatch(
      /verification failed/,
    );
    expect(parse(serializedInventory(), true, false).protectedReason).toMatch(
      /GPT main\/backup/,
    );
    expect(
      parse(serializedInventory(), true, true, [], false).protectedReason,
    ).toMatch(/boot-device ancestry/);
    expect(
      parse(serializedInventory(), true, true, ["/dev/vda"], true)
        .currentBootSource,
    ).toBe(true);
    const directRoot = parse(
      serializedInventory({}, { mountpoints: ["/"] }),
      true,
      true,
      [],
      false,
    );
    expect(directRoot.bootAncestryResolved).toBe(true);
    expect(directRoot.currentBootSource).toBe(true);
  });

  it("propagates a stacked descendant mount to its containing partition", () => {
    const document = JSON.parse(serializedInventory()) as {
      blockdevices: Array<Record<string, unknown>>;
    };
    document.blockdevices.push({
      path: "/dev/mapper/vg-data",
      kname: "/dev/dm-0",
      pkname: "/dev/vda2",
      type: "lvm",
      mountpoints: ["/srv/data"],
    });

    const inventory = parse(JSON.stringify(document));
    expect(inventory.partitions[1]?.mounted).toBe(true);
    expect(inventory.currentBootSource).toBe(false);
    expect(inventory.protectedReason).toMatch(/stacked descendant/);
  });

  it("does not require partition-table verification for an empty disk", () => {
    const empty = JSON.parse(
      serializedInventory({ pttype: null, ptuuid: null }),
    ) as { blockdevices: Array<Record<string, unknown>> };
    empty.blockdevices.splice(1);
    expect(parse(JSON.stringify(empty), false).protectedReason).toBeUndefined();
  });

  it("protects unknown partition tables and firmware modes", () => {
    expect(
      parse(serializedInventory({ pttype: "mystery", ptuuid: null }))
        .protectedReason,
    ).toMatch(/unknown/);
    expect(
      parseLinuxLsblkInventory({
        stableId: "virtio-QEMU-DISK-0001",
        stablePath: "/dev/disk/by-id/virtio-QEMU-DISK-0001",
        devicePath: "/dev/vda",
        firmwarePath: "/devices/pci0000:00/0000:00:04.0/virtio2/block/vda",
        firmware: "unknown",
        serialized: serializedInventory(),
        partitionTableVerified: true,
        gptRedundancyVerified: true,
        bootAncestorPaths: [],
        bootAncestryResolved: true,
      }).protectedReason,
    ).toMatch(/Firmware/);
  });

  it("keeps LUKS and unknown filesystems out of automatic shrink claims", () => {
    const encrypted = parse(serializedInventory({}, { fstype: "crypto_LUKS" }))
      .partitions[1];
    expect(encrypted).toMatchObject({
      filesystem: "unknown",
      role: "unknown",
      encryption: "luks",
    });
    expect(encrypted?.resize).toBeUndefined();
    const bitlocker = parse(serializedInventory({}, { fstype: "BitLocker" }))
      .partitions[1];
    expect(bitlocker).toMatchObject({
      filesystem: "unknown",
      encryption: "bitlocker",
    });
    const unknown = parse(serializedInventory({}, { fstype: null }))
      .partitions[1];
    expect(unknown?.encryption).toBe("unknown");
  });

  it.each([
    ["missing serial", { serial: null }, {}],
    ["invalid GPT GUID", { ptuuid: "not-a-guid" }, {}],
    ["fractional sector size", { "log-sec": 512.5 }, {}],
    ["missing PARTUUID", {}, { partuuid: null }],
    ["invalid GPT PARTUUID", {}, { partuuid: "12345678-01" }],
    ["fractional partition start", {}, { start: 1.5 }],
  ])("rejects %s", (_name, diskOverrides, partitionOverrides) => {
    expect(() =>
      parse(serializedInventory(diskOverrides, partitionOverrides)),
    ).toThrow();
  });

  it("rejects ambiguous multi-disk output", () => {
    const parsed = JSON.parse(serializedInventory()) as {
      blockdevices: Array<Record<string, unknown>>;
    };
    parsed.blockdevices.push({ ...parsed.blockdevices[0], path: "/dev/vdb" });
    expect(() => parse(JSON.stringify(parsed))).toThrow(
      /exactly one whole disk/,
    );
  });

  it("rejects canonical device-path changes and foreign partitions", () => {
    expect(() => parse(serializedInventory({ path: "/dev/vdb" }))).toThrow(
      /path changed/,
    );
    expect(() =>
      parse(serializedInventory({}, { pkname: "/dev/vdb" })),
    ).toThrow(/another disk/);
  });
});

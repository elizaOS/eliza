import { execFile } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { InstallInventoryProvider } from "./executor";
import {
  createDiskInventoryFingerprint,
  validateDiskInventory,
} from "./planner";
import type { DiskInventory, Filesystem, PartitionInventory } from "./types";

const execFileAsync = promisify(execFile);
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,254}$/;
const MIB = 1024 ** 2;
const ESP_GUID = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b";
const GPT_GUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MBR_PARTUUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{2}$/;
const LSBLK = "/usr/bin/lsblk";
const FINDMNT = "/usr/bin/findmnt";
const UDEVADM = "/usr/bin/udevadm";
const SFDISK = "/usr/sbin/sfdisk";
const SGDISK = "/usr/sbin/sgdisk";
const DUMPE2FS = "/usr/sbin/dumpe2fs";
const E2FSCK = "/usr/sbin/e2fsck";
const RESIZE2FS = "/usr/sbin/resize2fs";
const BTRFS = "/usr/bin/btrfs";
const NTFSRESIZE = "/usr/sbin/ntfsresize";

interface LsblkDevice {
  path?: unknown;
  kname?: unknown;
  pkname?: unknown;
  type?: unknown;
  size?: unknown;
  "log-sec"?: unknown;
  pttype?: unknown;
  ptuuid?: unknown;
  fstype?: unknown;
  mountpoints?: unknown;
  parttype?: unknown;
  partuuid?: unknown;
  partlabel?: unknown;
  start?: unknown;
  serial?: unknown;
  wwn?: unknown;
  ro?: unknown;
  rm?: unknown;
  children?: unknown;
}

interface LsblkDocument {
  blockdevices?: unknown;
}

interface FindmntDocument {
  filesystems?: unknown;
}

export interface LinuxInventoryCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LinuxInventoryCommandRunner {
  run(
    command: string,
    args: readonly string[],
  ): Promise<LinuxInventoryCommandResult>;
}

export interface LinuxExt4ProbeEvidence {
  filesystemHealth: NonNullable<PartitionInventory["filesystemHealth"]>;
  minimumBytes?: number;
}

export interface LinuxBtrfsProbeEvidence {
  filesystemHealth: NonNullable<PartitionInventory["filesystemHealth"]>;
}

const BTRFS_CLEAN_PATTERN = /\bno error found\b/i;
const BTRFS_FAILURE_PATTERN =
  /\b(?:warning|corrupt(?:ed|ion)?|damaged|invalid|unrecoverable|failed|failure|errors?)\b/i;

/**
 * Classify an unmounted btrfs filesystem with the native read-only checker.
 * btrfs minimum-device-size needs a mounted path, so this probe intentionally
 * does not manufacture automatic-shrink evidence from an unsafe mount.
 */
export async function probeLinuxBtrfsFilesystem(options: {
  runner: LinuxInventoryCommandRunner;
  devicePath: string;
}): Promise<LinuxBtrfsProbeEvidence> {
  if (!isSafeDevicePath(options.devicePath)) {
    throw new Error("Linux btrfs probe device path is invalid.");
  }
  const check = await options.runner.run(BTRFS, [
    "check",
    "--readonly",
    options.devicePath,
  ]);
  if (check.exitCode === 127) {
    return { filesystemHealth: "unknown" };
  }
  if (check.exitCode !== 0) {
    return { filesystemHealth: "unhealthy" };
  }
  const report = `${check.stdout}\n${check.stderr}`;
  const withoutCleanMarker = report.replace(BTRFS_CLEAN_PATTERN, "");
  if (BTRFS_FAILURE_PATTERN.test(withoutCleanMarker)) {
    return { filesystemHealth: "unhealthy" };
  }
  return {
    filesystemHealth: BTRFS_CLEAN_PATTERN.test(report) ? "healthy" : "unknown",
  };
}

export interface LinuxNtfsProbeEvidence {
  filesystemHealth: NonNullable<PartitionInventory["filesystemHealth"]>;
  hibernated?: boolean;
  dirty?: boolean;
  minimumBytes?: number;
}

const NTFS_DEVICE_SIZE_PATTERN = /^Current device size:\s*(\d+) bytes\b/m;
const NTFS_MINIMUM_PATTERN = /^You might resize at (\d+) bytes\b/m;
const NTFS_HIBERNATED_PATTERN =
  /\b(?:NTFS partition|Windows|volume)\s+is\s+hibernated\b/i;
const NTFS_DIRTY_PATTERN =
  /\b(?:not cleanly unmounted|journal file is unclean|volume is scheduled for check)\b/i;
const NTFS_FAILURE_PATTERN =
  /\b(?:warning|error|corrupt(?:ed|ion)?|invalid|failed|failure|bad sectors?)\b/i;

/**
 * `ntfsresize --info --no-action` opens the unmounted volume read-only with
 * NTFS_MNT_FORENSIC, checks consistency, and reports a byte-exact minimum.
 * Hibernation and dirty-journal diagnostics remain typed refusal evidence.
 */
export async function probeLinuxNtfsFilesystem(options: {
  runner: LinuxInventoryCommandRunner;
  devicePath: string;
  partitionSizeBytes: number;
}): Promise<LinuxNtfsProbeEvidence> {
  if (!isSafeDevicePath(options.devicePath)) {
    throw new Error("Linux NTFS probe device path is invalid.");
  }
  const result = await options.runner.run(NTFSRESIZE, [
    "--info",
    "--no-action",
    "--no-progress-bar",
    options.devicePath,
  ]);
  const report = `${result.stdout}\n${result.stderr}`;
  if (NTFS_HIBERNATED_PATTERN.test(report)) {
    return { filesystemHealth: "unknown", hibernated: true };
  }
  if (NTFS_DIRTY_PATTERN.test(report)) {
    return { filesystemHealth: "dirty", dirty: true };
  }
  if (result.exitCode === 127) {
    return { filesystemHealth: "unknown" };
  }
  if (result.exitCode !== 0 || NTFS_FAILURE_PATTERN.test(report)) {
    return { filesystemHealth: "unhealthy" };
  }
  const deviceSizeText = NTFS_DEVICE_SIZE_PATTERN.exec(report)?.[1];
  if (
    !deviceSizeText ||
    Number(deviceSizeText) !== options.partitionSizeBytes
  ) {
    return { filesystemHealth: "unhealthy" };
  }
  const minimumText = NTFS_MINIMUM_PATTERN.exec(report)?.[1];
  const minimumBytes = minimumText ? Number(minimumText) : undefined;
  return {
    filesystemHealth: "healthy",
    dirty: false,
    ...(minimumBytes !== undefined &&
    Number.isSafeInteger(minimumBytes) &&
    minimumBytes > 0 &&
    minimumBytes < options.partitionSizeBytes
      ? { minimumBytes }
      : {}),
  };
}

const EXT4_BLOCK_SIZE_PATTERN = /^Block size:\s*(\d+)\s*$/m;
const EXT4_STATE_PATTERN = /^Filesystem state:\s*(.+?)\s*$/m;
const RESIZE2FS_MINIMUM_PATTERN =
  /Estimated minimum size of the filesystem:\s*(\d+)\s*$/m;

/**
 * Run read-only ext4 checks and return resize evidence only when every probe
 * independently reports a clean filesystem and a bounded minimum size.
 */
export async function probeLinuxExt4Filesystem(options: {
  runner: LinuxInventoryCommandRunner;
  devicePath: string;
  partitionSizeBytes: number;
}): Promise<LinuxExt4ProbeEvidence> {
  if (!isSafeDevicePath(options.devicePath)) {
    throw new Error("Linux ext4 probe device path is invalid.");
  }
  const superblock = await options.runner.run(DUMPE2FS, [
    "-h",
    options.devicePath,
  ]);
  if (superblock.exitCode !== 0) {
    return { filesystemHealth: "unknown" };
  }
  const state = EXT4_STATE_PATTERN.exec(superblock.stdout)?.[1]
    ?.trim()
    .toLowerCase();
  if (state !== "clean") {
    return { filesystemHealth: state ? "dirty" : "unknown" };
  }
  const check = await options.runner.run(E2FSCK, [
    "-f",
    "-n",
    options.devicePath,
  ]);
  if (check.exitCode !== 0) {
    return { filesystemHealth: "unhealthy" };
  }
  const minimum = await options.runner.run(RESIZE2FS, [
    "-P",
    options.devicePath,
  ]);
  if (minimum.exitCode !== 0) {
    return { filesystemHealth: "healthy" };
  }
  const blockSizeText = EXT4_BLOCK_SIZE_PATTERN.exec(superblock.stdout)?.[1];
  const minimumBlocksText = RESIZE2FS_MINIMUM_PATTERN.exec(minimum.stdout)?.[1];
  if (!blockSizeText || !minimumBlocksText) {
    return { filesystemHealth: "healthy" };
  }
  const blockSize = Number(blockSizeText);
  const minimumBlocks = Number(minimumBlocksText);
  const minimumBytes = blockSize * minimumBlocks;
  if (
    !Number.isSafeInteger(blockSize) ||
    !Number.isSafeInteger(minimumBlocks) ||
    !Number.isSafeInteger(minimumBytes) ||
    blockSize !== 4096 ||
    minimumBlocks <= 0 ||
    minimumBytes >= options.partitionSizeBytes
  ) {
    return { filesystemHealth: "healthy" };
  }
  return { filesystemHealth: "healthy", minimumBytes };
}

const SGDISK_FAILURE_PATTERN =
  /\b(?:warning|caution|error|corrupt|damaged|invalid|mismatch(?:ed)?|problems?)\b|\b(?:doesn't|does not|don't|do not)\s+match\b/i;

export function isSgdiskRedundancyVerified(
  result: LinuxInventoryCommandResult,
): boolean {
  const report = `${result.stdout}\n${result.stderr}`;
  const cleanReport = report.replace(/\bNo problems found\./g, "");
  return (
    result.exitCode === 0 &&
    /\bNo problems found\./.test(report) &&
    !SGDISK_FAILURE_PATTERN.test(cleanReport)
  );
}

const DEVICE_PATH_PATTERN = /^\/dev\/[A-Za-z0-9._/+:-]+$/;

function isSafeDevicePath(path: string): boolean {
  return (
    DEVICE_PATH_PATTERN.test(path) &&
    !path.includes("//") &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

export function parseLinuxRootBlockSource(
  serialized: string,
): string | undefined {
  let document: FindmntDocument;
  try {
    document = JSON.parse(serialized) as FindmntDocument;
  } catch {
    throw new Error("Linux inventory findmnt output is not valid JSON.");
  }
  if (
    !Array.isArray(document.filesystems) ||
    document.filesystems.length !== 1
  ) {
    throw new Error("Linux inventory must resolve exactly one root mount.");
  }
  const filesystem = document.filesystems[0];
  if (typeof filesystem !== "object" || filesystem === null) {
    throw new Error("Linux inventory root mount is not an object.");
  }
  const entry = filesystem as { source?: unknown; target?: unknown };
  if (entry.target !== "/") {
    throw new Error(
      "Linux inventory root mount target changed during probing.",
    );
  }
  const source = requiredString("root mount source", entry.source);
  const subvolume = source.indexOf("[");
  const devicePath = subvolume === -1 ? source : source.slice(0, subvolume);
  if (
    (subvolume !== -1 && !source.endsWith("]")) ||
    !isSafeDevicePath(devicePath)
  ) {
    return undefined;
  }
  return devicePath;
}

export function parseLinuxBootAncestorPaths(
  serialized: string,
  rootSource: string,
): string[] {
  let document: LsblkDocument;
  try {
    document = JSON.parse(serialized) as LsblkDocument;
  } catch {
    throw new Error("Linux inventory boot ancestry output is not valid JSON.");
  }
  const devices = flattenDevices(document.blockdevices);
  const paths = new Set(
    devices.map((device) => requiredString("boot ancestor path", device.path)),
  );
  if (
    paths.size === 0 ||
    !devices.some((device) => device.type === "disk") ||
    !isSafeDevicePath(rootSource) ||
    [...paths].some((path) => !isSafeDevicePath(path))
  ) {
    throw new Error("Linux inventory boot ancestry is incomplete or invalid.");
  }
  return [...paths].sort();
}

class ExecFileCommandRunner implements LinuxInventoryCommandRunner {
  async run(
    command: string,
    args: readonly string[],
  ): Promise<LinuxInventoryCommandResult> {
    try {
      const result = await execFileAsync(command, [...args], {
        encoding: "utf8",
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        },
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      return {
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? failed.message,
        exitCode: typeof failed.code === "number" ? failed.code : 127,
      };
    }
  }
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Linux inventory ${name} is missing.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Linux inventory ${name} is not a non-negative safe integer.`,
    );
  }
  return value;
}

function booleanColumn(name: string, value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(
    `Linux inventory ${name} must be an explicit boolean column.`,
  );
}

function flattenDevices(devices: unknown): LsblkDevice[] {
  if (!Array.isArray(devices)) {
    throw new Error("Linux inventory lsblk document has no device array.");
  }
  const flattened: LsblkDevice[] = [];
  for (const value of devices) {
    if (typeof value !== "object" || value === null) {
      throw new Error("Linux inventory lsblk device is not an object.");
    }
    const device = value as LsblkDevice;
    flattened.push(device);
    if (device.children !== undefined) {
      flattened.push(...flattenDevices(device.children));
    }
  }
  return flattened;
}

function filesystem(value: unknown): Filesystem {
  switch (optionalString(value)?.toLowerCase()) {
    case "vfat":
    case "fat":
    case "fat32":
      return "fat32";
    case "ntfs":
      return "ntfs";
    case "apfs":
      return "apfs";
    case "ext4":
      return "ext4";
    case "btrfs":
      return "btrfs";
    case "xfs":
      return "xfs";
    case "swap":
      return "swap";
    default:
      return "unknown";
  }
}

function mounts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Linux inventory mountpoints must be an array.");
  }
  return value.filter((item): item is string => typeof item === "string");
}

function partitionRole(device: LsblkDevice): PartitionInventory["role"] {
  if (optionalString(device.parttype)?.toLowerCase() === ESP_GUID) return "esp";
  if (optionalString(device.partlabel)?.toLowerCase().includes("recovery")) {
    return "recovery";
  }
  return filesystem(device.fstype) === "unknown" ? "unknown" : "data";
}

function partition(
  device: LsblkDevice,
  sectorBytes: number,
  partitionTable: DiskInventory["partitionTable"],
  mounted: boolean,
): PartitionInventory {
  const id = requiredString(
    "partition PARTUUID",
    device.partuuid,
  ).toLowerCase();
  if (
    (partitionTable === "gpt" && !GPT_GUID_PATTERN.test(id)) ||
    (partitionTable === "mbr" && !MBR_PARTUUID_PATTERN.test(id)) ||
    partitionTable === "none"
  ) {
    throw new Error(
      `Linux inventory partition ${id} is inconsistent with the partition table.`,
    );
  }
  const startSectors = safeInteger(`partition ${id} START`, device.start);
  const sizeBytes = safeInteger(`partition ${id} SIZE`, device.size);
  const startBytes = startSectors * sectorBytes;
  const endBytes = startBytes + sizeBytes;
  if (!Number.isSafeInteger(startBytes) || !Number.isSafeInteger(endBytes)) {
    throw new Error(
      `Linux inventory partition ${id} exceeds safe integer bounds.`,
    );
  }
  const detectedFilesystem = filesystem(device.fstype);
  const detectedType = optionalString(device.fstype)?.toLowerCase();
  return {
    id,
    startBytes,
    endBytes,
    mounted,
    role: partitionRole(device),
    filesystem: detectedFilesystem,
    ...(detectedFilesystem === "ntfs" || detectedType === "bitlocker"
      ? { osFamily: "windows" as const }
      : {}),
    encryption:
      detectedType === "crypto_luks"
        ? "luks"
        : detectedType === "bitlocker"
          ? "bitlocker"
          : detectedFilesystem === "unknown" ||
              detectedFilesystem === "apfs" ||
              detectedFilesystem === "ntfs"
            ? "unknown"
            : "none",
  };
}

function mountedDeviceNames(devices: LsblkDevice[]): Set<string> {
  const result = new Set<string>();
  for (const device of devices) {
    if (mounts(device.mountpoints).length > 0) {
      result.add(requiredString("mounted device kernel name", device.kname));
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const device of devices) {
      const kernelName = requiredString("device kernel name", device.kname);
      const parentName = optionalString(device.pkname);
      if (
        result.has(kernelName) &&
        parentName !== undefined &&
        !result.has(parentName)
      ) {
        result.add(parentName);
        changed = true;
      }
    }
  }
  return result;
}

function partitionDevicePaths(serialized: string): Map<string, string> {
  let document: LsblkDocument;
  try {
    document = JSON.parse(serialized) as LsblkDocument;
  } catch {
    throw new Error("Linux inventory lsblk output is not valid JSON.");
  }
  const result = new Map<string, string>();
  for (const device of flattenDevices(document.blockdevices)) {
    if (device.type !== "part") continue;
    const id = requiredString(
      "partition PARTUUID",
      device.partuuid,
    ).toLowerCase();
    const path = requiredString(`partition ${id} path`, device.path);
    if (!isSafeDevicePath(path) || result.has(id)) {
      throw new Error(
        `Linux inventory partition ${id} has an invalid or duplicate device path.`,
      );
    }
    result.set(id, path);
  }
  return result;
}

export async function probeLinuxPartitionFilesystems(options: {
  inventory: DiskInventory;
  serialized: string;
  runner: LinuxInventoryCommandRunner;
}): Promise<PartitionInventory[]> {
  const devicePaths = partitionDevicePaths(options.serialized);
  return Promise.all(
    options.inventory.partitions.map(async (partition) => {
      if (
        partition.filesystem !== "ext4" &&
        partition.filesystem !== "btrfs" &&
        partition.filesystem !== "ntfs"
      ) {
        return partition;
      }
      const partitionPath = devicePaths.get(partition.id);
      if (!partitionPath) {
        throw new Error(
          `Linux inventory partition ${partition.id} lost its device path.`,
        );
      }
      if (partition.mounted) {
        return { ...partition, filesystemHealth: "unknown" as const };
      }
      if (partition.filesystem === "btrfs") {
        const evidence = await probeLinuxBtrfsFilesystem({
          runner: options.runner,
          devicePath: partitionPath,
        });
        return {
          ...partition,
          filesystemHealth: evidence.filesystemHealth,
        };
      }
      if (partition.filesystem === "ntfs") {
        const evidence = await probeLinuxNtfsFilesystem({
          runner: options.runner,
          devicePath: partitionPath,
          partitionSizeBytes: partition.endBytes - partition.startBytes,
        });
        return {
          ...partition,
          filesystemHealth: evidence.filesystemHealth,
          ...(evidence.hibernated !== undefined
            ? { hibernated: evidence.hibernated }
            : {}),
          ...(evidence.dirty !== undefined ? { dirty: evidence.dirty } : {}),
          ...(evidence.minimumBytes !== undefined
            ? {
                resize: {
                  filesystemHealthy: true,
                  mounted: false,
                  minimumBytes: evidence.minimumBytes,
                  dirty: false,
                },
              }
            : {}),
        };
      }
      const evidence = await probeLinuxExt4Filesystem({
        runner: options.runner,
        devicePath: partitionPath,
        partitionSizeBytes: partition.endBytes - partition.startBytes,
      });
      return {
        ...partition,
        filesystemHealth: evidence.filesystemHealth,
        ...(evidence.minimumBytes !== undefined
          ? {
              resize: {
                filesystemHealthy: true,
                mounted: false,
                minimumBytes: evidence.minimumBytes,
                dirty: false,
              },
            }
          : {}),
      };
    }),
  );
}

function freeExtents(
  sizeBytes: number,
  partitions: PartitionInventory[],
): DiskInventory["freeExtents"] {
  const result: DiskInventory["freeExtents"] = [];
  let cursor = MIB;
  for (const item of [...partitions].sort(
    (left, right) => left.startBytes - right.startBytes,
  )) {
    if (item.startBytes > cursor) {
      result.push({
        id: `free-${cursor}-${item.startBytes}`,
        startBytes: cursor,
        endBytes: item.startBytes,
      });
    }
    cursor = Math.max(cursor, item.endBytes);
  }
  const safeEnd = Math.floor((sizeBytes - MIB) / MIB) * MIB;
  if (safeEnd > cursor) {
    result.push({
      id: `free-${cursor}-${safeEnd}`,
      startBytes: cursor,
      endBytes: safeEnd,
    });
  }
  return result;
}

export function parseLinuxLsblkInventory(options: {
  stableId: string;
  stablePath: string;
  devicePath: string;
  kernelDeviceIdentity?: string;
  firmwarePath: string;
  firmware: DiskInventory["firmware"];
  serialized: string;
  partitionTableVerified: boolean;
  gptRedundancyVerified: boolean;
  bootAncestorPaths: readonly string[];
  bootAncestryResolved: boolean;
}): DiskInventory {
  let document: LsblkDocument;
  try {
    document = JSON.parse(options.serialized) as LsblkDocument;
  } catch {
    throw new Error("Linux inventory lsblk output is not valid JSON.");
  }
  const devices = flattenDevices(document.blockdevices);
  const disks = devices.filter((device) => device.type === "disk");
  if (disks.length !== 1) {
    throw new Error("Linux inventory must resolve exactly one whole disk.");
  }
  const disk = disks[0] as LsblkDevice;
  const diskPath = requiredString("whole-disk path", disk.path);
  if (diskPath !== options.devicePath) {
    throw new Error("Linux inventory whole-disk path changed during probing.");
  }
  const diskKernelName = requiredString("whole-disk kernel name", disk.kname);
  const sectorBytes = safeInteger("logical sector size", disk["log-sec"]);
  const sizeBytes = safeInteger("disk size", disk.size);
  const table = optionalString(disk.pttype)?.toLowerCase();
  const partitionTable: DiskInventory["partitionTable"] =
    table === "gpt" || table === "dos"
      ? table === "dos"
        ? "mbr"
        : "gpt"
      : table === undefined
        ? "none"
        : "unknown";
  const partitionDevices = devices.filter((device) => device.type === "part");
  const mountedNames = mountedDeviceNames(devices);
  for (const device of partitionDevices) {
    if (requiredString("partition parent", device.pkname) !== diskKernelName) {
      throw new Error(
        "Linux inventory contains a partition from another disk.",
      );
    }
  }
  const partitions = partitionDevices.map((device) =>
    partition(
      device,
      sectorBytes,
      partitionTable,
      mountedNames.has(requiredString("partition kernel name", device.kname)),
    ),
  );
  const serial = requiredString("disk serial", disk.serial);
  const wwn = optionalString(disk.wwn);
  const readOnly = booleanColumn("read-only", disk.ro);
  const removable = booleanColumn("removable", disk.rm);
  const directlyMountedRoot = devices.some((device) =>
    mounts(device.mountpoints).includes("/"),
  );
  const currentBootSource =
    directlyMountedRoot ||
    options.bootAncestorPaths.includes(options.devicePath);
  const bootAncestryResolved =
    directlyMountedRoot || options.bootAncestryResolved;
  const protectedReason =
    partitionTable === "unknown"
      ? "Partition-table type is unknown."
      : partitionTable !== "none" && !options.partitionTableVerified
        ? "Partition-table verification failed."
        : partitionTable === "gpt" && !options.gptRedundancyVerified
          ? "GPT main/backup redundancy verification failed."
          : !bootAncestryResolved
            ? "Current boot-device ancestry is unresolved."
            : partitions.some((partition) => partition.mounted)
              ? "Target disk has a mounted partition or stacked descendant."
              : options.firmware === "unknown"
                ? "Firmware mode is unknown."
                : readOnly
                  ? "Target disk is read-only."
                  : removable
                    ? "Target disk is removable media."
                    : undefined;
  const inventory: DiskInventory = {
    stableId: options.stableId,
    path: options.stablePath,
    ...(options.kernelDeviceIdentity
      ? { kernelDeviceIdentity: options.kernelDeviceIdentity }
      : {}),
    hardwareIdentity: {
      serial,
      ...(wwn ? { wwn } : {}),
      firmwarePath: options.firmwarePath,
      ...(partitionTable === "gpt"
        ? {
            gptDiskGuid: requiredString(
              "GPT disk GUID",
              disk.ptuuid,
            ).toLowerCase(),
          }
        : {}),
    },
    sizeBytes,
    logicalSectorBytes: sectorBytes,
    partitionTable,
    ...(partitionTable === "gpt"
      ? { gptRedundancyVerified: options.gptRedundancyVerified }
      : {}),
    bootAncestryResolved,
    currentBootSource,
    firmware: options.firmware,
    ...(protectedReason ? { protectedReason } : {}),
    partitions,
    freeExtents: freeExtents(sizeBytes, partitions),
  };
  validateDiskInventory(inventory);
  return inventory;
}

export interface LinuxInstallInventoryProviderOptions {
  runner?: LinuxInventoryCommandRunner;
  byIdDirectory?: string;
  firmware?: DiskInventory["firmware"];
  resolveDeviceIdentity?: (devicePath: string) => Promise<string>;
}

interface LinuxDiskSnapshot {
  inventory: DiskInventory;
  serialized: string;
}

async function resolveLinuxDeviceIdentity(devicePath: string): Promise<string> {
  const status = await stat(devicePath, { bigint: true });
  if (!status.isBlockDevice()) {
    throw new Error(
      "Linux inventory stable ID does not resolve to a block device.",
    );
  }
  const diskSequence = (
    await readFile(
      join("/sys/class/block", basename(devicePath), "diskseq"),
      "utf8",
    )
  ).trim();
  if (!/^\d+$/.test(diskSequence)) {
    throw new Error("Linux inventory block-device sequence is invalid.");
  }
  return `${status.rdev.toString()}:${diskSequence}`;
}

export function assertLinuxInventorySnapshotUnchanged(
  before: DiskInventory,
  after: DiskInventory,
): void {
  if (
    createDiskInventoryFingerprint(before) !==
    createDiskInventoryFingerprint(after)
  ) {
    throw new Error(
      "Linux inventory disk identity, geometry, or safety state changed during filesystem probing.",
    );
  }
}

export class LinuxInstallInventoryProvider implements InstallInventoryProvider {
  private readonly runner: LinuxInventoryCommandRunner;
  private readonly byIdDirectory: string;
  private readonly firmware: DiskInventory["firmware"];
  private readonly resolveDeviceIdentity: (
    devicePath: string,
  ) => Promise<string>;

  constructor(options: LinuxInstallInventoryProviderOptions = {}) {
    this.runner = options.runner ?? new ExecFileCommandRunner();
    this.byIdDirectory = options.byIdDirectory ?? "/dev/disk/by-id";
    this.firmware = options.firmware ?? "unknown";
    this.resolveDeviceIdentity =
      options.resolveDeviceIdentity ?? resolveLinuxDeviceIdentity;
  }

  private async inspectDiskSnapshot(options: {
    stableId: string;
    stablePath: string;
    devicePath: string;
    deviceIdentity: string;
  }): Promise<LinuxDiskSnapshot> {
    if (
      (await realpath(options.stablePath)) !== options.devicePath ||
      (await this.resolveDeviceIdentity(options.devicePath)) !==
        options.deviceIdentity
    ) {
      throw new Error("Linux inventory stable ID changed during probing.");
    }
    const rootMount = await this.runner.run(FINDMNT, [
      "--json",
      "--output",
      "SOURCE,TARGET",
      "--target",
      "/",
    ]);
    if (rootMount.exitCode !== 0) {
      throw new Error("Linux inventory root-mount probe failed.");
    }
    const rootSource = parseLinuxRootBlockSource(rootMount.stdout);
    let bootAncestorPaths: string[] = [];
    let bootAncestryResolved = false;
    if (rootSource) {
      const bootAncestry = await this.runner.run(LSBLK, [
        "--json",
        "--paths",
        "--inverse",
        "--list",
        "--output",
        "PATH,TYPE",
        rootSource,
      ]);
      if (bootAncestry.exitCode === 0) {
        const reportedPaths = parseLinuxBootAncestorPaths(
          bootAncestry.stdout,
          rootSource,
        );
        try {
          const [canonicalRootSource, ...canonicalPaths] = await Promise.all(
            [rootSource, ...reportedPaths].map((path) => realpath(path)),
          );
          const statuses = await Promise.all(
            [canonicalRootSource, ...canonicalPaths].map((path) => stat(path)),
          );
          if (
            statuses.every((status) => status.isBlockDevice()) &&
            canonicalPaths.includes(canonicalRootSource)
          ) {
            bootAncestorPaths = [...new Set(canonicalPaths)].sort();
            bootAncestryResolved = true;
          }
        } catch {
          bootAncestorPaths = [];
          bootAncestryResolved = false;
        }
      }
    }
    const [lsblk, firmwarePath, verification, gptVerification] =
      await Promise.all([
        this.runner.run(LSBLK, [
          "--json",
          "--bytes",
          "--paths",
          "--output",
          "PATH,KNAME,PKNAME,TYPE,SIZE,LOG-SEC,PTTYPE,PTUUID,FSTYPE,MOUNTPOINTS,PARTTYPE,PARTUUID,PARTLABEL,START,SERIAL,WWN,RO,RM",
          options.devicePath,
        ]),
        this.runner.run(UDEVADM, [
          "info",
          "--query=path",
          `--name=${options.devicePath}`,
        ]),
        this.runner.run(SFDISK, ["--verify", options.devicePath]),
        this.runner.run(SGDISK, ["--verify", options.devicePath]),
      ]);
    if (lsblk.exitCode !== 0 || firmwarePath.exitCode !== 0) {
      throw new Error("Linux inventory read-only probes failed.");
    }
    if (
      (await realpath(options.stablePath)) !== options.devicePath ||
      (await this.resolveDeviceIdentity(options.devicePath)) !==
        options.deviceIdentity
    ) {
      throw new Error("Linux inventory stable ID changed during probing.");
    }
    const inventory = parseLinuxLsblkInventory({
      stableId: options.stableId,
      stablePath: options.stablePath,
      devicePath: options.devicePath,
      kernelDeviceIdentity: options.deviceIdentity,
      firmwarePath: requiredString("firmware path", firmwarePath.stdout),
      firmware: this.firmware,
      serialized: lsblk.stdout,
      partitionTableVerified: verification.exitCode === 0,
      gptRedundancyVerified: isSgdiskRedundancyVerified(gptVerification),
      bootAncestorPaths,
      bootAncestryResolved,
    });
    return { inventory, serialized: lsblk.stdout };
  }

  async inspect(stableId: string): Promise<DiskInventory> {
    if (!STABLE_ID_PATTERN.test(stableId) || /-part\d+$/i.test(stableId)) {
      throw new Error(
        "Linux inventory stable ID is not a whole-disk identifier.",
      );
    }
    const stablePath = join(this.byIdDirectory, stableId);
    const link = await lstat(stablePath);
    if (!link.isSymbolicLink()) {
      throw new Error("Linux inventory stable ID is not a device symlink.");
    }
    const devicePath = await realpath(stablePath);
    if (!devicePath.startsWith("/dev/")) {
      throw new Error(
        "Linux inventory stable ID does not resolve to a block device.",
      );
    }
    const deviceIdentity = await this.resolveDeviceIdentity(devicePath);
    const before = await this.inspectDiskSnapshot({
      stableId,
      stablePath,
      devicePath,
      deviceIdentity,
    });
    const inventory: DiskInventory = {
      ...before.inventory,
      partitions: await probeLinuxPartitionFilesystems({
        inventory: before.inventory,
        serialized: before.serialized,
        runner: this.runner,
      }),
    };
    const after = await this.inspectDiskSnapshot({
      stableId,
      stablePath,
      devicePath,
      deviceIdentity,
    });
    assertLinuxInventorySnapshotUnchanged(before.inventory, after.inventory);
    const unsafeFilesystem = inventory.partitions.find(
      (partition) =>
        partition.filesystemHealth === "dirty" ||
        partition.filesystemHealth === "unhealthy",
    );
    if (!inventory.protectedReason && unsafeFilesystem) {
      inventory.protectedReason = `Partition ${unsafeFilesystem.id} has a ${unsafeFilesystem.filesystemHealth} filesystem.`;
    }
    validateDiskInventory(inventory);
    return inventory;
  }
}

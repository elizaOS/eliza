import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PlistParseError } from "./errors";

const execute = promisify(execFile);
export interface DiskUtilPlistDisk {
  DeviceIdentifier: string;
  Size: number;
  Content?: string;
  Partitions?: DiskUtilPlistDisk[];
}
export interface DiskUtilListPlist {
  AllDisksAndPartitions: DiskUtilPlistDisk[];
}
export interface DiskUtilInfoPlist {
  DeviceIdentifier: string;
  MediaName?: string;
  IORegistryEntryName?: string;
  BusProtocol?: string;
  TotalSize?: number;
  Removable?: boolean;
  RemovableMediaOrExternalDevice?: boolean;
  Ejectable?: boolean;
  Internal?: boolean;
  OSInternalMedia?: boolean;
  VirtualOrPhysical?: string;
  DeviceTreePath?: string;
}

async function convertPlist(xml: string): Promise<string> {
  const conversion = execute(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "--", "-"],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    },
  );
  let inputError: Error | undefined;
  conversion.child.stdin?.on("error", (error: Error) => {
    inputError = error;
  });
  conversion.child.stdin?.end(xml);
  const { stdout } = await conversion;
  if (inputError) throw inputError;
  return stdout;
}

export async function parseDiskutilPlist(
  xml: string,
  convert: (xml: string) => Promise<string> = convertPlist,
): Promise<unknown> {
  try {
    if (Buffer.byteLength(xml) > 4 * 1024 * 1024)
      throw new Error("Disk inventory exceeds 4 MiB.");
    return JSON.parse(await convert(xml));
  } catch (cause) {
    const error = new PlistParseError(
      "Cannot decode diskutil property list.",
      xml.slice(0, 200),
    );
    error.cause = cause;
    throw error;
  }
}

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PlistParseError("Disk inventory must contain dictionaries.", "");
}
function size(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validateDiskutilList(value: unknown): DiskUtilListPlist {
  record(value);
  if (!Array.isArray(value.AllDisksAndPartitions))
    throw new PlistParseError("Disk inventory has no disk array.", "");
  const pending = value.AllDisksAndPartitions.map((disk) => ({
    disk,
    whole: true,
  }));
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    const { disk, whole } = current;
    record(disk);
    if (
      typeof disk.DeviceIdentifier !== "string" ||
      !(whole ? /^disk\d+$/ : /^disk\d+(?:s\d+)*$/).test(
        disk.DeviceIdentifier,
      ) ||
      seen.has(disk.DeviceIdentifier) ||
      !size(disk.Size) ||
      (disk.Content !== undefined && typeof disk.Content !== "string")
    )
      throw new PlistParseError(
        "Disk inventory has invalid or duplicate device metadata.",
        "",
      );
    seen.add(disk.DeviceIdentifier);
    if (disk.Partitions !== undefined) {
      if (!Array.isArray(disk.Partitions))
        throw new PlistParseError("Disk partitions must be an array.", "");
      pending.push(
        ...disk.Partitions.map((child) => ({ disk: child, whole: false })),
      );
    }
  }
  return value as unknown as DiskUtilListPlist;
}

export function validateDiskutilInfo(
  value: unknown,
  identifier: string,
): DiskUtilInfoPlist {
  record(value);
  if (
    value.DeviceIdentifier !== identifier ||
    (value.Internal === undefined && value.OSInternalMedia === undefined) ||
    (value.TotalSize !== undefined && !size(value.TotalSize))
  )
    throw new PlistParseError(
      "Disk information lacks a matching identity, size, or internal-media classification.",
      "",
    );
  for (const name of [
    "Internal",
    "OSInternalMedia",
    "Removable",
    "RemovableMediaOrExternalDevice",
    "Ejectable",
  ]) {
    if (value[name] !== undefined && typeof value[name] !== "boolean")
      throw new PlistParseError(`Disk ${name} must be boolean.`, "");
  }
  for (const name of [
    "MediaName",
    "IORegistryEntryName",
    "BusProtocol",
    "VirtualOrPhysical",
    "DeviceTreePath",
  ]) {
    if (value[name] !== undefined && typeof value[name] !== "string")
      throw new PlistParseError(`Disk ${name} must be a string.`, "");
  }
  return value as unknown as DiskUtilInfoPlist;
}

export function containsProtectedApplePartition(
  disk: DiskUtilPlistDisk,
): boolean {
  const pending = [disk];
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    if (/^Apple_(?:APFS|HFS|CoreStorage)/.test(current.Content ?? ""))
      return true;
    pending.push(...(current.Partitions ?? []));
  }
  return false;
}

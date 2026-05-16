import { exec } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_SAFETY_MARGIN_BYTES = 2 * 1024 ** 3;

export interface DiskSpace {
  path?: string;
  pathProbed: string;
  totalBytes: number;
  freeBytes: number;
  availableBytes?: number;
  probed?: boolean;
}

export type DiskSpaceWarning = "low-disk" | "critical-disk";

export interface DiskSpaceAdvice {
  fits: boolean;
  warning?: DiskSpaceWarning;
  freeAfterDownloadBytes: number;
  requiredBytes: number;
  safetyMarginBytes: number;
}

interface StatfsResult {
  bavail: bigint | number;
  bfree?: bigint | number;
  blocks: bigint | number;
  frsize?: bigint | number;
  bsize?: bigint | number;
}

interface WmicVolume {
  freeBytes: number;
  totalBytes: number;
}

function toNumber(value: bigint | number | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return 0;
}

function diskSpaceFromValues(
  path: string,
  values: {
    totalBytes: number;
    freeBytes: number;
    availableBytes?: number;
    probed: boolean;
  },
): DiskSpace {
  const availableBytes = values.availableBytes ?? values.freeBytes;
  return {
    path,
    pathProbed: path,
    totalBytes: values.totalBytes,
    freeBytes: values.freeBytes,
    availableBytes,
    probed: values.probed,
  };
}

function fallbackDiskSpace(path: string): DiskSpace {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return diskSpaceFromValues(path, {
    totalBytes,
    freeBytes,
    availableBytes: freeBytes,
    probed: false,
  });
}

async function probePosixDiskSpace(path: string): Promise<DiskSpace> {
  const stats = (await statfs(path, {
    bigint: true,
  })) as unknown as StatfsResult;
  const blockSize = toNumber(stats.frsize) || toNumber(stats.bsize);
  const availableBytes = toNumber(stats.bavail) * blockSize;
  const freeBytes = toNumber(stats.bfree) * blockSize || availableBytes;
  const totalBytes = toNumber(stats.blocks) * blockSize;
  return diskSpaceFromValues(path, {
    totalBytes,
    freeBytes,
    availableBytes,
    probed: true,
  });
}

function parseWmicOutput(stdout: string): WmicVolume | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^FreeSpace\s+Size$/i.test(line));

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const freeBytes = Number(parts[0]);
    const totalBytes = Number(parts[1]);
    if (
      Number.isFinite(freeBytes) &&
      Number.isFinite(totalBytes) &&
      totalBytes > 0
    ) {
      return { freeBytes, totalBytes };
    }
  }

  return null;
}

async function probeWindowsViaWmic(path: string): Promise<DiskSpace> {
  const { stdout } = await execAsync("wmic logicaldisk get freespace,size", {
    windowsHide: true,
  });
  const parsed = parseWmicOutput(stdout);
  if (!parsed) {
    throw new Error("wmic logicaldisk produced no parseable output");
  }
  return diskSpaceFromValues(path, {
    ...parsed,
    availableBytes: parsed.freeBytes,
    probed: true,
  });
}

export async function probeDiskSpace(path: string): Promise<DiskSpace> {
  try {
    return await probePosixDiskSpace(path);
  } catch {
    if (process.platform !== "win32") {
      return fallbackDiskSpace(path);
    }

    try {
      return await probeWindowsViaWmic(path);
    } catch {
      return fallbackDiskSpace(path);
    }
  }
}

export function adviseDiskSpace(
  probe: DiskSpace,
  modelSizeBytes: number,
  safetyMarginBytes: number = Math.max(
    DEFAULT_SAFETY_MARGIN_BYTES,
    Math.ceil(modelSizeBytes * 0.25),
  ),
): DiskSpaceAdvice {
  const requiredBytes = modelSizeBytes + safetyMarginBytes;
  const freeBytes = Math.max(0, probe.availableBytes || probe.freeBytes);
  const fits = freeBytes >= requiredBytes;
  const freeAfterDownloadBytes = freeBytes - modelSizeBytes;

  if (freeBytes < modelSizeBytes) {
    return {
      fits,
      warning: "critical-disk",
      freeAfterDownloadBytes,
      requiredBytes,
      safetyMarginBytes,
    };
  }
  if (freeBytes < requiredBytes) {
    return {
      fits,
      warning: "low-disk",
      freeAfterDownloadBytes,
      requiredBytes,
      safetyMarginBytes,
    };
  }
  return { fits, freeAfterDownloadBytes, requiredBytes, safetyMarginBytes };
}

export const DISK_SPACE_DEFAULT_SAFETY_MARGIN_BYTES =
  DEFAULT_SAFETY_MARGIN_BYTES;

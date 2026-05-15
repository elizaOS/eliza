import { statfs } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_SAFETY_MARGIN_BYTES = 2 * 1024 * 1024 * 1024;

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
  pathProbed: string;
}

export type DiskSpaceWarning = "low-disk" | "critical-disk";

export interface DiskSpaceAdvice {
  fits: boolean;
  warning?: DiskSpaceWarning;
  freeAfterDownloadBytes: number;
}

interface StatfsResult {
  bavail: bigint | number;
  blocks: bigint | number;
  frsize?: bigint | number;
  bsize?: bigint | number;
}

function toNumber(value: bigint | number | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return 0;
}

async function probePosixDiskSpace(path: string): Promise<DiskSpace> {
  const stats = (await statfs(path, { bigint: true })) as unknown as StatfsResult;
  const blockSize = toNumber(stats.frsize) || toNumber(stats.bsize);
  const freeBytes = toNumber(stats.bavail) * blockSize;
  const totalBytes = toNumber(stats.blocks) * blockSize;
  return { freeBytes, totalBytes, pathProbed: path };
}

interface WmicVolume {
  freeBytes: number;
  totalBytes: number;
}

function parseWmicOutput(stdout: string): WmicVolume | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^FreeSpace\s+Size$/i.test(line));
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const free = Number(parts[0]);
    const size = Number(parts[1]);
    if (Number.isFinite(free) && Number.isFinite(size) && size > 0) {
      return { freeBytes: free, totalBytes: size };
    }
  }
  return null;
}

async function probeWindowsViaWmic(path: string): Promise<DiskSpace> {
  const { stdout } = await execAsync(
    "wmic logicaldisk get freespace,size",
    { windowsHide: true },
  );
  const parsed = parseWmicOutput(stdout);
  if (!parsed) {
    throw new Error("wmic logicaldisk produced no parseable output");
  }
  return { ...parsed, pathProbed: path };
}

export async function probeDiskSpace(path: string): Promise<DiskSpace> {
  try {
    return await probePosixDiskSpace(path);
  } catch (statfsError) {
    if (process.platform !== "win32") {
      throw statfsError;
    }
    try {
      return await probeWindowsViaWmic(path);
    } catch (wmicError) {
      const original = statfsError instanceof Error ? statfsError.message : String(statfsError);
      const fallback = wmicError instanceof Error ? wmicError.message : String(wmicError);
      throw new Error(
        `disk space probe failed: statfs(${original}) + wmic(${fallback})`,
      );
    }
  }
}

export function adviseDiskSpace(
  probe: DiskSpace,
  modelSizeBytes: number,
  safetyMarginBytes: number = DEFAULT_SAFETY_MARGIN_BYTES,
): DiskSpaceAdvice {
  const required = modelSizeBytes + safetyMarginBytes;
  const fits = probe.freeBytes >= required;
  const freeAfterDownloadBytes = probe.freeBytes - modelSizeBytes;
  if (probe.freeBytes < modelSizeBytes) {
    return { fits, warning: "critical-disk", freeAfterDownloadBytes };
  }
  if (probe.freeBytes < required) {
    return { fits, warning: "low-disk", freeAfterDownloadBytes };
  }
  return { fits, freeAfterDownloadBytes };
}

export const DISK_SPACE_DEFAULT_SAFETY_MARGIN_BYTES = DEFAULT_SAFETY_MARGIN_BYTES;

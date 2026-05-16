import { statfs } from "node:fs/promises";
import os from "node:os";

const DEFAULT_SAFETY_MARGIN_BYTES = 2 * 1024 ** 3;

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
  pathProbed: string;
  path?: string;
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

function fallbackDiskSpace(path: string): DiskSpace {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return {
    freeBytes,
    totalBytes,
    path,
    pathProbed: path,
    availableBytes: freeBytes,
    probed: false,
  };
}

export async function probeDiskSpace(path: string): Promise<DiskSpace> {
  try {
    const stats = await statfs(path);
    const blockSize = Number(stats.bsize);
    const freeBytes = Number(stats.bfree) * blockSize;
    const availableBytes = Number(stats.bavail) * blockSize;
    const totalBytes = Number(stats.blocks) * blockSize;
    return {
      freeBytes,
      totalBytes,
      path,
      pathProbed: path,
      availableBytes,
      probed: true,
    };
  } catch {
    return fallbackDiskSpace(path);
  }
}

export function adviseDiskSpace(
  probe: DiskSpace,
  modelSizeBytes: number,
  safetyMarginBytes: number = DEFAULT_SAFETY_MARGIN_BYTES,
): DiskSpaceAdvice {
  const freeBytes = probe.availableBytes ?? probe.freeBytes;
  const requiredBytes = modelSizeBytes + safetyMarginBytes;
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

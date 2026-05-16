import { statfs } from "node:fs/promises";
import os from "node:os";

export interface DiskSpace {
  path: string;
  totalBytes: number;
  freeBytes: number;
  availableBytes: number;
  probed: boolean;
}

export type DiskSpaceWarning = "low-disk" | "critical-disk";

export interface DiskSpaceAdvice {
  warning?: DiskSpaceWarning;
  requiredBytes: number;
  safetyMarginBytes: number;
}

const DEFAULT_SAFETY_MARGIN_BYTES = 2 * 1024 ** 3;

function fallbackDiskSpace(path: string): DiskSpace {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return {
    path,
    totalBytes,
    freeBytes,
    availableBytes: freeBytes,
    probed: false,
  };
}

export async function probeDiskSpace(path: string): Promise<DiskSpace> {
  try {
    const stats = await statfs(path);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bfree) * Number(stats.bsize);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      path,
      totalBytes,
      freeBytes,
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
): DiskSpaceAdvice {
  const safetyMarginBytes = Math.max(
    DEFAULT_SAFETY_MARGIN_BYTES,
    Math.ceil(modelSizeBytes * 0.25),
  );
  const requiredBytes = modelSizeBytes + safetyMarginBytes;
  const freeBytes = Math.max(0, probe.availableBytes || probe.freeBytes);

  if (freeBytes < modelSizeBytes) {
    return { warning: "critical-disk", requiredBytes, safetyMarginBytes };
  }
  if (freeBytes < requiredBytes) {
    return { warning: "low-disk", requiredBytes, safetyMarginBytes };
  }
  return { requiredBytes, safetyMarginBytes };
}

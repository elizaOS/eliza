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
export declare function probeDiskSpace(path: string): Promise<DiskSpace>;
export declare function adviseDiskSpace(
  probe: DiskSpace,
  modelSizeBytes: number,
  safetyMarginBytes?: number,
): DiskSpaceAdvice;
export declare const DISK_SPACE_DEFAULT_SAFETY_MARGIN_BYTES: number;
//# sourceMappingURL=disk-space.d.ts.map

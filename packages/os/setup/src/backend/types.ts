export interface ConnectedDevice {
  serial: string;
  model: string;
  codename: string;
  state: "device" | "bootloader" | "recovery" | "unauthorized" | "offline";
  /** null = unknown — need fastboot to check */
  bootloaderUnlocked: boolean | null;
}

export interface AospBuild {
  id: string;
  label: string;
  version: string;
  channel: "stable" | "beta" | "nightly";
  /** device codename, e.g. "caiman" */
  targetDevice: string;
  architecture: "arm64-v8a" | "x86_64" | "riscv64";
  publishedAt: string;
  /** points to android-release-manifest JSON */
  manifestUrl: string;
  /** local path if pre-built artifacts are already available */
  artifactDir?: string;
  sizeBytes: number;
  /** When true, flash-partitions step appends --wipe-data (factory reset). */
  wipeData?: boolean;
}

export interface ManifestArtifact {
  name: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface AndroidReleaseManifest {
  releaseId?: string;
  generatedAt?: string;
  supportedDevices?: Array<{ codename?: string; marketingName?: string }>;
  artifacts: ManifestArtifact[];
}

export type FlashStepId =
  | "detect-device"
  | "check-bootloader"
  | "reboot-bootloader"
  | "unlock-bootloader"
  | "download-artifacts"
  | "verify-artifacts"
  | "flash-partitions"
  | "reboot-android"
  | "validate-boot"
  | "complete";

export type FlashStepStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "waiting-user";

export interface FlashStep {
  id: FlashStepId;
  label: string;
  status: FlashStepStatus;
  detail: string;
  /** Present when status === "waiting-user": describes physical action required */
  userAction?: string;
}

export interface FlashRequest {
  deviceSerial: string;
  buildId: string;
  wipeData: boolean;
  dryRun: boolean;
  /**
   * If set, the executor stops after the named step completes.
   * Used by the bootloader-unlock guide UI to drive single backend operations.
   */
  stopAfter?: FlashStepId;
}

export interface FlashPlan {
  device: ConnectedDevice;
  build: AospBuild;
  steps: FlashStep[];
  artifactDir: string | null;
  /** Original request — used by executor to decide dry-run vs real run, wipeData, etc. */
  request: FlashRequest;
  /** Per-artifact local paths after download (filled in by executor). */
  artifactPaths?: Record<string, string>;
}

export interface DeviceSpecs {
  storageAvailableBytes: number;
  storageTotalBytes: number;
  androidVersion: string;
  abi: string;
  bootloaderLocked: boolean | null;
  supportedByElizaOs: boolean;
  /** codename to use for build lookup, e.g. "bluejay" */
  supportedBuildCodename: string | null;
}

export interface AospFlasherBackend {
  listConnectedDevices(): Promise<ConnectedDevice[]>;
  getDeviceSpecs(serial: string): Promise<DeviceSpecs>;
  listBuilds(): Promise<AospBuild[]>;
  createFlashPlan(request: FlashRequest): Promise<FlashPlan>;
  executeFlashPlan(
    plan: FlashPlan,
    onProgress: (
      stepId: FlashStepId,
      status: FlashStepStatus,
      detail: string,
    ) => void,
  ): Promise<void>;
}

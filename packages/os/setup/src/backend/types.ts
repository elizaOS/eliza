// Implements backend device and HTTP operations for the AOSP setup flasher.
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
  /** stable repository hardware target identifier */
  targetId: string;
  architecture: "arm64-v8a" | "x86_64" | "riscv64";
  publishedAt: string;
  /** points to android-release-manifest JSON */
  manifestUrl: string;
  /** local path if pre-built artifacts are already available */
  artifactDir?: string;
  /** local validated manifest for pre-built artifacts */
  manifestPath?: string;
  /** release manifest retained from authoritative discovery */
  manifest?: AndroidReleaseManifest;
  /** GitHub release asset URLs keyed by exact artifact filename */
  artifactUrls?: Record<string, string>;
  sizeBytes: number;
  /** When true, flash-partitions step appends --wipe-data (factory reset). */
  wipeData?: boolean;
}

export interface ManifestArtifact {
  partition: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  required: boolean;
  fastbootMode: "bootloader" | "fastbootd";
}

export interface AndroidReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  generatedAt: string;
  buildFingerprint: string;
  buildType?: "user" | "userdebug" | "eng" | "unknown";
  supportedDevices: Array<{
    targetId: string;
    codename: string;
    marketingName?: string;
    tier: "lab-validated" | "candidate" | "manual" | "blocked";
    slots: Array<"a" | "b" | "none">;
    dynamicPartitions: boolean;
    rollbackSupported: boolean;
  }>;
  artifacts: ManifestArtifact[];
  validation: Record<string, unknown>;
  rollback: Record<string, unknown>;
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
  /** Exact release manifest used to authorize local or downloaded artifacts. */
  manifestPath?: string | null;
  /** Original request — used by executor to decide dry-run vs real run, wipeData, etc. */
  request: FlashRequest;
  /** Short-lived, one-use server token binding execution to this exact plan. */
  executionToken?: string;
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

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
  architecture: "arm64-v8a" | "x86_64";
  publishedAt: string;
  /** points to android-release-manifest JSON */
  manifestUrl: string;
  /** local path if pre-built artifacts are already available */
  artifactDir?: string;
  sizeBytes: number;
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
}

export interface FlashPlan {
  device: ConnectedDevice;
  build: AospBuild;
  steps: FlashStep[];
  artifactDir: string | null;
  privilegedFlashImplemented: boolean;
}

export interface AospFlasherBackend {
  listConnectedDevices(): Promise<ConnectedDevice[]>;
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

// Implements platform-specific USB installer backend safety behavior.
export type PlatformId = "darwin" | "linux" | "win32" | "unknown";

export type DriveSafety = "safe-removable" | "blocked-system" | "unknown";

export interface RemovableDrive {
  id: string;
  name: string;
  devicePath: string;
  sizeBytes: number;
  bus: "usb" | "sd" | "virtual" | "unknown";
  platform: PlatformId;
  safety: DriveSafety;
  description?: string;
  /** Platform-reported immutable identity (serial/WWN/unique id), when available. */
  stableId?: string;
}

export interface ElizaOsImage {
  id: string;
  label: string;
  version: string;
  channel: "stable" | "beta" | "nightly";
  architecture: "x86_64" | "arm64" | "riscv64";
  buildId: string;
  publishedAt: string;
  url: string;
  checksumSha256: string;
  sizeBytes: number;
  minUsbSizeBytes: number;
  manifestVersion: 1;
  releaseNotesUrl?: string;
  signatureUrl?: string;
  /** Canonical mkosi release contract fields. Legacy fixtures may omit these. */
  schemaVersion?: 1;
  product?: "elizaOS";
  sequence?: number;
  expires?: string;
  compressedSize?: number;
  expandedSize?: number;
  sha256Compressed?: string;
  sha256Expanded?: string;
  minDeviceBytes?: number;
  format?: "raw.zst";
}

export type InstallerStepId =
  | "resolve-image"
  | "checksum"
  | "write"
  | "verify"
  | "complete";

export type InstallerStepStatus =
  | "pending"
  | "running"
  | "complete"
  | "blocked";

export interface InstallerStep {
  id: InstallerStepId;
  label: string;
  status: InstallerStepStatus;
  detail: string;
}

export interface WriteRequest {
  driveId: string;
  imageId: string;
  dryRun: boolean;
  acknowledgeDataLoss: boolean;
  expectedDrive?: {
    devicePath: string;
    sizeBytes: number;
    name?: string;
    stableId?: string;
  };
}

export interface WritePlan {
  planId?: string;
  cancellationSupported?: boolean;
  request: WriteRequest;
  drive: RemovableDrive;
  image: ElizaOsImage;
  steps: InstallerStep[];
  privilegedWriteImplemented: boolean;
}

export interface WriteExecutionOptions {
  signal?: AbortSignal;
}

export interface UsbInstallerBackend {
  /** True only when this backend streams, verifies, expands, and reads back raw.zst media. */
  readonly canonicalRawZstdSupported?: boolean;
  /** True only when canonical raw.zst execution honors WriteExecutionOptions.signal. */
  readonly canonicalWriteCancellationSupported?: boolean;
  listRemovableDrives(): Promise<RemovableDrive[]>;
  listImages(): Promise<ElizaOsImage[]>;
  createWritePlan(request: WriteRequest): Promise<WritePlan>;
  executeWritePlan?(
    plan: WritePlan,
    onProgress: (step: InstallerStepId, progress: number) => void,
    options?: WriteExecutionOptions,
  ): Promise<void>;
  /** Request cancellation of an execution already accepted by the backend. */
  cancelWritePlan?(plan: WritePlan): Promise<void>;
}

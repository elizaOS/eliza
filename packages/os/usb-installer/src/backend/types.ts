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
}

export interface ElizaOsImage {
  id: string;
  label: string;
  version: string;
  channel: "stable" | "beta" | "nightly";
  architecture: "x86_64" | "arm64";
  buildId: string;
  publishedAt: string;
  url: string;
  checksumSha256: string;
  sizeBytes: number;
  minUsbSizeBytes: number;
  manifestVersion: 1;
  releaseNotesUrl?: string;
  signatureUrl?: string;
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
}

export interface WritePlan {
  request: WriteRequest;
  drive: RemovableDrive;
  image: ElizaOsImage;
  steps: InstallerStep[];
  privilegedWriteImplemented: boolean;
}

export interface UsbInstallerBackend {
  listRemovableDrives(): Promise<RemovableDrive[]>;
  listImages(): Promise<ElizaOsImage[]>;
  createWritePlan(request: WriteRequest): Promise<WritePlan>;
  executeWritePlan?(
    plan: WritePlan,
    onProgress: (step: InstallerStepId, progress: number) => void,
  ): Promise<void>;
}

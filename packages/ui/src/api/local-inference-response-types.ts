/** JSON response shapes for the backend local-inference API. No runtime implementations. */
export interface DeviceCapabilities {
  platform: "ios" | "android" | "web" | "electrobun" | "desktop";
  deviceModel: string;
  machineId?: string;
  osVersion?: string;
  isSimulator?: boolean;
  totalRamGb: number;
  availableRamGb?: number | null;
  freeStorageGb?: number | null;
  cpuCores: number;
  gpu: {
    backend: "metal" | "vulkan" | "gpu-delegate" | "cuda";
    available: boolean;
    totalVramGb?: number;
  } | null;
  gpuSupported?: boolean;
  lowPowerMode?: boolean;
  thermalState?: "nominal" | "fair" | "serious" | "critical" | "unknown";
  mtpSupported?: boolean;
  mtpReason?: string;
}

export interface DeviceSummary {
  deviceId: string;
  capabilities: DeviceCapabilities;
  loadedPath: string | null;
  connectedSince: string;
  score: number;
  activeRequests: number;
  isPrimary: boolean;
}

export interface DeviceBridgeStatus {
  /** True if any device is currently connected. */
  connected: boolean;
  devices: DeviceSummary[];
  /** Device id of the current best-score device, or null when none. */
  primaryDeviceId: string | null;
  /** Total generates/loads/unloads queued (either in-flight or awaiting a device). */
  pendingRequests: number;
  // Legacy single-device fields — kept for UI backward compat. These mirror
  // the primary device so old `DeviceBridgeStatusBar` code keeps working.
  deviceId: string | null;
  capabilities: DeviceCapabilities | null;
  loadedPath: string | null;
  connectedSince: string | null;
}

export interface PublicRegistration {
  modelType: string;
  provider: string;
  priority: number;
  registeredAt: string;
}


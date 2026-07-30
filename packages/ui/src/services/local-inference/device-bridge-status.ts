/**
 * Browser-safe status contract for rendering devices connected to the
 * server-owned local-inference bridge.
 */

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
  connected: boolean;
  devices: DeviceSummary[];
  primaryDeviceId: string | null;
  pendingRequests: number;
  deviceId: string | null;
  capabilities: DeviceCapabilities | null;
  loadedPath: string | null;
  connectedSince: string | null;
}

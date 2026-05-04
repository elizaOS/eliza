/**
 * Shared system permission contracts.
 */

export type SystemPermissionId =
  | "accessibility"
  | "screen-recording"
  | "microphone"
  | "camera"
  | "shell"
  | "website-blocking"
  | "location";

export type PermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "not-applicable";

export type Platform = "darwin" | "win32" | "linux";

export interface SystemPermissionDefinition {
  id: SystemPermissionId;
  name: string;
  description: string;
  icon: string;
  platforms: Platform[];
  requiredForFeatures: string[];
}

export interface PermissionState {
  id: SystemPermissionId;
  status: PermissionStatus;
  lastChecked: number;
  canRequest: boolean;
  reason?: string;
}

export interface PermissionCheckResult {
  status: PermissionStatus;
  canRequest: boolean;
  reason?: string;
}

export interface AllPermissionsState {
  accessibility: PermissionState;
  "screen-recording": PermissionState;
  microphone: PermissionState;
  camera: PermissionState;
  shell: PermissionState;
  "website-blocking": PermissionState;
  location: PermissionState;
}

export interface PermissionManagerConfig {
  cacheTimeoutMs: number;
}

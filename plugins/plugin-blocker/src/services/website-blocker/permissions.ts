import type { Platform } from "@elizaos/shared";

export type PermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "not-applicable";

export type PermissionPlatform = Platform;

export interface PermissionState {
  id: "website-blocking";
  status: PermissionStatus;
  lastChecked: number;
  canRequest: boolean;
  platform: PermissionPlatform;
  reason?: string;
}

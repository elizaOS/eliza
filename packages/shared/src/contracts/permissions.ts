/**
 * Shared system permission contracts.
 *
 * `PermissionId` is the canonical identifier union. The legacy
 * `SystemPermissionId` alias is retained for back-compat — older callers
 * referenced the seven original ids but the wider union is a strict superset,
 * so they keep typechecking.
 */

export type PermissionId =
  | "screen-recording"
  | "accessibility"
  | "reminders"
  | "calendar"
  | "health"
  | "screentime"
  | "contacts"
  | "notes"
  | "microphone"
  | "camera"
  | "location"
  | "shell"
  | "website-blocking"
  | "notifications"
  | "full-disk"
  | "automation";

/**
 * Back-compat alias. Existing callers spell this `SystemPermissionId`. Now a
 * pure alias of `PermissionId` so the new ids are accepted everywhere.
 */
export type SystemPermissionId = PermissionId;

export type PermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "not-applicable";

export type PermissionRestrictedReason =
  | "entitlement_required"
  | "platform_unsupported"
  | "os_policy";

export type Platform = "darwin" | "win32" | "linux";

export interface SystemPermissionDefinition {
  id: PermissionId;
  name: string;
  description: string;
  icon: string;
  platforms: Platform[];
  requiredForFeatures: string[];
}

export interface PermissionState {
  id: PermissionId;
  status: PermissionStatus;
  restrictedReason?: PermissionRestrictedReason;
  lastChecked: number;
  lastRequested?: number;
  lastBlockedFeature?: { app: string; action: string; at: number };
  canRequest: boolean;
  platform: Platform;
  /**
   * Legacy free-text reason field. Prefer `restrictedReason` for the
   * categorical reason a permission is unavailable. Kept for back-compat with
   * callers that surfaced human-readable strings inline.
   */
  reason?: string;
}

export interface PermissionCheckResult {
  status: PermissionStatus;
  canRequest: boolean;
  reason?: string;
}

/**
 * Legacy fixed-shape map keyed by the original seven permission ids. Phase 2
 * agent migrates consumers off this in favor of the registry. Until then the
 * shape is frozen so `permission-controls.tsx` and the dashboard API keep
 * working.
 */
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

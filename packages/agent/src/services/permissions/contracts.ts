/**
 * Permissions contract — local stub.
 *
 * INTEGRATION TODO: a sibling agent is expanding
 * `packages/shared/src/contracts/permissions.ts` with this same shape. When
 * that lands, replace this file with a re-export:
 *
 *     export type {
 *       PermissionId,
 *       PermissionStatus,
 *       PermissionRestrictedReason,
 *       PermissionState,
 *       Prober,
 *     } from "@elizaos/shared";
 *
 * The pre-existing `SystemPermissionId` / `PermissionState` types in
 * `@elizaos/shared/contracts/permissions` are a strict subset of this new
 * contract. This stub exists so prober work can land in parallel with the
 * shared-contract refactor without depending on its merge order.
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

export type PermissionPlatform = "darwin" | "win32" | "linux";

export interface PermissionBlockedFeature {
  app: string;
  action: string;
  at: number;
}

export interface PermissionState {
  id: PermissionId;
  status: PermissionStatus;
  restrictedReason?: PermissionRestrictedReason;
  lastChecked: number;
  lastRequested?: number;
  lastBlockedFeature?: PermissionBlockedFeature;
  canRequest: boolean;
  platform: PermissionPlatform;
}

export interface PermissionRequestOptions {
  reason: string;
}

export interface Prober {
  id: PermissionId;
  check(): Promise<PermissionState>;
  request(opts: PermissionRequestOptions): Promise<PermissionState>;
}

/**
 * Registry interface that the sibling agent is building. Defined here as a
 * structural contract so `registerAllProbers` can typecheck independently.
 */
export interface IPermissionsRegistry {
  registerProber(prober: Prober): void;
}

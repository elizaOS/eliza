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
 * Legacy narrow alias for the original seven permission ids that the
 * dashboard API (`AllPermissionsState`) and existing UI callers depend on.
 * Kept as a strict subset of `PermissionId` so existing record-keyed lookups
 * compile. New code should use `PermissionId` for the full 16-id union.
 */
export type SystemPermissionId =
  | "accessibility"
  | "screen-recording"
  | "microphone"
  | "camera"
  | "shell"
  | "website-blocking"
  | "location";

/**
 * Extended permission identifier set covering OS integrations beyond the
 * narrow `SystemPermissionId` set. Used by the chat permission_request flow,
 * the permissions registry, and the OS deep-link helpers.
 *
 * The first seven entries align 1:1 with `SystemPermissionId` so the registry
 * can interoperate with both surfaces.
 */
export type PermissionId =
  | "accessibility"
  | "screen-recording"
  | "microphone"
  | "camera"
  | "shell"
  | "website-blocking"
  | "location"
  | "reminders"
  | "calendar"
  | "health"
  | "screentime"
  | "contacts"
  | "notes"
  | "notifications"
  | "full-disk"
  | "automation";

export const PERMISSION_IDS: readonly PermissionId[] = [
  "accessibility",
  "screen-recording",
  "microphone",
  "camera",
  "shell",
  "website-blocking",
  "location",
  "reminders",
  "calendar",
  "health",
  "screentime",
  "contacts",
  "notes",
  "notifications",
  "full-disk",
  "automation",
] as const;

export function isPermissionId(value: unknown): value is PermissionId {
  return (
    typeof value === "string" &&
    (PERMISSION_IDS as readonly string[]).includes(value)
  );
}

/**
 * Why a `restricted` permission cannot be requested. Surfaces in the chat
 * card so the user understands why the button is disabled.
 */
export type PermissionRestrictedReason =
  | "entitlement_required"
  | "platform_unsupported"
  | "managed_by_policy";

/**
 * Feature reference attached to permission requests/blocks. The dotted
 * `<app>.<area>.<action>` form is the canonical wire format; the structured
 * fields are used by the registry's block-tracker for the planner provider.
 */
export interface PermissionFeatureRef {
  app: string;
  action: string;
}

export interface PermissionBlockRecord {
  feature: string;
  app?: string;
  action?: string;
  blockedAt: number;
}

/**
 * Lightweight registry interface consumed by the chat-side permission card
 * and the pending-permissions provider. The concrete implementation is owned
 * by a sibling agent — this is the contract surface that this module relies
 * on.
 */
export interface IPermissionsRegistry {
  get(id: PermissionId): PermissionState;
  request(
    id: PermissionId,
    opts: { reason: string; feature: PermissionFeatureRef | string },
  ): Promise<PermissionState>;
  recordBlock(id: PermissionId, feature: string): void;
  pending(): PermissionState[];
  subscribe(cb: (state: PermissionState) => void): () => void;
}

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
  /** Set when status === "restricted" to explain why a request is impossible. */
  restrictedReason?: PermissionRestrictedReason;
  /** Most recent block record for the planner-visible pending-permissions list. */
  lastBlock?: PermissionBlockRecord;
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

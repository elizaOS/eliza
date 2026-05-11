/**
 * Shared system permission contracts.
 *
 * `PermissionId` is the canonical 16-id union covering OS integrations across
 * macOS / win32 / linux.
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

/** Legacy narrow alias for older dashboard callers. New code should use PermissionId. */
export type SystemPermissionId =
  | "accessibility"
  | "screen-recording"
  | "microphone"
  | "camera"
  | "shell"
  | "website-blocking"
  | "location";

export const PERMISSION_IDS: readonly PermissionId[] = [
  "screen-recording",
  "accessibility",
  "reminders",
  "calendar",
  "health",
  "screentime",
  "contacts",
  "notes",
  "microphone",
  "camera",
  "location",
  "shell",
  "website-blocking",
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

export type PermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "not-applicable";

/**
 * Why a `restricted` permission cannot be requested. Surfaces in the chat
 * card so the user understands why the button is disabled.
 */
export type PermissionRestrictedReason =
  | "entitlement_required"
  | "platform_unsupported"
  | "os_policy";

export type Platform = "darwin" | "win32" | "linux";

/**
 * Feature reference attached to permission requests/blocks. Structured form
 * is the wire format; the dotted `<app>.<area>.<action>` string is the
 * planner-visible representation.
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
  /** Set when status === "restricted" to explain why a request is impossible. */
  restrictedReason?: PermissionRestrictedReason;
  lastChecked: number;
  lastRequested?: number;
  /** Most recent feature that was blocked by this permission. */
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
 * Prober contract: each `PermissionId` is wired to one of these. The registry
 * delegates `check()` (probe-without-prompt) and `request()` (prompt the OS).
 */
export interface Prober {
  id: PermissionId;
  check(): Promise<PermissionState>;
  request(opts: { reason: string }): Promise<PermissionState>;
}

/**
 * Central registry contract consumed by the chat permission card,
 * pending-permissions provider, and feature callers. The concrete
 * implementation lives in `@elizaos/agent` (`PermissionRegistry`).
 */
export interface IPermissionsRegistry {
  get(id: PermissionId): PermissionState;
  check(id: PermissionId): Promise<PermissionState>;
  request(
    id: PermissionId,
    opts: { reason: string; feature: PermissionFeatureRef },
  ): Promise<PermissionState>;
  recordBlock(id: PermissionId, feature: PermissionFeatureRef): void;
  list(): PermissionState[];
  pending(): PermissionState[];
  subscribe(cb: (state: PermissionState[]) => void): () => void;
  registerProber(prober: Prober): void;
}

/**
 * Full permission-state snapshot keyed by every canonical permission id.
 * Legacy callers that only render the original dashboard subset can safely
 * index the keys they know about; newer settings/chat surfaces use the full
 * map so LifeOps, Health, Screen Time, and Apple app permissions share one
 * contract.
 */
export type AllPermissionsState = Record<PermissionId, PermissionState>;

export interface PermissionManagerConfig {
  cacheTimeoutMs: number;
}

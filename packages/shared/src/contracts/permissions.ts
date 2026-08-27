/**
 * Shared system permission contracts.
 *
 * The catalog owns platform-neutral metadata once. Shells provide explicit
 * platform projections for what they implement or display.
 */

export type Platform = "darwin" | "win32" | "linux" | "ios" | "android" | "web";

/** Canonical metadata independent of any shell's implementation support. */
export const PERMISSION_DEFINITIONS = [
  {
    id: "accessibility",
    name: "Accessibility",
    description:
      "Control mouse, keyboard, and interact with other applications",
    icon: "cursor",
    requiredForFeatures: ["computeruse", "browser"],
  },
  {
    id: "screen-recording",
    name: "Screen Recording",
    description: "Capture screen content for screenshots and vision",
    icon: "monitor",
    requiredForFeatures: ["computeruse", "vision"],
  },
  {
    id: "microphone",
    name: "Microphone",
    description: "Voice input for talk mode and speech recognition",
    icon: "mic",
    requiredForFeatures: ["talkmode", "voice"],
  },
  {
    id: "camera",
    name: "Camera",
    description: "Video input for vision and video capture",
    icon: "camera",
    requiredForFeatures: ["camera", "vision"],
  },
  {
    id: "shell",
    name: "Shell Access",
    description: "Execute terminal commands and scripts",
    icon: "terminal",
    requiredForFeatures: ["shell"],
  },
  {
    id: "website-blocking",
    name: "Website Blocking",
    description:
      "Edit the system hosts file to block distracting websites. This may require admin/root approval each time.",
    icon: "shield-ban",
    requiredForFeatures: ["website-blocker"],
  },
  {
    id: "location",
    name: "Location",
    description:
      "Read the device's current location for travel-time, time-zone, and place-aware planning. Mobile uses GPS; desktop falls back to coarse IP geolocation.",
    icon: "map-pin",
    requiredForFeatures: ["travel-time", "location"],
  },
  {
    id: "reminders",
    name: "Apple Reminders",
    description: "Create and update Apple Reminders for LifeOps tasks",
    icon: "list-todo",
    requiredForFeatures: ["lifeops", "reminders"],
  },
  {
    id: "calendar",
    name: "Apple Calendar",
    description: "Read and update Apple Calendar events for LifeOps scheduling",
    icon: "calendar",
    requiredForFeatures: ["lifeops", "calendar"],
  },
  {
    id: "health",
    name: "Apple Health",
    description:
      "Read HealthKit data such as sleep and wellness signals from paired devices",
    icon: "heart-pulse",
    requiredForFeatures: ["lifeops", "health", "sleep"],
  },
  {
    id: "screentime",
    name: "Screen Time",
    description: "Read Screen Time and app-usage signals",
    icon: "hourglass",
    requiredForFeatures: ["lifeops", "screentime"],
  },
  {
    id: "contacts",
    name: "Contacts",
    description: "Read and edit Apple Contacts for message name resolution",
    icon: "contact",
    requiredForFeatures: ["imessage", "contacts"],
  },
  {
    id: "notes",
    name: "Apple Notes",
    description: "Read and create Apple Notes through user-approved automation",
    icon: "notebook-tabs",
    requiredForFeatures: ["lifeops", "notes"],
  },
  {
    id: "notifications",
    name: "Notifications",
    description:
      "Show system notifications for reminders and background results",
    icon: "bell",
    requiredForFeatures: ["notifications", "lifeops"],
  },
  {
    id: "full-disk",
    name: "Full Disk Access",
    description:
      "Read protected local app data such as Messages databases when explicitly enabled",
    icon: "hard-drive",
    requiredForFeatures: ["imessage", "local-data"],
  },
  {
    id: "automation",
    name: "Automation",
    description: "Control other macOS apps through Apple Events",
    icon: "workflow",
    requiredForFeatures: ["messages", "notes", "automation"],
  },
  {
    id: "speech-recognition",
    name: "Speech Recognition",
    description: "Transcribe speech through the platform speech recognizer",
    icon: "audio-lines",
    requiredForFeatures: ["talkmode", "voice", "swabble"],
  },
  {
    id: "photos",
    name: "Photos",
    description: "Read or save photos and videos when capturing media",
    icon: "image",
    requiredForFeatures: ["camera", "media"],
  },
  {
    id: "phone",
    name: "Phone",
    description: "Place calls and read recent call history on Android",
    icon: "phone",
    requiredForFeatures: ["phone", "dialer"],
  },
  {
    id: "messages",
    name: "Messages",
    description: "Send SMS and read message threads on Android",
    icon: "message-square",
    requiredForFeatures: ["messages", "sms"],
  },
  {
    id: "wifi",
    name: "Wi-Fi Scans",
    description:
      "Scan nearby Wi-Fi networks; Android gates scan results behind Location",
    icon: "wifi",
    requiredForFeatures: ["wifi", "gateway"],
  },
  {
    id: "bluetooth",
    name: "Bluetooth",
    description: "Discover and connect to nearby Bluetooth accessories",
    icon: "bluetooth",
    requiredForFeatures: ["gateway"],
  },
  {
    id: "app-blocking",
    name: "App Blocking",
    description:
      "Select and block distracting apps with Screen Time or Android usage controls",
    icon: "shield-ban",
    requiredForFeatures: ["app-blocker", "lifeops"],
  },
  {
    id: "usage-access",
    name: "Usage Access",
    description: "Read Android app usage for Screen Time and app blocking",
    icon: "hourglass",
    requiredForFeatures: ["screentime", "app-blocker"],
  },
  {
    id: "overlay",
    name: "Draw Over Apps",
    description: "Show Android blocking overlays above distracting apps",
    icon: "app-window",
    requiredForFeatures: ["app-blocker"],
  },
  {
    id: "write-settings",
    name: "Write Settings",
    description: "Change Android system brightness and related device settings",
    icon: "settings",
    requiredForFeatures: ["device-settings"],
  },
  {
    id: "local-network",
    name: "Local Network",
    description: "Discover nearby gateways and devices on the local network",
    icon: "network",
    requiredForFeatures: ["gateway", "device-discovery"],
  },
  {
    id: "battery-optimization",
    name: "Battery Optimization",
    description:
      "Allow background monitoring to keep LifeOps and device signals current",
    icon: "battery",
    requiredForFeatures: ["lifeops", "mobile-signals"],
  },
] as const;

export type PermissionId = (typeof PERMISSION_DEFINITIONS)[number]["id"];

/** Legacy narrow alias for older dashboard callers. New code should use PermissionId. */
export type SystemPermissionId =
  | "accessibility"
  | "screen-recording"
  | "microphone"
  | "camera"
  | "shell"
  | "website-blocking"
  | "location";

export const PERMISSION_IDS: readonly PermissionId[] =
  PERMISSION_DEFINITIONS.map(({ id }) => id);

export function isPermissionId(value: unknown): value is PermissionId {
  return (
    typeof value === "string" &&
    (PERMISSION_IDS as readonly string[]).includes(value)
  );
}

export type PermissionStatus =
  | "granted"
  | "limited"
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
  platforms: readonly Platform[];
  requiredForFeatures: readonly string[];
}

/** Complete platform projection for one consumer surface. */
export type PermissionPlatformProjection = Readonly<
  Record<PermissionId, readonly Platform[]>
>;

/** Joins canonical metadata to a consumer-owned support/display projection. */
export function projectPermissionDefinitions(
  projection: PermissionPlatformProjection,
): readonly SystemPermissionDefinition[] {
  return PERMISSION_DEFINITIONS.map((definition) => ({
    ...definition,
    platforms: projection[definition.id],
  }));
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
 * delegates `check()` (probe-without-prompt), `request()` (prompt the OS),
 * and optionally `openSettings()` (navigate to the relevant consent surface).
 */
export interface Prober {
  id: PermissionId;
  check(): Promise<PermissionState>;
  request(opts: { reason: string }): Promise<PermissionState>;
  openSettings?(): Promise<boolean>;
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
  openSettings(id: PermissionId): Promise<boolean>;
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

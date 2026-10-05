/**
 * Shared system permission contracts.
 *
 * `PermissionId` is the canonical union covering OS integrations across
 * macOS / win32 / linux / iOS / Android / web.
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
	| "automation"
	| "speech-recognition"
	| "photos"
	| "phone"
	| "messages"
	| "wifi"
	| "bluetooth"
	| "app-blocking"
	| "usage-access"
	| "overlay"
	| "write-settings"
	| "local-network"
	| "battery-optimization";

/** Dashboard permission subset. */
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
	"speech-recognition",
	"photos",
	"phone",
	"messages",
	"wifi",
	"bluetooth",
	"app-blocking",
	"usage-access",
	"overlay",
	"write-settings",
	"local-network",
	"battery-optimization",
] as const;

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

export type Platform = "darwin" | "win32" | "linux" | "ios" | "android" | "web";

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
	/** Free-text reason for display; restrictedReason carries the categorical restriction. */
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

/** Permission-state snapshot keyed by canonical permission ID. Consumers may select the subset they render. */
export type AllPermissionsState = Record<PermissionId, PermissionState>;

export interface PermissionManagerConfig {
	cacheTimeoutMs: number;
}

export type {
	PermissionCheckResult,
	PermissionId,
	PermissionState,
	PermissionStatus,
	Platform,
	SystemPermissionDefinition,
} from "@elizaos/shared";

import type {
	PermissionId,
	PermissionState,
	Platform,
	SystemPermissionDefinition,
} from "@elizaos/shared";

export type SystemPermissionId = PermissionId;

/** Local variant keeps a loose index signature for legacy Electrobun RPC code. */
export interface AllPermissionsState {
	[key: string]: PermissionState;
}

export const SYSTEM_PERMISSIONS: SystemPermissionDefinition[] = [
	{
		id: "accessibility",
		name: "Accessibility",
		description:
			"Control mouse, keyboard, and interact with other applications",
		icon: "cursor",
		platforms: ["darwin"],
		requiredForFeatures: ["computeruse", "browser"],
	},
	{
		id: "screen-recording",
		name: "Screen Recording",
		description: "Capture screen content for screenshots and vision",
		icon: "monitor",
		platforms: ["darwin"],
		requiredForFeatures: ["computeruse", "vision"],
	},
	{
		id: "microphone",
		name: "Microphone",
		description: "Voice input for talk mode and speech recognition",
		icon: "mic",
		platforms: ["darwin", "win32", "linux"],
		requiredForFeatures: ["talkmode", "voice"],
	},
	{
		id: "camera",
		name: "Camera",
		description: "Video input for vision and video capture",
		icon: "camera",
		platforms: ["darwin", "win32", "linux"],
		requiredForFeatures: ["camera", "vision"],
	},
	{
		id: "shell",
		name: "Shell Access",
		description: "Execute terminal commands and scripts",
		icon: "terminal",
		platforms: ["darwin", "win32", "linux"],
		requiredForFeatures: ["shell"],
	},
	{
		id: "website-blocking",
		name: "Website Blocking",
		description:
			"Edit the system hosts file to block distracting websites. This may require admin/root approval each time.",
		icon: "shield-ban",
		platforms: ["darwin", "win32", "linux"],
		requiredForFeatures: ["website-blocker"],
	},
	{
		id: "location",
		name: "Location",
		description:
			"Read the device's current location for travel-time, time-zone, and place-aware planning. Mobile uses GPS; desktop falls back to coarse IP geolocation.",
		icon: "map-pin",
		platforms: ["darwin", "win32", "linux"],
		requiredForFeatures: ["travel-time", "location"],
	},
	{
		id: "reminders",
		name: "Apple Reminders",
		description: "Create and update Apple Reminders for LifeOps tasks",
		icon: "list-todo",
		platforms: ["darwin"],
		requiredForFeatures: ["lifeops", "reminders"],
	},
	{
		id: "calendar",
		name: "Apple Calendar",
		description: "Control Apple Calendar through user-approved automation",
		icon: "calendar",
		platforms: ["darwin"],
		requiredForFeatures: ["calendar-automation"],
	},
	{
		id: "health",
		name: "Apple Health",
		description:
			"Read HealthKit data such as sleep and wellness signals from paired devices",
		icon: "heart-pulse",
		platforms: ["darwin"],
		requiredForFeatures: ["lifeops", "health", "sleep"],
	},
	{
		id: "screentime",
		name: "Screen Time",
		description: "Read Screen Time and app-usage signals",
		icon: "hourglass",
		platforms: ["darwin"],
		requiredForFeatures: ["lifeops", "screentime"],
	},
	{
		id: "contacts",
		name: "Contacts",
		description: "Read and edit Apple Contacts for message name resolution",
		icon: "contact",
		platforms: ["darwin"],
		requiredForFeatures: ["imessage", "contacts"],
	},
	{
		id: "notes",
		name: "Apple Notes",
		description: "Read and create Apple Notes through user-approved automation",
		icon: "notebook-tabs",
		platforms: ["darwin"],
		requiredForFeatures: ["lifeops", "notes"],
	},
	{
		id: "notifications",
		name: "Notifications",
		description:
			"Show system notifications for reminders and background results",
		icon: "bell",
		platforms: ["darwin", "win32", "linux"],
		requiredForFeatures: ["notifications", "lifeops"],
	},
	{
		id: "full-disk",
		name: "Full Disk Access",
		description:
			"Read protected local app data such as Messages databases when explicitly enabled",
		icon: "hard-drive",
		platforms: ["darwin"],
		requiredForFeatures: ["imessage", "local-data"],
	},
	{
		id: "automation",
		name: "Automation",
		description: "Control other macOS apps through Apple Events",
		icon: "workflow",
		platforms: ["darwin"],
		requiredForFeatures: ["messages", "notes", "automation"],
	},
];

const PERMISSION_MAP = new Map<SystemPermissionId, SystemPermissionDefinition>(
	SYSTEM_PERMISSIONS.map((p) => [p.id, p]),
);

export function isPermissionApplicable(
	id: SystemPermissionId,
	platform: Platform,
): boolean {
	const def = PERMISSION_MAP.get(id);
	return def ? def.platforms.includes(platform) : false;
}

import { logger } from "./logger";
import { getBrandConfig } from "./brand-config";
import type {
	AllPermissionsState,
	PermissionState,
	SystemPermissionId,
} from "./native/permissions-shared";

export const RUNTIME_PERMISSION_IDS = ["website-blocking", "location"] as const;

type RuntimePermissionId = (typeof RUNTIME_PERMISSION_IDS)[number];
type RuntimePermissionOperation = "check" | "request" | "open-settings";

function isPermissionState(value: unknown): value is PermissionState {
	return Boolean(
		value &&
			typeof value === "object" &&
			"id" in value &&
			typeof value.id === "string" &&
			"status" in value &&
			typeof value.status === "string" &&
			"lastChecked" in value &&
			typeof value.lastChecked === "number" &&
			"canRequest" in value &&
			typeof value.canRequest === "boolean",
	);
}

export function isRuntimePermissionId(id: string): id is RuntimePermissionId {
	return (RUNTIME_PERMISSION_IDS as readonly string[]).includes(id);
}

export function buildRuntimePermissionUnavailableState(
	permissionId: RuntimePermissionId,
	reason = `${getBrandConfig().appName} runtime is unavailable, so the ${permissionId} permission cannot be checked from desktop right now.`,
): PermissionState {
	return {
		id: permissionId,
		status: "denied",
		lastChecked: Date.now(),
		canRequest: false,
		reason,
	};
}

export async function fetchRuntimePermissionState(
	port: number | null | undefined,
	permissionId: RuntimePermissionId,
	operation: RuntimePermissionOperation = "check",
): Promise<PermissionState | null> {
	if (!port) {
		return null;
	}

	const pathname =
		operation === "check"
			? `/api/permissions/${permissionId}`
			: operation === "request"
				? `/api/permissions/${permissionId}/request`
				: `/api/permissions/${permissionId}/open-settings`;

	try {
		const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
			method: operation === "check" ? "GET" : "POST",
		});
		if (!response.ok) {
			logger.warn(
				`[Permissions] Runtime permission request failed for ${permissionId} (${operation}): ${response.status}`,
			);
			return null;
		}

		const payload = (await response.json()) as
			| PermissionState
			| { permission?: PermissionState };
		if (
			payload &&
			typeof payload === "object" &&
			"permission" in payload &&
			isPermissionState(payload.permission)
		) {
			return payload.permission;
		}
		if (isPermissionState(payload)) {
			return payload;
		}
	} catch (error) {
		logger.warn(
			`[Permissions] Failed to fetch runtime permission state for ${permissionId} (${operation}): ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}

	logger.warn(
		`[Permissions] Runtime permission endpoint returned an invalid payload for ${permissionId} (${operation})`,
	);
	return null;
}

export async function mergeRuntimePermissionStates(
	port: number | null | undefined,
	permissions: AllPermissionsState,
): Promise<AllPermissionsState> {
	const merged = { ...permissions } as AllPermissionsState;

	await Promise.all(
		RUNTIME_PERMISSION_IDS.map(async (permissionId) => {
			const runtimePermission = await fetchRuntimePermissionState(
				port,
				permissionId,
			);
			merged[permissionId] =
				runtimePermission ??
				buildRuntimePermissionUnavailableState(permissionId);
		}),
	);

	return merged;
}

export type {
	RuntimePermissionId,
	RuntimePermissionOperation,
	SystemPermissionId,
};

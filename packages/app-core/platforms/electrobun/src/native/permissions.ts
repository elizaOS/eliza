/**
 * Permission Manager for Electrobun
 *
 * Permission checking across macOS, Windows, and Linux.
 * Shared implementation ported forward to Electrobun; no runtime-specific APIs required.
 */

import { ALL_PROBERS } from "@elizaos/agent/services/permissions/probers/index";
import { getMacPermissionDeepLink } from "@elizaos/shared";
import type { SendToWebview } from "../types.js";
import type {
	AllPermissionsState,
	PermissionState,
	SystemPermissionId,
} from "./permissions-shared";
import {
	isPermissionApplicable,
	SYSTEM_PERMISSIONS,
} from "./permissions-shared";

const platform = process.platform as "darwin" | "win32" | "linux";
const DEFAULT_CACHE_TIMEOUT_MS = 30000;
const PROBERS_BY_ID = new Map(ALL_PROBERS.map((p) => [p.id, p]));

function buildPermissionState(
	id: SystemPermissionId,
	status: PermissionState["status"],
	options: Partial<Omit<PermissionState, "id" | "status">> = {},
): PermissionState {
	return {
		id,
		status,
		lastChecked: options.lastChecked ?? Date.now(),
		canRequest: options.canRequest ?? status === "not-determined",
		platform,
		...(options.restrictedReason
			? { restrictedReason: options.restrictedReason }
			: {}),
		...(options.lastRequested ? { lastRequested: options.lastRequested } : {}),
		...(options.lastBlockedFeature
			? { lastBlockedFeature: options.lastBlockedFeature }
			: {}),
		...(options.reason ? { reason: options.reason } : {}),
	};
}

async function spawnDetached(argv: string[]): Promise<void> {
	try {
		const proc = Bun.spawn(argv, {
			stdout: "ignore",
			stderr: "ignore",
		});
		if (typeof proc.unref === "function") proc.unref();
	} catch {
		// Opening settings is best-effort.
	}
}

async function openPermissionSettings(id: SystemPermissionId): Promise<void> {
	if (platform === "darwin") {
		await spawnDetached(["open", getMacPermissionDeepLink(id)]);
		return;
	}

	if (platform === "win32") {
		const settingsMap: Partial<Record<SystemPermissionId, string>> = {
			microphone: "ms-settings:privacy-microphone",
			camera: "ms-settings:privacy-webcam",
			location: "ms-settings:privacy-location",
			notifications: "ms-settings:notifications",
		};
		const uri = settingsMap[id];
		if (uri) await spawnDetached(["cmd", "/c", "start", "", uri]);
		return;
	}

	if (platform === "linux") {
		const settingsMap: Partial<Record<SystemPermissionId, string>> = {
			microphone: "privacy",
			camera: "privacy",
			location: "privacy",
			notifications: "notifications",
		};
		const panel = settingsMap[id];
		if (panel)
			await spawnDetached(["sh", "-lc", `gnome-control-center ${panel}`]);
	}
}

export class PermissionManager {
	private sendToWebview: SendToWebview | null = null;
	private cache: Map<SystemPermissionId, PermissionState> = new Map();
	private cacheTimeoutMs = DEFAULT_CACHE_TIMEOUT_MS;
	private shellEnabled = true;

	setSendToWebview(fn: SendToWebview): void {
		this.sendToWebview = fn;
	}

	setShellEnabled(enabled: boolean): void {
		this.shellEnabled = enabled;
		this.cache.delete("shell");
		this.sendToWebview?.("permissionsChanged", { id: "shell" });
	}

	isShellEnabled(): boolean {
		return this.shellEnabled;
	}

	private getFromCache(id: SystemPermissionId): PermissionState | null {
		const cached = this.cache.get(id);
		if (!cached) return null;
		if (Date.now() - cached.lastChecked >= this.cacheTimeoutMs) return null;
		return cached;
	}

	clearCache(): void {
		this.cache.clear();
	}

	async checkPermission(
		id: SystemPermissionId,
		forceRefresh = false,
	): Promise<PermissionState> {
		if (!isPermissionApplicable(id, platform)) {
			const state = buildPermissionState(id, "not-applicable", {
				canRequest: false,
				restrictedReason: "platform_unsupported",
			});
			this.cache.set(id, state);
			return state;
		}

		if (id === "shell" && !this.shellEnabled) {
			const state = buildPermissionState(id, "denied", {
				canRequest: false,
			});
			this.cache.set(id, state);
			return state;
		}

		if (!forceRefresh) {
			const cached = this.getFromCache(id);
			if (cached) return cached;
		}

		const prober = PROBERS_BY_ID.get(id);
		const state =
			prober !== undefined
				? await prober.check()
				: buildPermissionState(id, "not-applicable", {
						canRequest: false,
						restrictedReason: "platform_unsupported",
						reason: "No permission prober is registered for this permission.",
					});
		this.cache.set(id, state);
		return state;
	}

	async checkAllPermissions(
		forceRefresh = false,
	): Promise<AllPermissionsState> {
		const results = await Promise.all(
			SYSTEM_PERMISSIONS.map((p) => this.checkPermission(p.id, forceRefresh)),
		);
		return results.reduce((acc, state) => {
			acc[state.id] = state;
			return acc;
		}, {} as AllPermissionsState);
	}

	async requestPermission(id: SystemPermissionId): Promise<PermissionState> {
		if (!isPermissionApplicable(id, platform)) {
			return buildPermissionState(id, "not-applicable", {
				canRequest: false,
				restrictedReason: "platform_unsupported",
			});
		}

		if (id === "shell") {
			const state = buildPermissionState(
				id,
				this.shellEnabled ? "granted" : "denied",
				{
					canRequest: false,
					lastRequested: Date.now(),
				},
			);
			this.cache.set(id, state);
			return state;
		}

		const prober = PROBERS_BY_ID.get(id);
		const state =
			prober !== undefined
				? await prober.request({ reason: "Requested from desktop settings." })
				: buildPermissionState(id, "not-applicable", {
						canRequest: false,
						restrictedReason: "platform_unsupported",
						reason: "No permission prober is registered for this permission.",
					});
		this.cache.set(id, state);
		this.sendToWebview?.("permissionsChanged", { id });
		return state;
	}

	async openSettings(id: SystemPermissionId): Promise<void> {
		await openPermissionSettings(id);
	}

	async checkFeaturePermissions(
		featureId: string,
	): Promise<{ granted: boolean; missing: SystemPermissionId[] }> {
		const requiredPerms = SYSTEM_PERMISSIONS.filter((p) =>
			p.requiredForFeatures.includes(featureId),
		).map((p) => p.id);

		const states = await Promise.all(
			requiredPerms.map((id) => this.checkPermission(id)),
		);

		const missing = states
			.filter((s) => s.status !== "granted" && s.status !== "not-applicable")
			.map((s) => s.id);

		return { granted: missing.length === 0, missing };
	}

	dispose(): void {
		this.cache.clear();
		this.sendToWebview = null;
	}
}

let permissionManager: PermissionManager | null = null;

export function getPermissionManager(): PermissionManager {
	if (!permissionManager) {
		permissionManager = new PermissionManager();
	}
	return permissionManager;
}

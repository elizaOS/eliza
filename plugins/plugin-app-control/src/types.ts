/**
 * @module plugin-app-control/types
 * @description Strong types mirroring the Eliza dashboard `/api/apps/*`
 * response shapes. These intentionally re-declare the subset we consume so
 * this plugin stays decoupled from app package contract internals
 * import graph — matching responses are validated at the boundary.
 */

export interface InstalledAppInfo {
	name: string;
	displayName: string;
	pluginName: string;
	version: string;
	installedAt: string;
}

export interface AppRunSummary {
	runId: string;
	appName: string;
	displayName: string;
	pluginName: string;
	launchType: string;
	launchUrl: string | null;
	status: string;
	summary: string | null;
	startedAt: string;
	updatedAt: string;
	lastHeartbeatAt: string | null;
}

export interface AppLaunchResult {
	pluginInstalled: boolean;
	needsRestart: boolean;
	displayName: string;
	launchType: string;
	launchUrl: string | null;
	run: AppRunSummary | null;
}

export interface AppStopResult {
	success: boolean;
	appName: string;
	runId: string | null;
	stoppedAt: string;
	pluginUninstalled: boolean;
	needsRestart: boolean;
	stopScope: "plugin-uninstalled" | "viewer-session" | "no-op";
	message: string;
}

export interface AppControlErrorPayload {
	success?: boolean;
	message?: string;
	error?: string;
}

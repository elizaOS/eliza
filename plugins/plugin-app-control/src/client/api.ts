/**
 * @module plugin-app-control/client/api
 * @description HTTP client for the Eliza dashboard `/api/apps/*` routes.
 *
 * This plugin runs in the same process as the dashboard API. We talk to it
 * over loopback HTTP rather than reaching into the runtime service registry
 * so the plugin stays portable across the three shell variants (dev,
 * desktop, cloud). The server and port are discovered from the same
 * `resolveServerOnlyPort` helper that Eliza's other in-process actions
 * use.
 */

import { resolveServerOnlyPort } from "@elizaos/core";
import type {
	AppControlErrorPayload,
	AppLaunchResult,
	AppRunSummary,
	AppStopResult,
	InstalledAppInfo,
} from "../types.js";

const REQUEST_TIMEOUT_MS = 30_000;

export interface AppControlClient {
	listInstalledApps(): Promise<InstalledAppInfo[]>;
	listAppRuns(): Promise<AppRunSummary[]>;
	launchApp(name: string): Promise<AppLaunchResult>;
	stopAppRun(runId: string): Promise<AppStopResult>;
	stopAppByName(name: string): Promise<AppStopResult>;
}

function getApiBase(): string {
	const port = resolveServerOnlyPort(process.env);
	return `http://127.0.0.1:${port}`;
}

function isArrayOfObjects(value: unknown): value is Record<string, unknown>[] {
	return (
		Array.isArray(value) &&
		value.every((v) => v !== null && typeof v === "object")
	);
}

function extractErrorMessage(
	status: number,
	body: unknown,
	fallback: string,
): string {
	if (body && typeof body === "object") {
		const payload = body as AppControlErrorPayload;
		if (typeof payload.message === "string" && payload.message.trim()) {
			return payload.message.trim();
		}
		if (typeof payload.error === "string" && payload.error.trim()) {
			return payload.error.trim();
		}
	}
	return `${fallback} (${status})`;
}

async function requestJson<T>(
	path: string,
	init: RequestInit,
	parse: (body: unknown) => T,
	errorContext: string,
): Promise<T> {
	const url = `${getApiBase()}${path}`;
	const response = await fetch(url, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	const rawText = await response.text();
	let body: unknown = null;
	if (rawText.length > 0) {
		body = JSON.parse(rawText) as unknown;
	}

	if (!response.ok) {
		throw new Error(extractErrorMessage(response.status, body, errorContext));
	}

	// The server sometimes returns { success: false } with a 200 status (e.g.
	// app not found). Surface those as explicit errors instead of trying to
	// parse them into a typed result.
	if (
		body &&
		typeof body === "object" &&
		(body as AppControlErrorPayload).success === false
	) {
		throw new Error(extractErrorMessage(response.status, body, errorContext));
	}

	return parse(body);
}

function parseInstalledApps(body: unknown): InstalledAppInfo[] {
	if (!isArrayOfObjects(body)) {
		throw new Error("Malformed /api/apps/installed response: expected array");
	}
	return body.map((entry) => {
		const name = entry.name;
		const displayName = entry.displayName;
		const pluginName = entry.pluginName;
		const version = entry.version;
		const installedAt = entry.installedAt;
		if (
			typeof name !== "string" ||
			typeof displayName !== "string" ||
			typeof pluginName !== "string" ||
			typeof version !== "string" ||
			typeof installedAt !== "string"
		) {
			throw new Error(
				"Malformed installed app entry: missing required string fields",
			);
		}
		return { name, displayName, pluginName, version, installedAt };
	});
}

function parseAppRunSummary(entry: Record<string, unknown>): AppRunSummary {
	const runId = entry.runId;
	const appName = entry.appName;
	const displayName = entry.displayName;
	const pluginName = entry.pluginName;
	const launchType = entry.launchType;
	const status = entry.status;
	const startedAt = entry.startedAt;
	const updatedAt = entry.updatedAt;
	if (
		typeof runId !== "string" ||
		typeof appName !== "string" ||
		typeof displayName !== "string" ||
		typeof pluginName !== "string" ||
		typeof launchType !== "string" ||
		typeof status !== "string" ||
		typeof startedAt !== "string" ||
		typeof updatedAt !== "string"
	) {
		throw new Error(
			"Malformed app run summary: missing required string fields",
		);
	}
	const launchUrl = entry.launchUrl;
	const summary = entry.summary;
	const lastHeartbeatAt = entry.lastHeartbeatAt;
	return {
		runId,
		appName,
		displayName,
		pluginName,
		launchType,
		launchUrl: typeof launchUrl === "string" ? launchUrl : null,
		status,
		summary: typeof summary === "string" ? summary : null,
		startedAt,
		updatedAt,
		lastHeartbeatAt:
			typeof lastHeartbeatAt === "string" ? lastHeartbeatAt : null,
	};
}

function parseAppRuns(body: unknown): AppRunSummary[] {
	if (!isArrayOfObjects(body)) {
		throw new Error("Malformed /api/apps/runs response: expected array");
	}
	return body.map(parseAppRunSummary);
}

function parseLaunchResult(body: unknown): AppLaunchResult {
	if (!body || typeof body !== "object") {
		throw new Error("Malformed /api/apps/launch response: expected object");
	}
	const entry = body as Record<string, unknown>;
	const displayName = entry.displayName;
	const launchType = entry.launchType;
	if (typeof displayName !== "string" || typeof launchType !== "string") {
		throw new Error(
			"Malformed launch result: missing displayName or launchType",
		);
	}
	const launchUrl = entry.launchUrl;
	const run =
		entry.run && typeof entry.run === "object"
			? parseAppRunSummary(entry.run as Record<string, unknown>)
			: null;
	return {
		pluginInstalled: Boolean(entry.pluginInstalled),
		needsRestart: Boolean(entry.needsRestart),
		displayName,
		launchType,
		launchUrl: typeof launchUrl === "string" ? launchUrl : null,
		run,
	};
}

function parseStopResult(body: unknown): AppStopResult {
	if (!body || typeof body !== "object") {
		throw new Error("Malformed stop-app response: expected object");
	}
	const entry = body as Record<string, unknown>;
	const appName = entry.appName;
	const stoppedAt = entry.stoppedAt;
	const stopScope = entry.stopScope;
	const message = entry.message;
	if (
		typeof appName !== "string" ||
		typeof stoppedAt !== "string" ||
		typeof message !== "string"
	) {
		throw new Error("Malformed stop result: missing required string fields");
	}
	if (
		stopScope !== "plugin-uninstalled" &&
		stopScope !== "viewer-session" &&
		stopScope !== "no-op"
	) {
		throw new Error(`Malformed stop result: unexpected stopScope ${stopScope}`);
	}
	const runId = entry.runId;
	return {
		success: entry.success !== false,
		appName,
		runId: typeof runId === "string" ? runId : null,
		stoppedAt,
		pluginUninstalled: Boolean(entry.pluginUninstalled),
		needsRestart: Boolean(entry.needsRestart),
		stopScope,
		message,
	};
}

export function createAppControlClient(): AppControlClient {
	return {
		async listInstalledApps() {
			return requestJson(
				"/api/apps/installed",
				{ method: "GET" },
				parseInstalledApps,
				"Failed to list installed apps",
			);
		},

		async listAppRuns() {
			return requestJson(
				"/api/apps/runs",
				{ method: "GET" },
				parseAppRuns,
				"Failed to list running apps",
			);
		},

		async launchApp(name: string) {
			return requestJson(
				"/api/apps/launch",
				{
					method: "POST",
					body: JSON.stringify({ name }),
				},
				parseLaunchResult,
				`Failed to launch app ${name}`,
			);
		},

		async stopAppRun(runId: string) {
			return requestJson(
				`/api/apps/runs/${encodeURIComponent(runId)}/stop`,
				{ method: "POST" },
				parseStopResult,
				`Failed to stop app run ${runId}`,
			);
		},

		async stopAppByName(name: string) {
			return requestJson(
				"/api/apps/stop",
				{
					method: "POST",
					body: JSON.stringify({ name }),
				},
				parseStopResult,
				`Failed to stop app ${name}`,
			);
		},
	};
}

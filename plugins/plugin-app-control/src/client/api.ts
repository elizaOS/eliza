/**
 * Loopback HTTP client for the dashboard app-control routes.
 *
 * The HTTP boundary keeps this plugin portable across dev, desktop, and cloud
 * shells. Each operation owns a deadline matching its workload, while a
 * caller-supplied abort signal can cancel it with the surrounding turn.
 */

import { resolveServerOnlyPort } from "@elizaos/core";
import { createViewsRequestHeaders } from "../actions/views-request-auth.js";
import type {
	AppControlErrorPayload,
	AppLaunchResult,
	AppRunSummary,
	AppStopResult,
	InstalledAppInfo,
} from "../types.js";

// The installed-apps route can run a cold app/plugin registry discovery scan
// (filesystem walk) that legitimately exceeds 2s on slower hosts; a read
// deadline below the route's real workload guarantees TimeoutError on every
// cold list. 10s bounds the read without starving the scan.
const LOOPBACK_READ_DEADLINE_MS = 10_000;
const LOOPBACK_STOP_DEADLINE_MS = 10_000;
const APP_LAUNCH_DEADLINE_MS = 120_000;

export interface AppControlClient {
	listInstalledApps(signal?: AbortSignal): Promise<InstalledAppInfo[]>;
	listAppRuns(signal?: AbortSignal): Promise<AppRunSummary[]>;
	launchApp(name: string, signal?: AbortSignal): Promise<AppLaunchResult>;
	stopApp(name: string, signal?: AbortSignal): Promise<AppStopResult>;
	stopAppRun(runId: string, signal?: AbortSignal): Promise<AppStopResult>;
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
	deadlineMs: number,
	acceptExplicitFailure = false,
): Promise<T> {
	const url = `${getApiBase()}${path}`;
	const deadlineSignal = AbortSignal.timeout(deadlineMs);
	const callerSignal = init.signal;
	const response = await fetch(url, {
		...init,
		headers: {
			...createViewsRequestHeaders(),
			...(init.headers ?? {}),
		},
		signal: callerSignal
			? AbortSignal.any([callerSignal, deadlineSignal])
			: deadlineSignal,
	});

	const rawText = await response.text();
	let body: unknown = null;
	if (rawText.length > 0) {
		try {
			body = JSON.parse(rawText);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Invalid JSON response from ${path} for ${errorContext}: ${detail}`,
			);
		}
	}

	if (!response.ok) {
		throw new Error(extractErrorMessage(response.status, body, errorContext));
	}

	// A small number of mutation routes use HTTP 200 for a typed no-op result.
	// Only callers with a parser for that explicit failure shape may opt in.
	if (
		!acceptExplicitFailure &&
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
	const success = entry.success;
	const pluginUninstalled = entry.pluginUninstalled;
	const needsRestart = entry.needsRestart;
	const runId = entry.runId;
	if (
		typeof appName !== "string" ||
		typeof stoppedAt !== "string" ||
		typeof message !== "string" ||
		typeof success !== "boolean" ||
		typeof pluginUninstalled !== "boolean" ||
		typeof needsRestart !== "boolean" ||
		(runId !== null && typeof runId !== "string")
	) {
		throw new Error("Malformed stop result: missing required fields");
	}
	if (
		stopScope !== "plugin-uninstalled" &&
		stopScope !== "viewer-session" &&
		stopScope !== "nothing-stopped"
	) {
		throw new Error(`Malformed stop result: unexpected stopScope ${stopScope}`);
	}
	return {
		success,
		appName,
		runId,
		stoppedAt,
		pluginUninstalled,
		needsRestart,
		stopScope,
		message,
	};
}

export function createAppControlClient(): AppControlClient {
	return {
		async listInstalledApps(signal?: AbortSignal) {
			return requestJson(
				"/api/apps/installed",
				{ method: "GET", signal },
				parseInstalledApps,
				"Failed to list installed apps",
				LOOPBACK_READ_DEADLINE_MS,
			);
		},

		async listAppRuns(signal?: AbortSignal) {
			return requestJson(
				"/api/apps/runs",
				{ method: "GET", signal },
				parseAppRuns,
				"Failed to list running apps",
				LOOPBACK_READ_DEADLINE_MS,
			);
		},

		async launchApp(name: string, signal?: AbortSignal) {
			return requestJson(
				"/api/apps/launch",
				{
					method: "POST",
					body: JSON.stringify({ name }),
					signal,
				},
				parseLaunchResult,
				`Failed to launch app ${name}`,
				APP_LAUNCH_DEADLINE_MS,
			);
		},

		async stopApp(name: string, signal?: AbortSignal) {
			return requestJson(
				"/api/apps/stop",
				{
					method: "POST",
					body: JSON.stringify({ name }),
					signal,
				},
				parseStopResult,
				`Failed to stop app ${name}`,
				LOOPBACK_STOP_DEADLINE_MS,
				true,
			);
		},

		async stopAppRun(runId: string, signal?: AbortSignal) {
			return requestJson(
				`/api/apps/runs/${encodeURIComponent(runId)}/stop`,
				{ method: "POST", signal },
				parseStopResult,
				`Failed to stop app run ${runId}`,
				LOOPBACK_STOP_DEADLINE_MS,
				true,
			);
		},
	};
}

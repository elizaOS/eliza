/**
 * Pins the APP list contract at the loopback boundary: loopback transport
 * failures (deadline timeout, unreachable server) become typed failures that
 * own their user-facing prose — so planner-loop failure authority surfaces
 * this tool's message instead of the generic failed-tool fallback — while
 * caller aborts and malformed payloads still fail fast.
 */

import { describe, expect, it, vi } from "vitest";
import type { AppControlClient } from "../client/api.js";
import type { AppRunSummary, InstalledAppInfo } from "../types.js";
import { runList } from "./app-list.js";

function clientWith(overrides: Partial<AppControlClient>): AppControlClient {
	return {
		listInstalledApps: async () => [],
		listAppRuns: async () => [],
		launchApp: vi.fn(),
		stopApp: vi.fn(),
		stopAppRun: vi.fn(),
		...overrides,
	};
}

const installedApp: InstalledAppInfo = {
	name: "chess",
	displayName: "Chess",
	pluginName: "@test/chess",
	version: "1.0.0",
	installedAt: "2026-07-31T00:00:00.000Z",
};

const chessRun: AppRunSummary = {
	runId: "run-1",
	appName: "chess",
	displayName: "Chess",
	pluginName: "@test/chess",
	launchType: "view",
	launchUrl: null,
	status: "running",
	summary: null,
	startedAt: "2026-07-31T00:00:00.000Z",
	updatedAt: "2026-07-31T00:00:00.000Z",
	lastHeartbeatAt: null,
};

describe("APP list transport-failure translation", () => {
	it("returns a typed failure owning user-facing prose when the read deadline elapses", async () => {
		const client = clientWith({
			listInstalledApps: async () => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			},
		});

		const result = await runList({ client });

		expect(result.success).toBe(false);
		expect(result.userFacingText).toContain("Couldn't read the app list");
		expect(result.text).toContain("Do not call APP again this turn");
		expect(result.data).toEqual(
			expect.objectContaining({
				actionName: "APP",
				mode: "list",
				error: "LOOPBACK_TIMEOUT",
			}),
		);
	});

	it("returns a typed unreachable failure when fetch cannot connect", async () => {
		const client = clientWith({
			listAppRuns: async () => {
				throw new TypeError("fetch failed");
			},
		});

		const result = await runList({ client });

		expect(result.success).toBe(false);
		expect(result.userFacingText).toContain("isn't reachable");
		expect(result.data).toEqual(
			expect.objectContaining({ error: "LOOPBACK_UNREACHABLE" }),
		);
	});

	it("still fails fast on caller cancellation so turn teardown stays observable", async () => {
		const client = clientWith({
			listInstalledApps: async () => {
				throw new DOMException("turn cancelled", "AbortError");
			},
		});

		await expect(runList({ client })).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("still fails fast on malformed payloads instead of fabricating a failure result", async () => {
		const client = clientWith({
			listInstalledApps: async () => {
				throw new Error(
					"Malformed /api/apps/installed response: expected array",
				);
			},
		});

		await expect(runList({ client })).rejects.toThrow(
			"Malformed /api/apps/installed response",
		);
	});

	it("returns the structured table on the happy path", async () => {
		const client = clientWith({
			listInstalledApps: async () => [installedApp],
			listAppRuns: async () => [chessRun],
		});

		const result = await runList({ client });

		expect(result.success).toBe(true);
		expect(result.text).toContain("installedCount: 1");
		expect(result.text).toContain("chess,Chess,run-1");
		expect(result.values).toEqual(
			expect.objectContaining({
				mode: "list",
				installedCount: 1,
				runningCount: 1,
			}),
		);
	});
});

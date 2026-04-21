/**
 * @module plugin-app-control/actions/close-app.test
 */

import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { AppControlClient } from "../client/api.js";
import type { AppRunSummary, AppStopResult } from "../types.js";
import { createCloseAppAction } from "./close-app.js";

function makeRun(overrides: Partial<AppRunSummary> = {}): AppRunSummary {
	return {
		runId: "run_abc",
		appName: "@elizaos/app-companion",
		displayName: "Companion",
		pluginName: "@elizaos/app-companion",
		launchType: "viewer",
		launchUrl: null,
		status: "active",
		summary: null,
		startedAt: "2026-04-21T00:00:00.000Z",
		updatedAt: "2026-04-21T00:00:00.000Z",
		lastHeartbeatAt: null,
		...overrides,
	};
}

function makeStopResult(overrides: Partial<AppStopResult> = {}): AppStopResult {
	return {
		success: true,
		appName: "@elizaos/app-companion",
		runId: "run_abc",
		stoppedAt: "2026-04-21T00:00:10.000Z",
		pluginUninstalled: false,
		needsRestart: false,
		stopScope: "viewer-session",
		message: "Companion stopped.",
		...overrides,
	};
}

function stubRuntime(): IAgentRuntime {
	return {} as IAgentRuntime;
}

function stubMessage(text: string): Memory {
	return { content: { text } } as unknown as Memory;
}

function stubClient(partial: Partial<AppControlClient>): AppControlClient {
	return {
		listInstalledApps: vi.fn(async () => []),
		listAppRuns: vi.fn(async () => []),
		launchApp: vi.fn(async () => {
			throw new Error("launchApp not stubbed");
		}),
		stopAppRun: vi.fn(async () => makeStopResult()),
		stopAppByName: vi.fn(async () => makeStopResult()),
		...partial,
	};
}

function makeCallback(): HandlerCallback & {
	mock: ReturnType<typeof vi.fn>["mock"];
} {
	return vi.fn(async () => []) as unknown as HandlerCallback & {
		mock: ReturnType<typeof vi.fn>["mock"];
	};
}

function expectResult(result: ActionResult | undefined): ActionResult {
	if (!result) {
		throw new Error("Action handler returned undefined");
	}
	return result;
}

describe("CLOSE_APP action", () => {
	it("stops the run resolved from the app name", async () => {
		const client = stubClient({
			listAppRuns: vi.fn(async () => [makeRun()]),
			stopAppRun: vi.fn(async () => makeStopResult()),
		});
		const action = createCloseAppAction({ client });
		const callback = makeCallback();

		const result = expectResult(
			await action.handler(
				stubRuntime(),
				stubMessage("close companion"),
				undefined,
				undefined,
				callback,
			),
		);

		expect(client.stopAppRun).toHaveBeenCalledWith("run_abc");
		expect(result.success).toBe(true);
		expect(result.values?.stopScope).toBe("viewer-session");
		expect(String(callback.mock.calls[0][0].text)).toContain(
			"Companion stopped",
		);
	});

	it("returns an ambiguous-match error when multiple runs match the name", async () => {
		// Both runs contain "music" as a substring but neither is an exact
		// match on any of their name/displayName/pluginName fields, so the
		// resolver falls through to substring match and reports ambiguity.
		const client = stubClient({
			listAppRuns: vi.fn(async () => [
				makeRun({
					runId: "run_a",
					appName: "@elizaos/plugin-music-library",
					displayName: "Music Library",
					pluginName: "@elizaos/plugin-music-library",
				}),
				makeRun({
					runId: "run_b",
					appName: "@elizaos/plugin-music-player",
					displayName: "Music Player",
					pluginName: "@elizaos/plugin-music-player",
				}),
			]),
			stopAppRun: vi.fn(async () => {
				throw new Error("should not stop on ambiguous");
			}),
		});
		const action = createCloseAppAction({ client });
		const callback = makeCallback();

		const result = expectResult(
			await action.handler(
				stubRuntime(),
				stubMessage("close music"),
				undefined,
				undefined,
				callback,
			),
		);

		expect(result.success).toBe(false);
		expect(client.stopAppRun).not.toHaveBeenCalled();
		const text = String(callback.mock.calls[0][0].text);
		expect(text).toContain("matches multiple running apps");
		expect(text).toContain("run_a");
		expect(text).toContain("run_b");
	});

	it("stops by explicit runId without consulting the run list", async () => {
		const listAppRuns = vi.fn(async () => [] as AppRunSummary[]);
		const client = stubClient({
			listAppRuns,
			stopAppRun: vi.fn(async () =>
				makeStopResult({ runId: "run_explicit", message: "Bye." }),
			),
		});
		const action = createCloseAppAction({ client });
		const callback = makeCallback();

		const result = expectResult(
			await action.handler(
				stubRuntime(),
				stubMessage("close this"),
				undefined,
				{ runId: "run_explicit" },
				callback,
			),
		);

		expect(listAppRuns).not.toHaveBeenCalled();
		expect(client.stopAppRun).toHaveBeenCalledWith("run_explicit");
		expect(result.success).toBe(true);
		expect(String(callback.mock.calls[0][0].text)).toContain("Bye.");
	});

	it("propagates a runtime error from stopAppRun", async () => {
		const client = stubClient({
			listAppRuns: vi.fn(async () => [makeRun()]),
			stopAppRun: vi.fn(async () => {
				throw new Error("run already stopped");
			}),
		});
		const action = createCloseAppAction({ client });

		await expect(
			action.handler(
				stubRuntime(),
				stubMessage("close companion"),
				undefined,
				undefined,
			),
		).rejects.toThrow("run already stopped");
	});
});

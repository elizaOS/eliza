/**
 * @module plugin-app-control/actions/launch-app.test
 */

import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { AppControlClient } from "../client/api.js";
import type {
	AppLaunchResult,
	AppRunSummary,
	InstalledAppInfo,
} from "../types.js";
import { createLaunchAppAction } from "./launch-app.js";

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

function makeInstalled(
	overrides: Partial<InstalledAppInfo> = {},
): InstalledAppInfo {
	return {
		name: "@elizaos/app-companion",
		displayName: "Companion",
		pluginName: "@elizaos/app-companion",
		version: "1.0.0",
		installedAt: "2026-04-20T00:00:00.000Z",
		...overrides,
	};
}

function makeLaunchResult(
	overrides: Partial<AppLaunchResult> = {},
): AppLaunchResult {
	return {
		pluginInstalled: true,
		needsRestart: false,
		displayName: "Companion",
		launchType: "viewer",
		launchUrl: null,
		run: makeRun(),
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
		launchApp: vi.fn(async () => makeLaunchResult()),
		stopAppRun: vi.fn(async () => {
			throw new Error("stopAppRun not stubbed");
		}),
		stopAppByName: vi.fn(async () => {
			throw new Error("stopAppByName not stubbed");
		}),
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

describe("LAUNCH_APP action", () => {
	it("launches a resolved app and returns the new runId", async () => {
		const client = stubClient({
			listInstalledApps: vi.fn(async () => [
				makeInstalled({
					name: "@elizaos/app-companion",
					displayName: "Companion",
				}),
			]),
			launchApp: vi.fn(async () => makeLaunchResult()),
		});
		const action = createLaunchAppAction({ client });
		const callback = makeCallback();

		const result = expectResult(
			await action.handler(
				stubRuntime(),
				stubMessage("launch the companion app"),
				undefined,
				undefined,
				callback,
			),
		);

		expect(client.launchApp).toHaveBeenCalledWith("@elizaos/app-companion");
		expect(result.success).toBe(true);
		expect(result.values?.runId).toBe("run_abc");
		expect(callback.mock.calls).toHaveLength(1);
		expect(String(callback.mock.calls[0][0].text)).toContain(
			"Launched Companion",
		);
	});

	it("returns an error listing candidates when the name is ambiguous", async () => {
		// Both apps contain "music" as a substring but neither is an exact match
		// on any of their name/displayName/pluginName fields, so the resolver
		// falls through to substring match and reports ambiguity.
		const client = stubClient({
			listInstalledApps: vi.fn(async () => [
				makeInstalled({
					name: "@elizaos/plugin-music-library",
					displayName: "Music Library",
					pluginName: "@elizaos/plugin-music-library",
				}),
				makeInstalled({
					name: "@elizaos/plugin-music-player",
					displayName: "Music Player",
					pluginName: "@elizaos/plugin-music-player",
				}),
			]),
			launchApp: vi.fn(async () => {
				throw new Error("should not be called when ambiguous");
			}),
		});
		const action = createLaunchAppAction({ client });
		const callback = makeCallback();

		const result = expectResult(
			await action.handler(
				stubRuntime(),
				stubMessage("launch music"),
				undefined,
				undefined,
				callback,
			),
		);

		expect(result.success).toBe(false);
		expect(client.launchApp).not.toHaveBeenCalled();
		const text = String(callback.mock.calls[0][0].text);
		expect(text).toContain("matches multiple apps");
		expect(text).toContain("Music Library");
		expect(text).toContain("Music Player");
	});

	it("propagates a runtime error from the launch endpoint", async () => {
		const client = stubClient({
			listInstalledApps: vi.fn(async () => [
				makeInstalled({ name: "shopify", displayName: "Shopify" }),
			]),
			launchApp: vi.fn(async () => {
				throw new Error("plugin install failed");
			}),
		});
		const action = createLaunchAppAction({ client });
		const callback = makeCallback();

		await expect(
			action.handler(
				stubRuntime(),
				stubMessage("launch shopify"),
				undefined,
				undefined,
				callback,
			),
		).rejects.toThrow("plugin install failed");
	});

	it("uses options.app over message-extracted target", async () => {
		const client = stubClient({
			listInstalledApps: vi.fn(async () => [
				makeInstalled({ name: "vincent", displayName: "Vincent" }),
			]),
			launchApp: vi.fn(async () =>
				makeLaunchResult({ displayName: "Vincent" }),
			),
		});
		const action = createLaunchAppAction({ client });

		const result = expectResult(
			await action.handler(
				stubRuntime(),
				stubMessage("launch shopify"),
				undefined,
				{ app: "vincent" },
			),
		);

		expect(client.launchApp).toHaveBeenCalledWith("vincent");
		expect(result.success).toBe(true);
	});
});

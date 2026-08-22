import type { HandlerCallback, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { AppControlClient } from "../client/api.js";
import { runLaunch } from "./app-launch.js";

function client(): AppControlClient {
	return {
		listInstalledApps: vi.fn(async () => [
			{
				name: "nubs-color-pebble",
				displayName: "Nubs Color Pebble",
				pluginName: "nubs-color-pebble",
				version: "1.0.0",
				installedAt: "2026-08-21T00:00:00.000Z",
			},
		]),
		listAppRuns: vi.fn(),
		launchApp: vi.fn(async () => ({
			pluginInstalled: true,
			needsRestart: false,
			displayName: "Nubs Color Pebble",
			launchType: "local",
			launchUrl: "/api/apps/local/nubs-color-pebble/",
			run: {
				runId: "internal-run-id",
				appName: "nubs-color-pebble",
				displayName: "Nubs Color Pebble",
				pluginName: "nubs-color-pebble",
				launchType: "local",
				launchUrl: "/api/apps/local/nubs-color-pebble/",
				status: "running",
				summary: null,
				startedAt: "2026-08-21T00:00:00.000Z",
				updatedAt: "2026-08-21T00:00:00.000Z",
				lastHeartbeatAt: null,
			},
		})),
		stopApp: vi.fn(),
		stopAppRun: vi.fn(),
	};
}

const message = {
	content: {
		text: "open nubs color pebble",
		metadata: { viewClientId: "chat-client-1" },
	},
} as Memory;

describe("APP launch Browser handoff", () => {
	it("opens the launch URL in Browser and keeps the run id internal", async () => {
		const callback = vi.fn<HandlerCallback>();
		const openBrowserView = vi.fn(async () => ({
			path: "/browser?browse=app",
			status: "delivered" as const,
			completedActionDelivered: true,
			completedActionHandoffId: "handoff-1",
		}));

		const result = await runLaunch({
			client: client(),
			message,
			callback,
			openBrowserView,
		});

		expect(openBrowserView).toHaveBeenCalledWith(
			"/api/apps/local/nubs-color-pebble/",
			{ originatingClientId: "chat-client-1", realtimeVoice: false },
		);
		expect(result.text).toBe('{"effect":"app_launch","status":"completed"}');
		expect(result.transcriptVisibility).toBe("internal");
		expect(result.modelReplyRequired).toBe(true);
		expect(result.userFacingText).toBeUndefined();
		expect(result.verifiedUserFacing).toBeUndefined();
		expect(result.turnComplete).toBeUndefined();
		expect(result.promptData).toEqual({
			operation: "launch_app",
			outcome: "success",
			appName: "nubs-color-pebble",
			displayName: "Nubs Color Pebble",
			openedInBrowser: true,
			browserNavigationStatus: "delivered",
			link: {
				label: "Open Nubs Color Pebble",
				href: "/api/apps/local/nubs-color-pebble/",
			},
		});
		expect(result.values).toMatchObject({
			openedInBrowser: true,
			runId: "internal-run-id",
			viewId: "browser",
			viewPath: "/browser?browse=app",
			completedActionHandoffId: "handoff-1",
		});
		expect(callback).not.toHaveBeenCalled();
	});

	it("keeps the app link in the model receipt when Browser navigation is unavailable", async () => {
		const result = await runLaunch({
			client: client(),
			message,
			openBrowserView: vi.fn(async () => ({
				path: "/browser?browse=app",
				status: "unavailable" as const,
				completedActionDelivered: false,
				errorCode: "RENDERER_UNAVAILABLE" as const,
			})),
		});

		expect(result.modelReplyRequired).toBe(true);
		expect(result.userFacingText).toBeUndefined();
		expect(result.promptData).toMatchObject({
			operation: "launch_app",
			outcome: "success",
			openedInBrowser: false,
			browserNavigationStatus: "unavailable",
			browserNavigationError: "RENDERER_UNAVAILABLE",
			link: {
				label: "Open Nubs Color Pebble",
				href: "/api/apps/local/nubs-color-pebble/",
			},
		});
	});
});

import type { HandlerCallback, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { AppControlClient } from "../client/api.js";
import { runLaunch } from "./app-launch.js";

function client(
	launchUrl = "/api/apps/local/nubs-color-pebble/",
): AppControlClient {
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
			launchUrl,
			run: {
				runId: "internal-run-id",
				appName: "nubs-color-pebble",
				displayName: "Nubs Color Pebble",
				pluginName: "nubs-color-pebble",
				launchType: "local",
				launchUrl,
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
	content: { text: "open nubs color pebble" },
} as Memory;

describe("APP launch Browser handoff", () => {
	it("opens the launch URL in Browser and keeps the run id internal", async () => {
		const callback = vi.fn<HandlerCallback>();
		const openBrowserView = vi.fn(async () => ({
			status: "renderer-delivered" as const,
			openedInBrowser: true,
			safeLaunchUrl: "/api/apps/local/nubs-color-pebble/",
			safeMarkdownLaunchUrl: "/api/apps/local/nubs-color-pebble/",
			viewPath: "/browser?browse=local",
			completedActionDelivered: true as const,
			completedActionHandoffId: "handoff-app",
		}));

		const result = await runLaunch({
			client: client(),
			message,
			callback,
			openBrowserView,
		});

		expect(openBrowserView).toHaveBeenCalledWith(
			"/api/apps/local/nubs-color-pebble/",
			message,
		);
		expect(result.text).toBe('{"effect":"app_launch","status":"completed"}');
		expect(result.transcriptVisibility).toBe("internal");
		expect(result.modelReplyRequired).toBe(true);
		expect(result.userFacingText).toBeUndefined();
		expect(result.modelReplyFallback).toBe(
			"The app launched successfully. [Open the app](/api/apps/local/nubs-color-pebble/)",
		);
		expect(result.verifiedUserFacing).toBeUndefined();
		expect(result.turnComplete).toBeUndefined();
		expect(result.promptData).toEqual({
			operation: "launch_app",
			outcome: "success",
			appName: "nubs-color-pebble",
			displayName: "Nubs Color Pebble",
			openedInBrowser: true,
			browserNavigationStatus: "renderer-delivered",
			link: {
				label: "Open Nubs Color Pebble",
				href: "/api/apps/local/nubs-color-pebble/",
			},
		});
		expect(result.values).toMatchObject({
			openedInBrowser: true,
			runId: "internal-run-id",
			viewId: "browser",
			viewPath: "/browser?browse=local",
			completedActionDelivered: true,
			completedActionHandoffId: "handoff-app",
		});
		expect(callback).not.toHaveBeenCalled();
	});

	it("keeps the app link in the model receipt when Browser navigation is unavailable", async () => {
		const result = await runLaunch({
			client: client(),
			message,
			openBrowserView: vi.fn(async () => ({
				status: "terminal-fallback" as const,
				openedInBrowser: false,
				safeLaunchUrl: "/api/apps/local/nubs-color-pebble/",
				safeMarkdownLaunchUrl: "/api/apps/local/nubs-color-pebble/",
				viewPath: "/browser?browse=local",
				completedActionHandoffId: "handoff-fallback",
			})),
		});

		expect(result.modelReplyRequired).toBe(true);
		expect(result.modelReplyFallback).toContain(
			"The app launched successfully.",
		);
		expect(result.promptData).toMatchObject({
			operation: "launch_app",
			outcome: "success",
			openedInBrowser: false,
			link: {
				label: "Open Nubs Color Pebble",
				href: "/api/apps/local/nubs-color-pebble/",
			},
		});
		expect(result.values).toMatchObject({
			browserNavigationStatus: "terminal-fallback",
			viewId: "browser",
			viewPath: "/browser?browse=local",
			completedActionHandoffId: "handoff-fallback",
		});
	});

	it.each(["javascript:alert(1)", "data:text/html,unsafe", "http://["])(
		"never exposes an unsafe launch URL to model-bound prompt data: %s",
		async (launchUrl) => {
			const result = await runLaunch({ client: client(launchUrl), message });

			expect(result.success).toBe(true);
			expect(result.values).toMatchObject({
				browserNavigationStatus: "invalid-url",
				openedInBrowser: false,
			});
			expect(result.promptData).not.toHaveProperty("link");
			expect(result.modelReplyFallback).toBe("The app launched successfully.");
			expect(JSON.stringify(result.promptData)).not.toContain(launchUrl);
			expect(result.modelReplyFallback).not.toContain(launchUrl);
		},
	);

	it("escapes a valid http URL before placing it in Markdown", async () => {
		const launchUrl = "https://e.test/)%20[evil](javascript:alert(1))";
		const result = await runLaunch({ client: client(launchUrl), message });
		const href = (result.promptData?.link as { href?: string } | undefined)
			?.href;

		expect(href).toContain("%29");
		expect(href).toContain("%28");
		expect(href).not.toContain("](javascript:");
		expect(result.modelReplyFallback).toContain(href);
	});
});

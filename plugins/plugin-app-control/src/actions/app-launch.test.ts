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
	content: { text: "open nubs color pebble" },
} as Memory;

describe("APP launch Browser handoff", () => {
	it("opens the launch URL in Browser and keeps the run id internal", async () => {
		const callback = vi.fn<HandlerCallback>();
		const openBrowserView = vi.fn(async () => true);

		const result = await runLaunch({
			client: client(),
			message,
			callback,
			openBrowserView,
		});

		expect(openBrowserView).toHaveBeenCalledWith(
			"/api/apps/local/nubs-color-pebble/",
		);
		expect(result.userFacingText).toBe(
			"[Open Nubs Color Pebble](/api/apps/local/nubs-color-pebble/)",
		);
		expect(result.userFacingText).not.toContain("internal-run-id");
		expect(result.values).toMatchObject({
			openedInBrowser: true,
			runId: "internal-run-id",
		});
		expect(callback).toHaveBeenCalledWith({ text: result.userFacingText });
	});

	it("returns a clean fallback link when Browser navigation is unavailable", async () => {
		const result = await runLaunch({
			client: client(),
			message,
			openBrowserView: vi.fn(async () => false),
		});

		expect(result.userFacingText).toBe(
			"[Open Nubs Color Pebble](/api/apps/local/nubs-color-pebble/)",
		);
		expect(result.userFacingText).not.toContain("Run ID");
	});
});

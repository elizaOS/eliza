/**
 * Behavioral contract for the APP/relaunch action (plugin-app-control).
 *
 * Relaunch chains two state-changing calls: stop existing runs, then launch
 * the app. The resolution gate is the safety property — an ambiguous target
 * must never reach `launchApp`, and a failed stop of a previous run must not
 * abort the relaunch (failure is contained to a warning). The verify:true
 * path additionally surfaces a failed post-launch verification to the caller
 * instead of reporting a clean relaunch.
 */

import { logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRelaunch } from "./app-relaunch";

const installedApps = [
	{
		name: "Feed",
		displayName: "Daily Digest",
		pluginName: "feed-plugin",
		version: "1.0.0",
		installedAt: "t",
	},
	{
		name: "Chat",
		displayName: "Chat",
		pluginName: "chat-plugin",
		version: "1.0.0",
		installedAt: "t",
	},
	{
		name: "Other",
		displayName: "Feed",
		pluginName: "other-plugin",
		version: "1.0.0",
		installedAt: "t",
	},
];

function makeClient() {
	return {
		listInstalledApps: vi.fn().mockResolvedValue(installedApps),
		listAppRuns: vi.fn().mockResolvedValue([]),
		stopAppRun: vi.fn().mockResolvedValue({ success: true }),
		launchApp: vi
			.fn()
			.mockResolvedValue({ displayName: "Chat", run: { runId: "run-2" } }),
	};
}

function makeRuntime(service: unknown = null) {
	return { getService: vi.fn(() => service) };
}

function makeMessage(text: string) {
	return { content: { text }, agentId: "agent-1", userId: "user-1" } as any;
}

describe("runRelaunch — resolution gate + stop-failure containment", () => {
	let client: ReturnType<typeof makeClient>;
	let callback: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		client = makeClient();
		callback = vi.fn();
	});

	it("asks which app to relaunch when neither target nor runId is given", async () => {
		const result = await runRelaunch({
			runtime: makeRuntime(),
			client,
			message: makeMessage("relaunch please"),
			options: {},
			callback,
		} as any);

		expect(client.launchApp).not.toHaveBeenCalled();
		expect(client.listInstalledApps).not.toHaveBeenCalled();
		expect(result.success).toBe(true);
		expect(result.turnComplete).toBe(true);
		expect(result.values).toMatchObject({ awaitingAppName: true });
		expect(callback).toHaveBeenCalledWith({
			text: "Which app should I relaunch?",
		});
	});

	it("NEVER launches when the target is ambiguous — asks the user to pick instead", async () => {
		const result = await runRelaunch({
			runtime: makeRuntime(),
			client,
			message: makeMessage("relaunch the feed app"),
			options: {},
			callback,
		} as any);

		expect(client.launchApp).not.toHaveBeenCalled();
		expect(client.stopAppRun).not.toHaveBeenCalled();
		expect(result.success).toBe(true);
		expect(result.turnComplete).toBe(true);
		expect(result.values).toMatchObject({ awaitingSelection: true });
		const callText = (callback.mock.calls[0] as any)[0].text as string;
		expect(callText).toContain("matches multiple apps");
	});

	it("stops the matching run, then launches the resolved app", async () => {
		client.listAppRuns.mockResolvedValue([
			{
				runId: "run-1",
				appName: "Chat",
				displayName: "Chat",
				pluginName: "chat-plugin",
				launchType: "app",
				launchUrl: null,
				status: "running",
				summary: null,
				startedAt: "t",
				updatedAt: "t",
				lastHeartbeatAt: "t",
			},
		]);
		const result = await runRelaunch({
			runtime: makeRuntime(),
			client,
			message: makeMessage("relaunch the chat app"),
			options: {},
			callback,
		} as any);

		expect(client.stopAppRun).toHaveBeenCalledWith("run-1");
		expect(client.launchApp).toHaveBeenCalledWith("Chat");
		expect(result.values).toMatchObject({
			mode: "relaunch",
			appName: "Chat",
			runId: "run-2",
		});
		const callText = (callback.mock.calls[0] as any)[0].text as string;
		expect(callText).toContain("Relaunched Chat");
		expect(callText).toContain("run-2");
	});

	it("contains a failed stop of a previous run to a warning and still relaunches", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		client.stopAppRun.mockRejectedValue(new Error("run vanished"));
		client.listAppRuns.mockResolvedValue([
			{
				runId: "run-1",
				appName: "Chat",
				displayName: "Chat",
				pluginName: "chat-plugin",
				launchType: "app",
				launchUrl: null,
				status: "running",
				summary: null,
				startedAt: "t",
				updatedAt: "t",
				lastHeartbeatAt: "t",
			},
		]);

		const result = await runRelaunch({
			runtime: makeRuntime(),
			client,
			message: makeMessage("relaunch the chat app"),
			options: {},
			callback,
		} as any);

		expect(warn).toHaveBeenCalled();
		expect(client.launchApp).toHaveBeenCalledWith("Chat");
		expect(result.success).toBe(true);
		warn.mockRestore();
	});

	it("with verify:true and no workdir, skips verification with an explanatory note", async () => {
		const result = await runRelaunch({
			runtime: makeRuntime(),
			client,
			message: makeMessage("relaunch the chat app"),
			options: { verify: true },
			callback,
		} as any);

		const callText = (callback.mock.calls[0] as any)[0].text as string;
		expect(callText).toContain("Skipping verify: no workdir was supplied");
	});

	it("with verify:true and a failing verification, surfaces the fail detail in the result text", async () => {
		const verifyApp = vi.fn().mockResolvedValue({
			verdict: "fail",
			retryablePromptForChild: "typecheck failed: 3 errors",
		});
		const result = await runRelaunch({
			runtime: makeRuntime({ verifyApp }),
			client,
			message: makeMessage("relaunch the chat app"),
			options: { verify: true, workdir: "/work/chat" },
			callback,
		} as any);

		expect(verifyApp).toHaveBeenCalledWith({
			workdir: "/work/chat",
			appName: "Chat",
			profile: "fast",
		});
		const callText = (callback.mock.calls[0] as any)[0].text as string;
		expect(callText).toContain("quick verification check failed");
		expect(result.text).toContain("typecheck failed: 3 errors");
	});

	it("with verify:true and no verification service registered, reports the skip", async () => {
		const result = await runRelaunch({
			runtime: makeRuntime(null),
			client,
			message: makeMessage("relaunch the chat app"),
			options: { verify: true, workdir: "/work/chat" },
			callback,
		} as any);

		const callText = (callback.mock.calls[0] as any)[0].text as string;
		expect(callText).toContain("AppVerificationService is not registered");
	});
});

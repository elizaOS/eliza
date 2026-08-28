/**
 * Behavioral contract for the APP/stop action (plugin-app-control).
 *
 * The dangerous surface here is the state-changing HTTP boundary: once a run
 * id or resolved app name reaches `client.stopAppRun`/`client.stopApp`, an
 * app process is killed. Name resolution must therefore be airtight *before*
 * the boundary — ambiguous or unknown planner targets must never reach it.
 * These tests pin that gate plus the callback/result shapes for every branch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runStop } from "./app-stop";

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
	// Shares the normalized "feed" key with the app above -> ambiguous for "feed"
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
		stopAppRun: vi.fn(),
		stopApp: vi.fn(),
		listInstalledApps: vi.fn().mockResolvedValue(installedApps),
	};
}

function makeMessage(text: string) {
	return { content: { text }, agentId: "agent-1", userId: "user-1" } as any;
}

function stopResult(success: boolean, extra: Record<string, unknown> = {}) {
	return {
		success,
		message: success ? "Stopped." : "Stop failed.",
		appName: "Feed",
		runId: "run-1",
		stopScope: "app",
		...extra,
	};
}
describe("runStop — resolution gate before the state-changing HTTP boundary", () => {
	let client: ReturnType<typeof makeClient>;
	let callback: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		client = makeClient();
		callback = vi.fn();
	});

	it("stops a run directly by runId and reports the stop result", async () => {
		client.stopAppRun.mockResolvedValue(stopResult(true));
		const result = await runStop({
			client,
			message: makeMessage("stop the feed app"),
			options: { runId: "run-7" },
			callback,
		} as any);

		expect(client.stopAppRun).toHaveBeenCalledWith("run-7");
		expect(client.stopApp).not.toHaveBeenCalled();
		expect(callback).toHaveBeenCalledWith({ text: "Stopped." });
		expect(result.success).toBe(true);
		expect(result.values).toMatchObject({
			mode: "stop",
			runId: "run-1",
			appName: "Feed",
		});
	});

	it("resolves a name to the installed app and stops it by resolved name", async () => {
		client.stopApp.mockResolvedValue(stopResult(true));
		const result = await runStop({
			client,
			message: makeMessage("stop the chat app"),
			options: {},
			callback,
		} as any);

		expect(client.listInstalledApps).toHaveBeenCalledOnce();
		expect(client.stopApp).toHaveBeenCalledWith("Chat");
		expect(client.stopAppRun).not.toHaveBeenCalled();
		expect(result.success).toBe(true);
		expect(result.values).toMatchObject({ mode: "stop", appName: "Feed" });
	});

	it("NEVER stops anything when the target is ambiguous — clarifies with candidates instead", async () => {
		// "feed" matches both "Feed" (exact) and the app whose displayName is "Feed"
		const result = await runStop({
			client,
			message: makeMessage("stop the feed app"),
			options: {},
			callback,
		} as any);

		expect(client.stopApp).not.toHaveBeenCalled();
		expect(client.stopAppRun).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		const callText = (callback.mock.calls[0] as any)[0].text as string;
		expect(callText).toContain("matches multiple apps");
		expect(callText).toContain("Please specify which one");
		expect(result.data).toHaveProperty("candidates");
	});

	it("NEVER stops anything for an unknown target — replies with the no-match message", async () => {
		const result = await runStop({
			client,
			message: makeMessage("stop the nonexistent app"),
			options: {},
			callback,
		} as any);

		expect(client.stopApp).not.toHaveBeenCalled();
		expect(client.stopAppRun).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		const callText = (callback.mock.calls[0] as any)[0].text as string;
		expect(callText).toContain("No installed app matches");
	});

	it("asks for a target when neither runId nor app name is present and makes no client calls", async () => {
		const result = await runStop({
			client,
			message: makeMessage("please stop"),
			options: {},
			callback,
		} as any);

		expect(client.stopApp).not.toHaveBeenCalled();
		expect(client.stopAppRun).not.toHaveBeenCalled();
		expect(client.listInstalledApps).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		const callText = (callback.mock.calls[0] as any)[0].text as string;
		expect(callText).toContain("I need an app name or runId");
	});

	it("propagates a failed stop as success:false with the API message", async () => {
		client.stopApp.mockResolvedValue(
			stopResult(false, { message: "Stop failed: not owner" }),
		);
		const result = await runStop({
			client,
			message: makeMessage("stop the chat app"),
			options: {},
			callback,
		} as any);

		expect(result.success).toBe(false);
		expect(result.text).toBe("Stop failed: not owner");
		expect(callback).toHaveBeenCalledWith({ text: "Stop failed: not owner" });
	});
});

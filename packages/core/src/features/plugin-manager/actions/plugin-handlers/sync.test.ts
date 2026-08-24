/**
 * Exercises the sync handler's validation, failure reporting, and complete
 * success delivery contract using the real handler implementation.
 */

import { describe, expect, it } from "vitest";
import type { HandlerCallback } from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import { runSync } from "./sync.ts";

function createHarness({
	result,
	available = true,
}: {
	result?: unknown;
	available?: boolean;
} = {}): {
	runtime: IAgentRuntime;
	serviceNames: string[];
	syncedNames: string[];
} {
	const serviceNames: string[] = [];
	const syncedNames: string[] = [];
	const service = available
		? {
				syncPlugin: async (name: string) => {
					syncedNames.push(name);
					return result;
				},
			}
		: null;

	return {
		runtime: {
			getService: (name: string) => {
				serviceNames.push(name);
				return service;
			},
		} as unknown as IAgentRuntime,
		serviceNames,
		syncedNames,
	};
}

function createCallback(): {
	callback: HandlerCallback;
	replies: unknown[];
} {
	const replies: unknown[] = [];
	return {
		callback: async (content) => {
			replies.push(content);
			return [];
		},
		replies,
	};
}

describe("runSync", () => {
	it("returns and delivers a failure when the plugin manager is unavailable", async () => {
		const { runtime, serviceNames, syncedNames } = createHarness({
			available: false,
		});
		const { callback, replies } = createCallback();

		const result = await runSync({
			runtime,
			name: "@elizaos/plugin-example",
			callback,
		});

		expect(serviceNames).toEqual(["plugin_manager"]);
		expect(syncedNames).toEqual([]);
		expect(result).toEqual({
			success: false,
			text: "Plugin manager service not available",
		});
		expect(replies).toEqual([{ text: "Plugin manager service not available" }]);
	});

	it("rejects an empty plugin name without calling the sync service", async () => {
		const { runtime, syncedNames } = createHarness();
		const { callback, replies } = createCallback();

		const result = await runSync({ runtime, name: "", callback });

		expect(syncedNames).toEqual([]);
		expect(result).toEqual({
			success: false,
			text: "Specify an ejected plugin name to sync.",
		});
		expect(replies).toEqual([
			{ text: "Specify an ejected plugin name to sync." },
		]);
	});

	it("preserves the requested name and service error in a failed result", async () => {
		const requestedName = "@elizaos/plugin-example@next";
		const { runtime, syncedNames } = createHarness({
			result: {
				success: false,
				pluginName: "@elizaos/plugin-example",
				requiresRestart: false,
				error: "upstream has conflicting changes",
			},
		});
		const { callback, replies } = createCallback();

		const result = await runSync({
			runtime,
			name: requestedName,
			callback,
		});

		expect(syncedNames).toEqual([requestedName]);
		expect(result).toEqual({
			success: false,
			text: `Failed to sync ${requestedName}: upstream has conflicting changes`,
		});
		expect(replies).toEqual([
			{
				text: `Failed to sync ${requestedName}: upstream has conflicting changes`,
			},
		]);
	});

	it("uses the unknown-error fallback when a failed result omits its error", async () => {
		const { runtime, syncedNames } = createHarness({
			result: {
				success: false,
				pluginName: "plugin-example",
				requiresRestart: false,
			},
		});

		const result = await runSync({ runtime, name: "plugin-example" });

		expect(syncedNames).toEqual(["plugin-example"]);
		expect(result).toEqual({
			success: false,
			text: "Failed to sync plugin-example: unknown error",
		});
	});

	it("returns complete sync data without restart wording", async () => {
		const ejectedPath = "/state/ejected/plugin-example";
		const commitHash = "84d61f0c6ed221ec";
		const conflicts = ["src/config.ts"];
		const { runtime, syncedNames } = createHarness({
			result: {
				success: true,
				pluginName: "@elizaos/plugin-example",
				ejectedPath,
				upstreamCommits: 0,
				localChanges: true,
				conflicts,
				commitHash,
				requiresRestart: false,
			},
		});
		const { callback, replies } = createCallback();

		const result = await runSync({
			runtime,
			name: "plugin-example",
			callback,
		});

		const text =
			"Synced @elizaos/plugin-example with 0 new upstream update(s).";
		expect(syncedNames).toEqual(["plugin-example"]);
		expect(result).toEqual({
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: {
				mode: "sync",
				name: "@elizaos/plugin-example",
				upstreamCommits: 0,
				commitHash,
			},
			data: {
				success: true,
				pluginName: "@elizaos/plugin-example",
				ejectedPath,
				upstreamCommits: 0,
				localChanges: true,
				conflicts,
				commitHash,
				requiresRestart: false,
			},
		});
		expect(replies).toEqual([{ text }]);
		expect(text).not.toContain(ejectedPath);
		expect(text).not.toContain(commitHash);
	});

	it("adds restart guidance to the exact result and callback text", async () => {
		const { runtime } = createHarness({
			result: {
				success: true,
				pluginName: "plugin-example",
				ejectedPath: "/state/ejected/plugin-example",
				upstreamCommits: 3,
				localChanges: false,
				conflicts: [],
				commitHash: "current-head",
				requiresRestart: true,
			},
		});
		const { callback, replies } = createCallback();

		const result = await runSync({
			runtime,
			name: "plugin-example",
			callback,
		});

		const text =
			"Synced plugin-example with 3 new upstream update(s). A restart is needed to pick them up.";
		expect(result.text).toBe(text);
		expect(result.userFacingText).toBe(text);
		expect(result.values).toEqual({
			mode: "sync",
			name: "plugin-example",
			upstreamCommits: 3,
			commitHash: "current-head",
		});
		expect(replies).toEqual([{ text }]);
	});
});

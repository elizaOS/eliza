/**
 * Exercises the eject handler's unavailable, invalid-input, failure, and
 * successful planner-facing contracts using deterministic service seams.
 */

import { describe, expect, it } from "vitest";
import type { HandlerCallback } from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import { runEject } from "./eject.ts";

function createHarness({
	result,
	available = true,
}: {
	result?: unknown;
	available?: boolean;
} = {}): {
	runtime: IAgentRuntime;
	serviceNames: string[];
	ejectedNames: string[];
} {
	const serviceNames: string[] = [];
	const ejectedNames: string[] = [];
	const service = available
		? {
				ejectPlugin: async (name: string) => {
					ejectedNames.push(name);
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
		ejectedNames,
	};
}

function createCallback(): {
	callback: HandlerCallback;
	replies: string[];
} {
	const replies: string[] = [];
	const callback: HandlerCallback = async (content) => {
		if (typeof content.text === "string") replies.push(content.text);
		return [];
	};
	return { callback, replies };
}

describe("runEject", () => {
	it("returns and delivers a failure when the plugin manager is unavailable", async () => {
		const { runtime, serviceNames, ejectedNames } = createHarness({
			available: false,
		});
		const { callback, replies } = createCallback();

		const result = await runEject({
			runtime,
			name: "@elizaos/plugin-discord",
			callback,
		});

		expect(result).toEqual({
			success: false,
			text: "Plugin manager service not available",
		});
		expect(serviceNames).toEqual(["plugin_manager"]);
		expect(ejectedNames).toEqual([]);
		expect(replies).toEqual(["Plugin manager service not available"]);
	});

	it("rejects an empty plugin name without invoking the eject service", async () => {
		const { runtime, serviceNames, ejectedNames } = createHarness();
		const { callback, replies } = createCallback();

		const result = await runEject({ runtime, name: "", callback });

		expect(result).toEqual({
			success: false,
			text: "Specify a plugin name to eject.",
		});
		expect(serviceNames).toEqual(["plugin_manager"]);
		expect(ejectedNames).toEqual([]);
		expect(replies).toEqual(["Specify a plugin name to eject."]);
	});

	it("preserves the requested name and reports the service failure", async () => {
		const requestedName = "@elizaos/plugin-discord@next";
		const { runtime, ejectedNames } = createHarness({
			result: {
				success: false,
				pluginName: "@elizaos/plugin-discord",
				requiresRestart: false,
				error: "registry entry is unavailable",
			},
		});
		const { callback, replies } = createCallback();

		const result = await runEject({
			runtime,
			name: requestedName,
			callback,
		});

		expect(ejectedNames).toEqual([requestedName]);
		expect(result).toEqual({
			success: false,
			text: `Failed to eject ${requestedName}: registry entry is unavailable`,
		});
		expect(replies).toEqual([
			`Failed to eject ${requestedName}: registry entry is unavailable`,
		]);
	});

	it("uses the unknown-error fallback when a failure has no error detail", async () => {
		const { runtime, ejectedNames } = createHarness({
			result: {
				success: false,
				pluginName: "plugin-legacy",
				requiresRestart: false,
			},
		});

		const result = await runEject({
			runtime,
			name: "plugin-legacy",
		});

		expect(ejectedNames).toEqual(["plugin-legacy"]);
		expect(result).toEqual({
			success: false,
			text: "Failed to eject plugin-legacy: unknown error",
		});
	});

	it("returns complete success data without exposing the path or hash in visible text", async () => {
		const ejectedPath = "/private/state/plugins/plugin-alpha";
		const upstreamCommit = "b97d3f8a221e4f15";
		const { runtime, ejectedNames } = createHarness({
			result: {
				success: true,
				pluginName: "@elizaos/plugin-alpha",
				ejectedPath,
				upstreamCommit,
				requiresRestart: false,
			},
		});
		const { callback, replies } = createCallback();

		const result = await runEject({
			runtime,
			name: "plugin-alpha",
			callback,
		});

		const text =
			"Ejected @elizaos/plugin-alpha — the local copy is ready to edit.";
		expect(ejectedNames).toEqual(["plugin-alpha"]);
		expect(result).toEqual({
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: {
				mode: "eject",
				name: "@elizaos/plugin-alpha",
				ejectedPath,
				upstreamCommit,
			},
			data: {
				success: true,
				pluginName: "@elizaos/plugin-alpha",
				ejectedPath,
				upstreamCommit,
				requiresRestart: false,
			},
		});
		expect(replies).toEqual([text]);
		for (const visibleText of [
			result.text,
			result.userFacingText,
			...replies,
		]) {
			expect(visibleText).not.toContain(ejectedPath);
			expect(visibleText).not.toContain(upstreamCommit);
		}
	});

	it("appends the restart instruction to the exact result and callback text", async () => {
		const { runtime } = createHarness({
			result: {
				success: true,
				pluginName: "plugin-beta",
				ejectedPath: "/state/plugins/plugin-beta",
				upstreamCommit: "restart-commit",
				requiresRestart: true,
			},
		});
		const { callback, replies } = createCallback();

		const result = await runEject({
			runtime,
			name: "plugin-beta",
			callback,
		});

		const text =
			"Ejected plugin-beta — the local copy is ready to edit. A restart is needed to load the local copy.";
		expect(result.text).toBe(text);
		expect(result.userFacingText).toBe(text);
		expect(replies).toEqual([text]);
	});
});

/**
 * Exercises the install handler's validation, failure reporting, success
 * delivery contract, and the PLUGIN_MANAGER_LOCAL_CLONE scoping that a
 * git-source install applies for the duration of one service call only,
 * using the real handler implementation.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { HandlerCallback } from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import { runInstall } from "./install.ts";

function createHarness({
	result,
	available = true,
}: {
	result?: unknown;
	available?: boolean;
} = {}): {
	runtime: IAgentRuntime;
	serviceNames: string[];
	installedNames: string[];
	observedEnvValues: (string | undefined)[];
	progressReporters: ((progress: unknown) => void)[];
} {
	const serviceNames: string[] = [];
	const installedNames: string[] = [];
	const observedEnvValues: (string | undefined)[] = [];
	const progressReporters: ((progress: unknown) => void)[] = [];
	const service = available
		? {
				installPlugin: async (
					name: string,
					onProgress?: (progress: unknown) => void,
				) => {
					installedNames.push(name);
					observedEnvValues.push(process.env.PLUGIN_MANAGER_LOCAL_CLONE);
					if (onProgress) progressReporters.push(onProgress);
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
		installedNames,
		observedEnvValues,
		progressReporters,
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

afterEach(() => {
	delete process.env.PLUGIN_MANAGER_LOCAL_CLONE;
});

describe("runInstall", () => {
	it("returns and delivers a failure when the plugin manager is unavailable", async () => {
		const { runtime, serviceNames, installedNames } = createHarness({
			available: false,
		});
		const { callback, replies } = createCallback();

		const result = await runInstall({
			runtime,
			name: "@elizaos/plugin-example",
			callback,
		});

		expect(serviceNames).toEqual(["plugin_manager"]);
		expect(installedNames).toEqual([]);
		expect(result).toEqual({
			success: false,
			text: "Plugin manager service not available",
		});
		expect(replies).toEqual([{ text: "Plugin manager service not available" }]);
	});

	it("rejects an empty plugin name without calling the install service", async () => {
		const { runtime, installedNames } = createHarness();
		const { callback, replies } = createCallback();

		const result = await runInstall({ runtime, name: "", callback });

		expect(installedNames).toEqual([]);
		expect(result).toEqual({
			success: false,
			text: "Specify a plugin name to install (e.g. @elizaos/plugin-discord).",
		});
		expect(replies).toEqual([
			{
				text: "Specify a plugin name to install (e.g. @elizaos/plugin-discord).",
			},
		]);
	});

	it("preserves the requested name and service error in a failed result", async () => {
		const requestedName = "@elizaos/plugin-example@next";
		const { runtime, installedNames } = createHarness({
			result: {
				success: false,
				pluginName: "@elizaos/plugin-example",
				requiresRestart: false,
				error: "npm install exited with code 1",
			},
		});
		const { callback, replies } = createCallback();

		const result = await runInstall({
			runtime,
			name: requestedName,
			callback,
		});

		expect(installedNames).toEqual([requestedName]);
		expect(result).toEqual({
			success: false,
			text: `Failed to install ${requestedName}: npm install exited with code 1`,
		});
		expect(replies).toEqual([
			{
				text: `Failed to install ${requestedName}: npm install exited with code 1`,
			},
		]);
	});

	it("uses the unknown-error fallback when a failed result omits its error", async () => {
		const { runtime, installedNames } = createHarness({
			result: {
				success: false,
				pluginName: "plugin-example",
				requiresRestart: false,
			},
		});

		const result = await runInstall({ runtime, name: "plugin-example" });

		expect(installedNames).toEqual(["plugin-example"]);
		expect(result).toEqual({
			success: false,
			text: "Failed to install plugin-example: unknown error",
		});
	});

	it("returns complete install data without restart wording", async () => {
		const installPath = "/state/plugins/installed/@elizaos_plugin-example";
		const { runtime, installedNames } = createHarness({
			result: {
				success: true,
				pluginName: "@elizaos/plugin-example",
				version: "2.0.0",
				installPath,
				requiresRestart: false,
			},
		});
		const { callback, replies } = createCallback();

		const result = await runInstall({
			runtime,
			name: "@elizaos/plugin-example",
			callback,
		});

		const text = "Installed @elizaos/plugin-example (v2.0.0).";
		expect(installedNames).toEqual(["@elizaos/plugin-example"]);
		expect(result).toEqual({
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: {
				mode: "install",
				name: "@elizaos/plugin-example",
				version: "2.0.0",
				installPath,
			},
			data: {
				success: true,
				pluginName: "@elizaos/plugin-example",
				version: "2.0.0",
				installPath,
				requiresRestart: false,
			},
		});
		expect(replies).toEqual([{ text }]);
		expect(text).not.toContain(installPath);
	});

	it("adds restart guidance to the exact result and callback text", async () => {
		const { runtime } = createHarness({
			result: {
				success: true,
				pluginName: "plugin-example",
				version: "1.2.3",
				installPath: "/state/plugins/installed/plugin-example",
				requiresRestart: true,
			},
		});
		const { callback, replies } = createCallback();

		const result = await runInstall({
			runtime,
			name: "plugin-example",
			callback,
		});

		const text =
			"Installed plugin-example (v1.2.3). A restart is needed before it's active.";
		expect(result.text).toBe(text);
		expect(result.userFacingText).toBe(text);
		expect(result.values).toEqual({
			mode: "install",
			name: "plugin-example",
			version: "1.2.3",
			installPath: "/state/plugins/installed/plugin-example",
		});
		expect(replies).toEqual([{ text }]);
	});

	it("passes a progress reporter through to the service call", async () => {
		const { runtime, progressReporters } = createHarness({
			result: {
				success: true,
				pluginName: "plugin-example",
				version: "1.0.0",
				installPath: "/state/plugins/installed/plugin-example",
				requiresRestart: false,
			},
		});

		await runInstall({ runtime, name: "plugin-example" });

		expect(progressReporters.length).toBe(1);
		expect(() =>
			progressReporters[0]?.({ phase: "resolving", message: "looking up" }),
		).not.toThrow();
	});

	it("sets PLUGIN_MANAGER_LOCAL_CLONE during a git-source call and deletes it afterwards when previously unset", async () => {
		const { runtime, observedEnvValues } = createHarness({
			result: {
				success: true,
				pluginName: "plugin-example",
				version: "1.0.0",
				installPath: "/state/plugins/installed/plugin-example",
				requiresRestart: false,
			},
		});
		delete process.env.PLUGIN_MANAGER_LOCAL_CLONE;

		const result = await runInstall({
			runtime,
			name: "plugin-example",
			source: "git",
		});

		expect(observedEnvValues).toEqual(["true"]);
		expect(result.success).toBe(true);
		expect(process.env.PLUGIN_MANAGER_LOCAL_CLONE).toBeUndefined();
	});

	it("restores the previous PLUGIN_MANAGER_LOCAL_CLONE value after a git-source call", async () => {
		const { runtime, observedEnvValues } = createHarness({
			result: {
				success: true,
				pluginName: "plugin-example",
				version: "1.0.0",
				installPath: "/state/plugins/installed/plugin-example",
				requiresRestart: false,
			},
		});
		process.env.PLUGIN_MANAGER_LOCAL_CLONE = "false";

		await runInstall({
			runtime,
			name: "plugin-example",
			source: "git",
		});

		expect(observedEnvValues).toEqual(["true"]);
		expect(process.env.PLUGIN_MANAGER_LOCAL_CLONE).toBe("false");
	});

	it("keeps the local-clone override active after a failed git-source call until restoration", async () => {
		const { runtime, observedEnvValues } = createHarness({
			result: {
				success: false,
				pluginName: "plugin-example",
				requiresRestart: false,
				error: "clone failed",
			},
		});
		process.env.PLUGIN_MANAGER_LOCAL_CLONE = "keep-me";

		const result = await runInstall({
			runtime,
			name: "plugin-example",
			source: "git",
		});

		expect(observedEnvValues).toEqual(["true"]);
		expect(result.success).toBe(false);
		expect(process.env.PLUGIN_MANAGER_LOCAL_CLONE).toBe("keep-me");
	});

	it("leaves PLUGIN_MANAGER_LOCAL_CLONE untouched for npm installs", async () => {
		const { runtime, observedEnvValues } = createHarness({
			result: {
				success: true,
				pluginName: "plugin-example",
				version: "1.0.0",
				installPath: "/state/plugins/installed/plugin-example",
				requiresRestart: false,
			},
		});
		process.env.PLUGIN_MANAGER_LOCAL_CLONE = "false";

		await runInstall({ runtime, name: "plugin-example" });

		expect(observedEnvValues).toEqual(["false"]);
		expect(process.env.PLUGIN_MANAGER_LOCAL_CLONE).toBe("false");
	});
});

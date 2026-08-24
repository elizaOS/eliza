/**
 * Exercises the reinject plugin handler's validation, failure reporting, and
 * complete success delivery contract using the real handler implementation.
 */

import { describe, expect, it } from "vitest";
import type { HandlerCallback } from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { ReinjectResult } from "../../types.ts";
import { runReinject } from "./reinject.ts";

function createRuntime(service: unknown): {
	runtime: IAgentRuntime;
	serviceNames: string[];
} {
	const serviceNames: string[] = [];
	return {
		runtime: {
			getService: (name: string) => {
				serviceNames.push(name);
				return service;
			},
		} as unknown as IAgentRuntime,
		serviceNames,
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

describe("runReinject", () => {
	it("returns and reports a failure when the plugin manager is unavailable", async () => {
		const { runtime, serviceNames } = createRuntime(null);
		const { callback, replies } = createCallback();

		const result = await runReinject({
			runtime,
			name: "@elizaos/plugin-example",
			callback,
		});

		expect(serviceNames).toEqual(["plugin_manager"]);
		expect(result).toEqual({
			success: false,
			text: "Plugin manager service not available",
		});
		expect(replies).toEqual([{ text: "Plugin manager service not available" }]);
	});

	it("rejects an empty plugin name without calling the reinject service", async () => {
		let reinjectCalls = 0;
		const { runtime } = createRuntime({
			reinjectPlugin: async () => {
				reinjectCalls += 1;
				throw new Error("should not run");
			},
		});
		const { callback, replies } = createCallback();

		const result = await runReinject({ runtime, name: "", callback });

		expect(reinjectCalls).toBe(0);
		expect(result).toEqual({
			success: false,
			text: "Specify an ejected plugin name to reinject.",
		});
		expect(replies).toEqual([
			{ text: "Specify an ejected plugin name to reinject." },
		]);
	});

	it("preserves the requested name and service error in a failed result", async () => {
		const requestedNames: string[] = [];
		const serviceResult: ReinjectResult = {
			success: false,
			pluginName: "@elizaos/plugin-example",
			requiresRestart: false,
			error: "Plugin not found",
		};
		const { runtime } = createRuntime({
			reinjectPlugin: async (name: string) => {
				requestedNames.push(name);
				return serviceResult;
			},
		});
		const { callback, replies } = createCallback();

		const result = await runReinject({
			runtime,
			name: "@elizaos/plugin-example",
			callback,
		});

		expect(requestedNames).toEqual(["@elizaos/plugin-example"]);
		expect(result).toEqual({
			success: false,
			text: "Failed to reinject @elizaos/plugin-example: Plugin not found",
		});
		expect(replies).toEqual([
			{
				text: "Failed to reinject @elizaos/plugin-example: Plugin not found",
			},
		]);
	});

	it("uses the unknown-error fallback when a failed service result omits its error", async () => {
		const { runtime } = createRuntime({
			reinjectPlugin: async () => ({
				success: false,
				pluginName: "plugin-example",
				requiresRestart: false,
			}),
		});

		const result = await runReinject({ runtime, name: "plugin-example" });

		expect(result).toEqual({
			success: false,
			text: "Failed to reinject plugin-example: unknown error",
		});
	});

	it("returns the complete success contract without restart wording", async () => {
		const serviceResult: ReinjectResult = {
			success: true,
			pluginName: "@elizaos/plugin-example",
			removedPath: "/state/ejected/plugin-example",
			requiresRestart: false,
		};
		const { runtime } = createRuntime({
			reinjectPlugin: async () => serviceResult,
		});
		const { callback, replies } = createCallback();

		const result = await runReinject({
			runtime,
			name: "plugin-example",
			callback,
		});

		const text =
			"Reinjected @elizaos/plugin-example — back on the standard installed version.";
		expect(result).toEqual({
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: {
				mode: "reinject",
				name: "@elizaos/plugin-example",
				removedPath: "/state/ejected/plugin-example",
			},
			data: serviceResult,
		});
		expect(replies).toEqual([{ text }]);
	});

	it("adds restart guidance and succeeds without a callback", async () => {
		const serviceResult: ReinjectResult = {
			success: true,
			pluginName: "plugin-example",
			removedPath: "/state/ejected/plugin-example",
			requiresRestart: true,
		};
		const { runtime } = createRuntime({
			reinjectPlugin: async () => serviceResult,
		});

		const result = await runReinject({ runtime, name: "plugin-example" });

		expect(result.text).toBe(
			"Reinjected plugin-example — back on the standard installed version. A restart is needed to pick it up.",
		);
		expect(result.data).toEqual(serviceResult);
		expect(result.values).toEqual({
			mode: "reinject",
			name: "plugin-example",
			removedPath: "/state/ejected/plugin-example",
		});
	});
});

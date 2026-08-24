/**
 * Exercises the list-ejected plugin handler's service boundary and complete
 * user-facing result contract with deterministic in-memory collaborators.
 */

import { describe, expect, it, vi } from "vitest";
import type { HandlerCallback } from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { EjectedPluginInfo } from "../../types.ts";
import { runListEjected } from "./list-ejected.ts";

function createRuntime(service: unknown): {
	runtime: IAgentRuntime;
	getService: ReturnType<typeof vi.fn>;
} {
	const getService = vi.fn(() => service);
	return {
		runtime: { getService } as unknown as IAgentRuntime,
		getService,
	};
}

function createCallback(): {
	callback: HandlerCallback;
	replies: string[];
} {
	const replies: string[] = [];
	const callback: HandlerCallback = vi.fn(async (content) => {
		if (typeof content.text === "string") replies.push(content.text);
		return [];
	});
	return { callback, replies };
}

describe("runListEjected", () => {
	it("returns a failure and reports it when the plugin manager is unavailable", async () => {
		const { runtime, getService } = createRuntime(null);
		const { callback, replies } = createCallback();

		const result = await runListEjected({ runtime, callback });

		expect(getService).toHaveBeenCalledOnce();
		expect(getService).toHaveBeenCalledWith("plugin_manager");
		expect(result).toEqual({
			success: false,
			text: "Plugin manager service not available",
		});
		expect(replies).toEqual(["Plugin manager service not available"]);
	});

	it("returns the complete empty-state delivery contract", async () => {
		const listEjectedPlugins = vi.fn(async () => []);
		const { runtime } = createRuntime({ listEjectedPlugins });
		const { callback, replies } = createCallback();

		const result = await runListEjected({ runtime, callback });

		expect(listEjectedPlugins).toHaveBeenCalledOnce();
		expect(result).toEqual({
			success: true,
			text: "No ejected plugins found.",
			userFacingText: "No ejected plugins found.",
			verifiedUserFacing: true,
			turnComplete: true,
			values: { mode: "list_ejected", count: 0 },
		});
		expect(replies).toEqual(["No ejected plugins found."]);
	});

	it("formats one ejected plugin and works without a callback", async () => {
		const plugin: EjectedPluginInfo = {
			name: "@elizaos/plugin-alpha",
			version: "1.2.3",
			path: "/workspace/plugins/plugin-alpha",
			upstream: null,
		};
		const { runtime } = createRuntime({
			listEjectedPlugins: async () => [plugin],
		});

		const result = await runListEjected({ runtime });

		const text =
			"Ejected plugins (1):\n" +
			"  - @elizaos/plugin-alpha (v1.2.3) at /workspace/plugins/plugin-alpha";
		expect(result).toEqual({
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: { mode: "list_ejected", count: 1 },
			data: { plugins: [plugin] },
		});
	});

	it("preserves service ordering when versions tie and returns every plugin", async () => {
		const plugins: EjectedPluginInfo[] = [
			{
				name: "plugin-zeta",
				version: "2.0.0",
				path: "/ejected/zeta",
				upstream: null,
			},
			{
				name: "plugin-alpha",
				version: "2.0.0",
				path: "/ejected/alpha",
				upstream: null,
			},
		];
		const { runtime } = createRuntime({
			listEjectedPlugins: async () => plugins,
		});
		const { callback, replies } = createCallback();

		const result = await runListEjected({ runtime, callback });

		const text = [
			"Ejected plugins (2):",
			"  - plugin-zeta (v2.0.0) at /ejected/zeta",
			"  - plugin-alpha (v2.0.0) at /ejected/alpha",
		].join("\n");
		expect(result).toEqual({
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: { mode: "list_ejected", count: 2 },
			data: { plugins },
		});
		expect(replies).toEqual([text]);
	});
});

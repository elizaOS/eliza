import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Memory, Plugin } from "../types";
import { executePlannedToolCall } from "./execute-planned-tool-call";

function makeMessage(): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "hello" },
	} as Memory;
}

describe("plugin action context lifecycle", () => {
	it("derives action role gates from plugin-registered contexts", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const plugin: Plugin = {
			name: "owner-context-plugin",
			description: "Registers an owner-only context and action",
			init: (_config, pluginRuntime) => {
				pluginRuntime.contexts.register({
					id: "owner_context_plugin",
					label: "Owner plugin context",
					description: "Owner-only plugin context",
					roleGate: { minRole: "OWNER" },
				});
			},
			actions: [
				{
					name: "OWNER_CONTEXT_ACTION",
					description: "Action scoped to the plugin context",
					contexts: ["owner_context_plugin"],
					validate: async () => true,
					handler,
				},
			],
		};

		await runtime.registerPlugin(plugin);

		const action = runtime.actions.find(
			(candidate) => candidate.name === "OWNER_CONTEXT_ACTION",
		);
		expect(action?.roleGate).toEqual({ minRole: "OWNER" });

		const userResult = await executePlannedToolCall(
			runtime,
			{
				message: makeMessage(),
				activeContexts: ["owner_context_plugin"],
				userRoles: ["USER"],
			},
			{ name: "OWNER_CONTEXT_ACTION", params: {} },
		);

		expect(userResult.success).toBe(false);
		expect(String(userResult.error)).toContain("not allowed");
		expect(handler).not.toHaveBeenCalled();

		const ownerResult = await executePlannedToolCall(
			runtime,
			{
				message: makeMessage(),
				activeContexts: ["owner_context_plugin"],
				userRoles: ["OWNER"],
			},
			{ name: "OWNER_CONTEXT_ACTION", params: {} },
		);

		expect(ownerResult.success).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
	});
});

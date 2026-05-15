import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { pollPluginConfigStatusAction } from "./poll-plugin-config-status";

function createRuntime(client: unknown) {
	return {
		agentId: "agent-1",
		getService: (name: string) =>
			name === "PluginConfigClient" ? client : null,
	};
}

function createMessage() {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "", channelType: ChannelType.DM },
	};
}

describe("POLL_PLUGIN_CONFIG_STATUS", () => {
	test("returns the client's ready/missing report", async () => {
		const client = {
			getRequirements: async () => null,
			createConfigRequest: async () => null,
			getStatus: async (name: string) => ({
				pluginName: name,
				ready: false,
				missing: ["B"],
			}),
			activate: async () => false,
		};

		const result = await pollPluginConfigStatusAction.handler(
			createRuntime(client) as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as { ready: boolean; missing: string[] };
		expect(data.ready).toBe(false);
		expect(data.missing).toEqual(["B"]);
	});

	test("fails when client service is absent", async () => {
		const runtime = {
			agentId: "agent-1",
			getService: () => null,
		};

		const result = await pollPluginConfigStatusAction.handler(
			runtime as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("PluginConfigClient");
	});
});

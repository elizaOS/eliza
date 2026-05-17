import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { probePluginConfigRequirementsAction } from "./probe-plugin-config-requirements";

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

describe("PROBE_PLUGIN_CONFIG_REQUIREMENTS", () => {
	test("returns required / optional / present / missing from the client", async () => {
		const client = {
			getRequirements: async (name: string) => ({
				pluginName: name,
				required: ["ANTHROPIC_API_KEY"],
				optional: ["ANTHROPIC_SMALL_MODEL"],
				present: ["ANTHROPIC_API_KEY"],
				missing: [],
			}),
			createConfigRequest: async () => null,
			getStatus: async () => null,
			activate: async () => false,
		};

		const result = await probePluginConfigRequirementsAction.handler(
			createRuntime(client) as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as {
			pluginName: string;
			required: string[];
			present: string[];
			missing: string[];
		};
		expect(data.pluginName).toBe("anthropic");
		expect(data.required).toEqual(["ANTHROPIC_API_KEY"]);
		expect(data.present).toEqual(["ANTHROPIC_API_KEY"]);
		expect(data.missing).toEqual([]);
	});

	test("fails cleanly when no manifest is registered", async () => {
		const client = {
			getRequirements: async () => null,
			createConfigRequest: async () => null,
			getStatus: async () => null,
			activate: async () => false,
		};

		const result = await probePluginConfigRequirementsAction.handler(
			createRuntime(client) as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "missing-plugin" } } as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("No manifest");
	});
});

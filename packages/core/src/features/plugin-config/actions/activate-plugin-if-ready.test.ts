import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { activatePluginIfReadyAction } from "./activate-plugin-if-ready";

function createRuntime(client: unknown) {
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const runtime = {
		agentId: "agent-1",
		getService: (name: string) =>
			name === "PluginConfigClient" ? client : null,
		emitEvent: async (event: string, payload: unknown) => {
			emitted.push({ event, payload });
		},
	};
	return { runtime, emitted };
}

function createMessage() {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "", channelType: ChannelType.DM },
	};
}

describe("ACTIVATE_PLUGIN_IF_READY", () => {
	test("activates the plugin and emits PluginActivated when ready", async () => {
		const client = {
			getRequirements: async () => null,
			createConfigRequest: async () => null,
			getStatus: async (name: string) => ({
				pluginName: name,
				ready: true,
				missing: [] as string[],
			}),
			activate: async () => true,
		};

		const { runtime, emitted } = createRuntime(client);

		const result = await activatePluginIfReadyAction.handler(
			runtime as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as { activated: boolean };
		expect(data.activated).toBe(true);
		expect(emitted).toHaveLength(1);
		expect(emitted[0].event).toBe("PluginActivated");
		const payload = emitted[0].payload as { pluginName: string };
		expect(payload.pluginName).toBe("anthropic");
	});

	test("does not activate or emit when missing keys remain", async () => {
		const client = {
			getRequirements: async () => null,
			createConfigRequest: async () => null,
			getStatus: async (name: string) => ({
				pluginName: name,
				ready: false,
				missing: ["ANTHROPIC_API_KEY"],
			}),
			activate: async () => {
				throw new Error("must not be called when not ready");
			},
		};

		const { runtime, emitted } = createRuntime(client);

		const result = await activatePluginIfReadyAction.handler(
			runtime as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		const data = result.data as {
			activated: boolean;
			reason: string;
			missing: string[];
		};
		expect(data.activated).toBe(false);
		expect(data.reason).toBe("not_ready");
		expect(data.missing).toEqual(["ANTHROPIC_API_KEY"]);
		expect(emitted).toHaveLength(0);
	});
});

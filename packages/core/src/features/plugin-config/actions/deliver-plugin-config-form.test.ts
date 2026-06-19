import { describe, expect, test } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { deliverPluginConfigFormAction } from "./deliver-plugin-config-form";

function createRuntime(
	client: unknown,
	registry: unknown,
): Record<string, unknown> {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === "PluginConfigClient") return client;
			if (name === "SensitiveRequestDispatchRegistry") return registry;
			return null;
		},
	};
}

function createMessage() {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "", channelType: ChannelType.DM },
	};
}

describe("DELIVER_PLUGIN_CONFIG_FORM", () => {
	test("dispatches one sensitive-request per missing required key", async () => {
		const requested: string[] = [];
		const delivered: string[] = [];

		const client = {
			getRequirements: async (name: string) => ({
				pluginName: name,
				required: ["A", "B"],
				optional: [],
				present: [],
				missing: ["A", "B"],
			}),
			createConfigRequest: async (input: { key: string }) => {
				requested.push(input.key);
				return {
					id: `req-${input.key}`,
					kind: "secret",
					expiresAt: Date.now() + 60_000,
				};
			},
			getStatus: async () => null,
			activate: async () => false,
		};

		const registry = {
			get: (target: string) => ({
				target,
				deliver: async ({ request }: { request: { id: string } }) => {
					delivered.push(request.id);
					return { delivered: true, target };
				},
			}),
		};

		const result = await deliverPluginConfigFormAction.handler(
			createRuntime(client, registry) as never,
			createMessage() as never,
			undefined,
			{
				parameters: {
					pluginName: "anthropic",
					target: "dm",
				},
			} as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		expect(requested).toEqual(["A", "B"]);
		expect(delivered).toEqual(["req-A", "req-B"]);
		const data = result.data as {
			entries: Array<{ key: string; delivered: boolean }>;
		};
		expect(data.entries).toHaveLength(2);
		expect(data.entries.every((e) => e.delivered)).toBe(true);
	});

	test("fails when no delivery adapter is registered for the target", async () => {
		const client = {
			getRequirements: async (name: string) => ({
				pluginName: name,
				required: ["A"],
				optional: [],
				present: [],
				missing: ["A"],
			}),
			createConfigRequest: async () => ({
				id: "req-A",
				kind: "secret",
			}),
			getStatus: async () => null,
			activate: async () => false,
		};
		const registry = { get: () => undefined };

		const result = await deliverPluginConfigFormAction.handler(
			createRuntime(client, registry) as never,
			createMessage() as never,
			undefined,
			{
				parameters: {
					pluginName: "anthropic",
					target: "dm",
				},
			} as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("No delivery adapter");
	});
});

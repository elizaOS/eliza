import { describe, expect, test } from "vitest";
import { pluginConfigurationCompletenessProvider } from "./plugin-configuration-completeness";

const message = {
	entityId: "user-1",
	roomId: "room-1",
	content: { text: "" },
};

describe("PLUGIN_CONFIGURATION_COMPLETENESS provider", () => {
	test("reports per-plugin readiness from the client", async () => {
		const statuses: Record<
			string,
			{ ready: boolean; missing: string[] } | null
		> = {
			anthropic: { ready: true, missing: [] },
			discord: { ready: false, missing: ["DISCORD_BOT_TOKEN"] },
			"no-manifest": null,
		};
		const client = {
			getRequirements: async () => null,
			createConfigRequest: async () => null,
			getStatus: async (name: string) => {
				const entry = statuses[name];
				return entry ? { pluginName: name, ...entry } : null;
			},
			activate: async () => false,
		};
		const runtime = {
			agentId: "agent-1",
			plugins: [
				{ name: "anthropic", description: "" },
				{ name: "discord", description: "" },
				{ name: "no-manifest", description: "" },
			],
			getService: (name: string) =>
				name === "PluginConfigClient" ? client : null,
		};

		const result = await pluginConfigurationCompletenessProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);

		const data = result.data as {
			plugins: Array<{ name: string; ready: boolean; missing: string[] }>;
		};
		expect(data.plugins).toHaveLength(2);
		expect(data.plugins[0]).toEqual({
			name: "anthropic",
			ready: true,
			missing: [],
		});
		expect(data.plugins[1]).toEqual({
			name: "discord",
			ready: false,
			missing: ["DISCORD_BOT_TOKEN"],
		});
	});

	test("returns empty list when client service is absent", async () => {
		const runtime = {
			agentId: "agent-1",
			plugins: [{ name: "anthropic", description: "" }],
			getService: () => null,
		};
		const result = await pluginConfigurationCompletenessProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);
		const data = result.data as { plugins: unknown[] };
		expect(data.plugins).toEqual([]);
		expect(result.text).toBe("");
	});
});

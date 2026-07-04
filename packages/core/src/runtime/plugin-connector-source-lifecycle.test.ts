/**
 * Checks that a plugin's `connectorSources` declarations register their aliases
 * and passive flag on plugin load and are fully removed on unload. Drives a real
 * in-process `AgentRuntime`; no model or database.
 */
import { describe, expect, it } from "vitest";
import {
	getConnectorSourceAliases,
	isPassiveConnectorSource,
	normalizeConnectorSource,
} from "../connectors";
import { AgentRuntime } from "../runtime";
import type { Plugin } from "../types/plugin";

describe("plugin connector source lifecycle", () => {
	it("registers and unloads plugin-owned connector source declarations", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const plugin: Plugin = {
			name: "connector-source-owner",
			description: "Declares connector source aliases",
			connectorSources: [
				{
					source: "owned-source",
					aliases: ["owned-source", "owned-source-account"],
					sourceKind: "passive",
					isPassive: true,
				},
			],
		};

		expect(normalizeConnectorSource("owned-source-account")).toBe(
			"owned-source-account",
		);

		await runtime.registerPlugin(plugin);

		expect(normalizeConnectorSource("owned-source-account")).toBe(
			"owned-source",
		);
		expect(getConnectorSourceAliases("owned-source")).toEqual([
			"owned-source",
			"owned-source-account",
		]);
		expect(isPassiveConnectorSource("owned-source-account")).toBe(true);

		await runtime.unloadPlugin("connector-source-owner");

		expect(normalizeConnectorSource("owned-source-account")).toBe(
			"owned-source-account",
		);
		expect(isPassiveConnectorSource("owned-source-account")).toBe(false);
	});
});

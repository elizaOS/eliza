/**
 * Checks that plugin-owned shortcuts register into the shortcut registry, are
 * tracked under plugin ownership, and are unregistered on unload. Drives a real
 * in-process `AgentRuntime`; no model or database.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Plugin } from "../types/plugin";

describe("plugin shortcut lifecycle", () => {
	it("tracks plugin-owned shortcuts and unregisters them on unload", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const plugin: Plugin = {
			name: "shortcut-owner",
			description: "Registers an owned shortcut",
			shortcuts: [
				{
					id: "shortcut-owner:open",
					kind: "explicit",
					aliases: ["/owned"],
					target: { kind: "action", name: "OWNED_ACTION" },
				},
			],
		};

		await runtime.registerPlugin(plugin);

		expect(runtime.shortcutRegistry.match("/owned")?.shortcut.id).toBe(
			"shortcut-owner:open",
		);
		expect(runtime.getPluginOwnership("shortcut-owner")?.shortcuts).toEqual([
			"shortcut-owner:open",
		]);

		await runtime.unloadPlugin("shortcut-owner");

		expect(runtime.shortcutRegistry.match("/owned")).toBeNull();
	});
});

/**
 * Verifies concurrent plugin route ownership and teardown through a real
 * in-process `AgentRuntime.initialize()` registration path. No model or
 * external database is used.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character, Plugin } from "../types";

describe("plugin route lifecycle", () => {
	it("keeps a concurrently registered plugin's routes when unloading a slow plugin", async () => {
		const pluginA: Plugin = {
			name: "plugin-a",
			description: "Registers one route after asynchronous initialization",
			init: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
			},
			routes: [
				{
					type: "GET",
					path: "/a",
					public: false,
					handler: async () => {},
				} as never,
			],
		};
		const pluginB: Plugin = {
			name: "plugin-b",
			description: "Registers one route without asynchronous initialization",
			routes: [
				{
					type: "GET",
					path: "/b",
					public: false,
					handler: async () => {},
				} as never,
			],
		};
		const runtime = new AgentRuntime({
			character: { name: "Route ownership" } as Character,
			plugins: [pluginA, pluginB],
			logLevel: "fatal",
		});

		await runtime.initialize({ allowNoDatabase: true });

		expect(
			runtime.getPluginOwnership("plugin-a")?.routes.map((route) => route.path),
		).toEqual(["/plugin-a/a"]);
		expect(
			runtime.getPluginOwnership("plugin-b")?.routes.map((route) => route.path),
		).toEqual(["/plugin-b/b"]);

		await runtime.unloadPlugin("plugin-a");

		expect(runtime.routes.map((route) => route.path)).toContain("/plugin-b/b");
	});
});
